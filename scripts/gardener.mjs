#!/usr/bin/env node
/**
 * gardener — talimat dosyalarının bağlam hijyeni.
 *
 * `CLAUDE.md` / `AGENTS.md` ve import ettikleri her şey, ajanın **her istekte** yüklediği
 * metindir. Oradaki her satırın bedeli tekrar tekrar ödenir; bakımı yapılmayan bir talimat
 * dosyası deponun en pahalı metnidir.
 *
 * Üç soru:
 *   1. --audit       ne yükleniyor, kaça mal oluyor, nesi bozuk?
 *   2. --compliance  kurallar gerçekten uygulanıyor mu, hangileri ölü ağırlık?
 *   3. --prune       ne çıkarılabilir — satır satır gerekçesiyle
 *
 * TASARIM İLKESİ: Ağ çağrısı yok, kota harcanmaz, DOSYA YAZILMAZ. Plan üretir;
 * talimat dosyana ne gireceğine sen karar verirsin.
 *
 * Kullanım:
 *   node gardener.mjs --audit [--repo .] [--md]
 *   node gardener.mjs --compliance [--repo .] [--days 90] [--md]
 *   node gardener.mjs --prune [--repo .] [--md]
 *   node gardener.mjs --selftest
 *
 * Bayraklar: --agent all|claude-code|codex|gemini-cli · --lang tr|en
 *            --out DOSYA · --limit N · --ignore kural1,kural2
 * Gereksinim: Node.js 18+. Bağımlılık yok.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";

import { listAllSessions, getAdapter } from "./lib/adapters.mjs";
import { hotSet, collectDirectives, estimateTokens } from "./lib/context.mjs";
import { checkFiles, checkDirectives, findDuplicates, checkCompliance, score, selftest, BUDGET } from "./lib/checks.mjs";
import { renderFindings, severityLabel, levelLabel, normalizeLang, DEFAULT_LANG } from "./lib/i18n.mjs";

// ---------- argümanlar ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, fb = null) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fb; };
const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);

/**
 * Tanınan bayraklar. Bilinmeyen bayrak sessizce yutulmaz: CI'da bir yazım hatası
 * ("--audt") aksi halde exit 0 verip "denetim geçti" gibi görünür — sessiz yeşil,
 * bu aracın tam olarak uyardığı hata sınıfı.
 */
const BOOL_FLAGS = new Set(["--audit", "--compliance", "--prune", "--selftest", "--md", "--help", "-h"]);
const VALUE_FLAGS = new Set(["--repo", "--agent", "--days", "--limit", "--lang", "--out", "--ignore"]);

function validateArgs() {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;              // değer konumu, atla
    if (BOOL_FLAGS.has(a)) continue;
    if (VALUE_FLAGS.has(a)) { i++; continue; }     // kendi değerini tüketir
    unknown.push(a);
  }
  return unknown;
}

const REPO = opt("--repo", ".");
const AGENT = opt("--agent", "all");
const DAYS = parseInt(opt("--days", "0"), 10) || 0;
const LIMIT = Math.max(1, parseInt(opt("--limit", "40"), 10) || 40);
// Varsayılan İngilizce: araç İngilizce konuşan bir kitleye çıkıyor. Türkçe `--lang tr` ile.
const LANG = normalizeLang(opt("--lang", DEFAULT_LANG));
const OUT = opt("--out");
const IGNORE = list(opt("--ignore"));
const MD = flag("--md");

const tr = LANG === "tr";
const t = (a, b) => (tr ? a : b);
const SEV = { error: severityLabel("error", LANG), warn: severityLabel("warn", LANG), info: severityLabel("info", LANG) };
const LEVEL = { poor: levelLabel("poor", LANG), fair: levelLabel("fair", LANG), good: levelLabel("good", LANG), clean: levelLabel("clean", LANG) };

// ---------- yardımcılar ----------
const outDir = () => resolve(homedir(), ".agentlens", "gardener");

function emit(obj, md) {
  const text = MD ? md : JSON.stringify(obj, null, 2);
  if (OUT) {
    const target = resolve(OUT);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
    process.stdout.write(`${t("yazıldı", "written")}: ${target}\n`);
  } else {
    process.stdout.write(text + "\n");
  }
}

const short = (s, n = 70) => {
  const x = String(s ?? "").replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n) + "…" : x;
};
const cell = (s, n = 80) => short(s, n).replace(/\|/g, "\\|");
const rel = (f) => (f ? String(f).replace(homedir(), "~") : "—");
const at = (f, line) => `${basename(String(f || ""))}${line ? ":" + line : ""}`;

function load() {
  const hot = hotSet({ repo: REPO, agent: AGENT });
  const directives = collectDirectives(hot);
  return { hot, directives };
}

function sessions() {
  const metas = listAllSessions({ agent: "all", days: DAYS });
  const out = [];
  let unreadable = 0;
  for (const m of metas) {
    let s;
    try { s = getAdapter(m.agent).loadSession(m.file); } catch { unreadable++; continue; }
    s.project = s.cwd ? basename(s.cwd) : null;
    out.push(s);
  }
  return { sessions: out, unreadable };
}

const sourceLine = (hot, directives) =>
  `${hot.totals.files} ${t("dosya", "files")} · ${hot.totals.lines} ${t("satır", "lines")} · ~${hot.totals.tokens} ${t("tahmini token, her istekte", "estimated tokens, per request")} · ${directives.length} ${t("direktif", "directives")}`;

// ---------- komut: --audit ----------

function cmdAudit() {
  const { hot, directives } = load();
  const findings = renderFindings([
    ...checkFiles(hot, { ignore: IGNORE }),
    ...checkDirectives(directives, { repo: REPO, ignore: IGNORE }),
    ...findDuplicates(directives, { ignore: IGNORE }),
  ], LANG);
  const s = score(findings);
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);

  const md = [
    `# gardener — ${t("sıcak bağlam denetimi", "hot context audit")}`, "",
    `**${t("Kaynak notu", "Source note")}:** ${sourceLine(hot, directives)} · **${t("puan", "score")}:** ${s.raw} (${LEVEL[s.level]})`,
    "",
    `> ${t(
      `Sıcak bağlam, ajanın **her istekte** yüklediği metindir. Bütçe eşikleri: dosya başına ${BUDGET.fileWarn}/${BUDGET.fileError} satır, toplam ${BUDGET.totalWarn}/${BUDGET.totalError} tahmini token. Token sayısı gerçek tokenizer'dan değil, bayt/4 kestiriminden gelir.`,
      `Hot context is what the agent loads on **every request**. Budgets: ${BUDGET.fileWarn}/${BUDGET.fileError} lines per file, ${BUDGET.totalWarn}/${BUDGET.totalError} estimated tokens in total. Token counts are a bytes/4 estimate, not a real tokenizer.`
    )}`,
    "",
    `## ${t("Ne yükleniyor", "What loads")}`, "",
    `| ${t("Dosya", "File")} | ${t("kapsam", "scope")} | ${t("derinlik", "depth")} | ${t("satır", "lines")} | ~${t("token", "tokens")} |`,
    "|---|---|---|---|---|",
    ...hot.files.map((f) => `| \`${cell(rel(f.file), 58)}\`${f.missing ? " ⚠" : ""} | ${f.scope} | ${f.depth} | ${f.lines} | ${f.tokens} |`),
    `| **${t("toplam", "total")}** | | | **${hot.totals.lines}** | **${hot.totals.tokens}** |`,
    "",
    `## ${t("Bulgular", "Findings")}`, "",
    ...(sorted.length ? [
      `| ${t("Önem", "Sev")} | ${t("Kural", "Check")} | ${t("nerede", "where")} | ${t("ne", "what")} |`, "|---|---|---|---|",
      ...sorted.slice(0, LIMIT).map((f) => `| ${SEV[f.severity]} | ${f.check} | ${f.file ? at(f.file, f.line) : "—"} | ${cell(f.detail, 60)} |`),
      "",
      ...[...new Map(sorted.map((f) => [f.check, f])).values()].map((f) => `- **${f.check}** (${SEV[f.severity]}) — ${f.why} → *${f.fix}*`),
    ] : [t("Bulgu yok.", "No findings.")]),
    "",
    ...(findings.some((f) => f.check === "duplicate-directive") ? [
      `## ${t("Yinelenen talimatlar", "Duplicated instructions")}`, "",
      ...findings.filter((f) => f.check === "duplicate-directive").slice(0, 10).flatMap((d) => [
        `- ${d.detail} — \`${at(d.file, d.line)}\` ⟷ \`${at(d.otherFile, d.otherLine)}\``,
        `  - ${cell(d.text, 96)}`,
        `  - ${cell(d.otherText, 96)}`,
      ]),
      "",
    ] : []),
  ].join("\n");

  emit({
    kind: "audit", generatedAt: new Date().toISOString(),
    repo: hot.repo, totals: hot.totals, budget: BUDGET,
    files: hot.files.map(({ text, ...f }) => f),
    score: s, findings,
  }, md);
}

// ---------- komut: --compliance ----------

function cmdCompliance() {
  const { hot, directives } = load();
  const { sessions: sess, unreadable } = sessions();
  const findings = renderFindings(checkCompliance(directives, sess, { ignore: IGNORE }), LANG);
  const violations = findings.filter((f) => f.check === "prohibition-seen");
  const dead = findings.filter((f) => f.check === "dead-directive");

  const md = [
    `# gardener — ${t("kurallar uygulanıyor mu?", "are the rules followed?")}`, "",
    `**${t("Kaynak notu", "Source note")}:** ${sourceLine(hot, directives)}`,
    `${sess.length} ${t("oturum tarandı", "sessions scanned")}${DAYS ? ` (${DAYS}${t("g", "d")})` : ""}${unreadable ? ` · ${unreadable} ${t("okunamadı", "unreadable")}` : ""}`,
    "",
    `> ${t(
      "Bu bölüm **aday** üretir, kanıt değil. Bir yasağın öznesi gerçek bir komutta geçiyorsa ihlal olabilir de olmayabilir de — kural bir konumu ya da bağlamı yasaklıyor olabilir. Her satır açılıp doğrulanmalı.",
      "This produces **candidates**, not proof. A prohibition's subject appearing in a real command may or may not be a violation — the rule might forbid a location or a context. Every row needs opening and checking."
    )}`,
    "",
    `## ${t("İhlal adayları", "Violation candidates")}`, "",
    ...(violations.length ? violations.flatMap((v) => [
      `### \`${at(v.file, v.line)}\` — ${v.detail}`,
      "",
      `> ${cell(v.text, 150)}`,
      "",
      `| ${t("proje", "project")} | ${t("komut", "command")} |`, "|---|---|",
      ...v.examples.map((e) => `| ${e.project || "—"} | \`${cell(e.cmd, 90)}\` |`),
      "",
    ]) : [t("Yasak öznesi hiçbir gerçek komutta geçmiyor.", "No prohibition subject appears in any real command."), ""]),
    `## ${t("Ölü ağırlık", "Dead weight")}`, "",
    `${t(
      "Konusu hiçbir oturumda geçmeyen kurallar. Bedeli her istekte ödeniyor, karşılığı görünmüyor — ama önce \"bu iş hiç yapılmadı mı, yoksa kural yüzünden mi yapılmadı\" diye sor.",
      "Rules whose subject never appears in any session. The cost is paid on every request; but first ask whether the work simply never came up, or never came up because of the rule."
    )}`, "",
    ...(dead.length ? [
      `| ${t("nerede", "where")} | ${t("özne", "subject")} | ${t("talimat", "instruction")} |`, "|---|---|---|",
      ...dead.slice(0, LIMIT).map((d) => `| ${at(d.file, d.line)} | ${cell(d.detail, 34)} | ${cell(d.text, 64)} |`),
    ] : [t("Yok — her kuralın konusu en az bir kez ortaya çıkmış.", "None — every rule's subject came up at least once.")]),
    "",
  ].join("\n");

  emit({
    kind: "compliance", generatedAt: new Date().toISOString(),
    repo: hot.repo, sessionsScanned: sess.length, unreadable,
    violations, dead,
  }, md);
}

// ---------- komut: --prune ----------

const ACTION = {
  "stale-path": { act: "fix", why: t("atıf ettiği dosya yok", "the file it points at is gone") },
  "duplicate-directive": { act: "cut", why: t("aynı talimat başka bir dosyada da var", "the same instruction exists in another file") },
  "vague-directive": { act: "rewrite", why: t("uygulanıp uygulanmadığı ölçülemez", "compliance cannot be read off it") },
  "dead-directive": { act: "move", why: t("konusu hiç ortaya çıkmıyor", "its subject never comes up") },
  "prohibition-seen": { act: "enforce", why: t("yazılmış ama tutmuyor", "written but not holding") },
};

function cmdPrune() {
  const { hot, directives } = load();
  const { sessions: sess } = sessions();
  const findings = renderFindings([
    ...checkDirectives(directives, { repo: REPO, ignore: IGNORE }),
    ...findDuplicates(directives, { ignore: IGNORE }),
    ...checkCompliance(directives, sess, { ignore: IGNORE }),
  ], LANG);

  // Direktif başına topla: bir satır birden çok gerekçeyle işaretlenmiş olabilir.
  const byLine = new Map();
  for (const f of findings) {
    if (!f.file || !f.line) continue;
    const key = `${f.file}::${f.line}`;
    const g = byLine.get(key) || { file: f.file, line: f.line, text: f.text || "", reasons: [], actions: new Set() };
    const a = ACTION[f.check];
    g.reasons.push({ check: f.check, detail: f.detail, why: a ? a.why : f.why });
    if (a) g.actions.add(a.act);
    if (!g.text && f.text) g.text = f.text;
    byLine.set(key, g);
  }

  const plan = [...byLine.values()]
    .map((g) => ({ ...g, actions: [...g.actions], weight: g.reasons.length }))
    .sort((a, b) => b.weight - a.weight || String(a.file).localeCompare(String(b.file)) || a.line - b.line);

  const biggest = [...hot.files].filter((f) => !f.missing).sort((a, b) => b.tokens - a.tokens)[0];
  const cutLines = plan.filter((p) => p.actions.includes("cut") || p.actions.includes("move")).length;

  const md = [
    `# gardener — ${t("budama planı", "prune plan")}`, "",
    `**${t("Kaynak notu", "Source note")}:** ${sourceLine(hot, directives)}`,
    `${plan.length} ${t("direktif işaretlendi", "directives flagged")} · ${cutLines} ${t("çıkarılabilir görünüyor", "look removable")}`,
    "",
    `> ${t(
      "Bu bir plandır, düzenleme değil. Hiçbir dosya yazılmaz. Her satırın gerekçesi yanında; katılmadığın gerekçeyi atla.",
      "This is a plan, not an edit. No file is written. Every row carries its reason; skip the ones you disagree with."
    )}`,
    "",
    ...(biggest ? [
      `## ${t("En pahalı dosya", "Most expensive file")}`, "",
      `\`${rel(biggest.file)}\` — ${biggest.lines} ${t("satır", "lines")}, ~${biggest.tokens} ${t("tahmini token", "estimated tokens")}, ` +
      `${t("sıcak bütçenin", "of the hot budget")} %${Math.round((biggest.tokens / Math.max(1, hot.totals.tokens)) * 100)}.`,
      "",
      `${t("Buradan başla: hangi bölüm gerçekten her istekte gerekli? Gerisi talep üzerine okunan bir dosyaya ya da bir skill'e taşınabilir.", "Start here: which section is genuinely needed on every request? The rest can move to an on-demand file or a skill.")}`,
      "",
    ] : []),
    `## ${t("İşaretlenen satırlar", "Flagged lines")}`, "",
    ...(plan.length ? [
      `| ${t("nerede", "where")} | ${t("eylem", "action")} | ${t("gerekçe", "reason")} | ${t("talimat", "instruction")} |`,
      "|---|---|---|---|",
      ...plan.slice(0, LIMIT).map((p) =>
        `| ${at(p.file, p.line)} | ${p.actions.join(", ") || "—"} | ${cell(p.reasons.map((r) => r.check).join(", "), 40)} | ${cell(p.text, 58)} |`),
      plan.length > LIMIT ? `| … | | | ${plan.length - LIMIT} ${t("satır daha", "more lines")} |` : null,
    ].filter(Boolean) : [t("İşaretlenecek bir şey yok.", "Nothing to flag.")]),
    "",
    `## ${t("Eylemler ne demek", "What the actions mean")}`, "",
    `- **cut** — ${t("satırı kaldır; talimat başka bir yerde zaten duruyor", "remove the line; the instruction already lives elsewhere")}`,
    `- **move** — ${t("sıcak bağlamdan çıkar, talep üzerine okunan bir dosyaya al", "take it out of the hot context, into an on-demand file")}`,
    `- **fix** — ${t("atıf kırık; yolu güncelle", "the reference is broken; update the path")}`,
    `- **rewrite** — ${t("somut bir eyleme çevir", "turn it into a concrete action")}`,
    `- **enforce** — ${t("metin yetmiyor; hook, lint ya da izin kuralı gerekiyor", "text is not enough; needs a hook, a lint rule or a permission entry")}`,
    "",
  ].join("\n");

  emit({ kind: "prune", generatedAt: new Date().toISOString(), repo: hot.repo, totals: hot.totals, biggest: biggest ? { file: biggest.file, lines: biggest.lines, tokens: biggest.tokens } : null, plan }, md);
}

// ---------- giriş ----------

function main() {
  const unknown = validateArgs();
  if (unknown.length) {
    process.stderr.write(
      `${t("bilinmeyen bayrak", "unknown flag")}: ${unknown.join(", ")}\n\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }
  if (flag("--help") || flag("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (flag("--selftest")) {
    const r = selftest();
    process.stdout.write(`${t("öz-test", "selftest")}: ${r.total - r.fails.length}/${r.total}\n`);
    if (r.fails.length) { process.stdout.write(r.fails.join("\n") + "\n"); process.exitCode = 1; }
    return;
  }
  if (flag("--audit")) return cmdAudit();
  if (flag("--compliance")) return cmdCompliance();
  if (flag("--prune")) return cmdPrune();

  process.stdout.write(usage());
}

function usage() {
  return [
    t("gardener — talimat dosyalarının bağlam hijyeni", "gardener — context hygiene for agent instruction files"),
    "",
    t("  --audit [--repo .]           ne yükleniyor, kaça mal oluyor, nesi bozuk",
      "  --audit [--repo .]           what loads, what it costs, what is broken"),
    t("  --compliance [--days N]      kurallar uygulanıyor mu, hangileri ölü ağırlık",
      "  --compliance [--days N]      are the rules followed, which are dead weight"),
    t("  --prune [--repo .]           ne çıkarılabilir — satır satır gerekçesiyle",
      "  --prune [--repo .]           what can go — line by line, with reasons"),
    t("  --selftest                   kural öz-testi (ağ/disk yok)",
      "  --selftest                   rule self-test (no network, no disk)"),
    "",
    "  --agent all|claude-code|codex|gemini-cli · --md · --lang en|tr",
    t("  --out DOSYA · --limit N · --ignore kural1,kural2",
      "  --out FILE · --limit N · --ignore check1,check2"),
    "",
    `${t("bütçe", "budget")}: ${BUDGET.fileWarn}/${BUDGET.fileError} ${t("satır/dosya", "lines/file")} · ${BUDGET.totalWarn}/${BUDGET.totalError} ${t("tahmini token", "estimated tokens")}`,
    `${t("çıktı dizini önerisi", "suggested output dir")}: ${outDir()}`,
    "",
  ].join("\n");
}

main();
