/**
 * gardener — sıcak bağlam denetimleri ve uyum ölçümü
 *
 * Her bulgu şeffaftır: hangi dosyanın hangi satırının neden işaretlendiğini söyler.
 * `--ignore <id>` ile herhangi biri kapatılabilir.
 *
 * Önem: error = ölçülebilir ve pahalı · warn = bakım borcu · info = insan kararı gerekir
 */

import { resolveSubjectPath } from "./context.mjs";
import { MESSAGE_KEYS, renderFinding } from "./i18n.mjs";

const SEV_WEIGHT = { error: 10, warn: 4, info: 1 };

/** Her istekte ödenen bedel için eşikler. Tahmini token üzerinden. */
export const BUDGET = { fileWarn: 300, fileError: 600, totalWarn: 4000, totalError: 8000 };

// ---------- dosya düzeyi denetimler ----------

export function checkFiles(hot, { ignore = [] } = {}) {
  const out = [];
  const add = (f) => { if (!ignore.includes(f.check)) out.push(f); };

  for (const f of hot.files) {
    if (f.missing) {
      add({
        check: "broken-import", severity: "error", file: f.file, line: null,
        vars: { depth: f.depth },
      });
      continue;
    }
    if (f.lines > BUDGET.fileError) {
      add({
        check: "hot-file-oversized", severity: "error", file: f.file, line: null,
        vars: { lines: f.lines, tokens: f.tokens },
      });
    } else if (f.lines > BUDGET.fileWarn) {
      add({
        check: "hot-file-large", severity: "warn", file: f.file, line: null,
        vars: { lines: f.lines, tokens: f.tokens },
      });
    }
  }

  const tot = hot.totals.tokens;
  if (tot > BUDGET.totalError) {
    add({
      check: "hot-budget-exceeded", severity: "error", file: null, line: null,
      vars: { files: hot.totals.files, lines: hot.totals.lines, tokens: tot },
    });
  } else if (tot > BUDGET.totalWarn) {
    add({
      check: "hot-budget-high", severity: "warn", file: null, line: null,
      vars: { tokens: tot },
    });
  }
  return out;
}

// ---------- direktif düzeyi denetimler ----------

const VAGUE_RE = /\b(?:dikkatli ol|özen göster|mümkünse|gerekirse|uygun şekilde|iyi bir şekilde|be careful|as needed|appropriately|if possible|make sure it'?s good|properly)\b/i;

export function checkDirectives(directives, { repo = null, ignore = [] } = {}) {
  const out = [];
  const add = (f) => { if (!ignore.includes(f.check)) out.push(f); };

  for (const d of directives) {
    // bayat yol atfı
    for (const s of d.subjects) {
      if (s.kind !== "path") continue;
      if (/[<>*?]/.test(s.token)) continue;               // şablon yolu, gerçek değil
      const r = resolveSubjectPath(d.file, s.token, repo);
      if (r && !r.exists) {
        add({
          check: "stale-path", severity: "warn", file: d.file, line: d.line,
          vars: { token: s.token },
          text: d.text,
        });
      }
    }

    // belirsiz emir
    if (d.imperative && VAGUE_RE.test(d.text) && !d.subjects.length) {
      add({
        check: "vague-directive", severity: "info", file: d.file, line: d.line,
        vars: { text: d.text.slice(0, 120) },
        text: d.text,
      });
    }
  }
  return out;
}

// ---------- yinelenen direktifler ----------

const STOP = new Set(`
bir bu şu ve veya ile için gibi olan olarak ise da de den dan çok az en her hangi ne
the and for with that this from into your you not are was but all any can has had
`.trim().split(/\s+/));

const tokenize = (s) => String(s || "").toLowerCase()
  .replace(/[^\p{L}\p{N}/._-]+/gu, " ")
  .split(" ")
  .filter((t) => t.length > 2 && !STOP.has(t));

/** Farklı dosyalardaki direktifler arasında idf ağırlıklı örtüşme. */
export function findDuplicates(directives, { threshold = 0.55, ignore = [] } = {}) {
  if (ignore.includes("duplicate-directive")) return [];
  const docs = directives.map((d) => ({ d, tf: count(tokenize(d.text)) })).filter((x) => x.tf.size >= 3);
  const df = new Map();
  for (const x of docs) for (const t of x.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const vecs = docs.map((x) => {
    const v = new Map();
    let norm = 0;
    for (const [t, n] of x.tf) { const w = (1 + Math.log(n)) * idf(t); v.set(t, w); norm += w * w; }
    return { d: x.d, v, norm: Math.sqrt(norm) || 1 };
  });

  const out = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const a = vecs[i], b = vecs[j];
      if (a.d.file === b.d.file && Math.abs(a.d.line - b.d.line) < 3) continue;
      let dot = 0;
      for (const [t, w] of a.v) { const w2 = b.v.get(t); if (w2) dot += w * w2; }
      const score = dot / (a.norm * b.norm);
      if (score < threshold) continue;
      out.push({
        check: "duplicate-directive", severity: a.d.file === b.d.file ? "info" : "warn",
        score: Math.round(score * 100) / 100,
        file: a.d.file, line: a.d.line, text: a.d.text,
        otherFile: b.d.file, otherLine: b.d.line, otherText: b.d.text,
        vars: { pct: Math.round(score * 100) },
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function count(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// ---------- uyum: kural gerçekten uygulanıyor mu ----------

/** Komut gibi görünen özne: boşluk içeriyor ya da bilinen bir CLI adıyla başlıyor. */
const CLI_HEADS = /^(?:git|npm|npx|pnpm|yarn|node|dotnet|docker|kubectl|python|pip|uv|uvx|gh|cargo|make|terraform|az|aws|rm|del|curl|wget|chmod|sudo|reset|push|commit)\b/i;

/**
 * Komut gibi görünen özne. Yapılandırma anahtarları (`trusted: false`, `mode=strict`)
 * boşluk içerse de komut değildir; onları uyum denetimine sokmak gerçek komutlarda
 * geçtikleri her yeri sahte ihlal yapar.
 */
export const isCommandSubject = (tok) => {
  const t = String(tok || "").trim();
  if (!t) return false;
  // Kod ifadesi, yapılandırma anahtarı ya da SQL parçası — komut değil.
  if (/[(){};=]|\bAS\b|^[A-Z_]{2,}\b/.test(t)) return false;
  const head = t.split(/\s+/)[0];
  if (/[:.]/.test(head)) return false;          // `window.PageContext.x`, `trusted:`
  if (CLI_HEADS.test(t)) return true;
  return t.includes(" ") && /^[a-z][a-z0-9_-]*$/.test(head);
};

/**
 * Komut öznesinden aranacak kararlı çekirdeği çıkarır.
 *
 * Talimatlar komutu çoğu zaman şablonla yazar: `claude plugin validate <repo> --strict`.
 * Bunu birebir aramak hep başarısız olur ve gerçekte her gün çalışan bir komutu "ölü"
 * gösterir. Bu yüzden ilk kararlı sözcükler alınır — yer tutucu, yol ya da anahtar
 * içeren ilk parçada durulur.
 */
export function commandNeedle(token) {
  const parts = String(token || "").toLowerCase().trim().split(/\s+/);
  const keep = [];
  for (const p of parts) {
    if (/[<>{}$]|[/\\]|^[a-z]:|=/.test(p)) break;
    keep.push(p);
    if (keep.length === 3) break;
  }
  const needle = keep.join(" ").trim();
  return needle.length >= 3 ? needle : null;
}

/**
 * Yasak direktifleri gerçek komutlarla karşılaştırır.
 *
 * DÜRÜSTLÜK NOTU: Bu bir **aday** üreticisidir, kanıt değil. "X yapma" kuralının öznesi
 * bir komutta geçiyorsa ihlal olabilir de olmayabilir de — kural bir konumu ya da bağlamı
 * yasaklıyor olabilir. Bu yüzden yalnızca komut benzeri özneler kontrol edilir ve bulgu
 * "doğrulanmalı" olarak işaretlenir.
 */
export function checkCompliance(directives, sessions, { ignore = [] } = {}) {
  const out = [];
  const commands = [];
  for (const s of sessions) {
    for (const ev of s.events) {
      if (ev.kind === "call" && ev.family === "shell" && ev.command) {
        commands.push({ cmd: ev.command, project: s.project, ts: ev.ts, agent: s.agent });
      }
    }
  }

  for (const d of directives) {
    const subjects = d.subjects.filter((s) => s.kind === "code" && isCommandSubject(s.token));
    if (!subjects.length) continue;

    for (const s of subjects) {
      const needle = commandNeedle(s.token);
      if (!needle) continue;
      const hits = commands.filter((c) => c.cmd.toLowerCase().includes(needle));

      if (d.prohibition && hits.length && !ignore.includes("prohibition-seen")) {
        out.push({
          check: "prohibition-seen", severity: "warn", file: d.file, line: d.line,
          vars: { token: s.token, hits: hits.length },
          text: d.text,
          verify: true,
          examples: hits.slice(0, 4).map((h) => ({ cmd: h.cmd.slice(0, 140), project: h.project, ts: h.ts })),
          occurrences: hits.length,
          projects: [...new Set(hits.map((h) => h.project).filter(Boolean))],
        });
      }

      if (!d.prohibition && !hits.length && !ignore.includes("dead-directive")) {
        out.push({
          check: "dead-directive", severity: "info", file: d.file, line: d.line,
          vars: { token: s.token },
          text: d.text,
          verify: true,
          occurrences: 0,
        });
      }
    }
  }
  return out;
}

/**
 * Puan. `level` anahtarı dilden bağımsızdır (`poor`/`fair`/`good`/`clean`);
 * görünen etiket `i18n.mjs`'teki `levelLabel()` ile üretilir. Anahtar makine sözleşmesidir:
 * CI eşiği buna bağlanabilsin diye çeviriyle değişmez.
 */
export function score(findings) {
  const raw = findings.reduce((n, f) => n + (SEV_WEIGHT[f.severity] || 0), 0);
  return { raw, level: raw >= 40 ? "poor" : raw >= 15 ? "fair" : raw > 0 ? "good" : "clean" };
}

// ---------- öz-test (ağ yok, disk yok) ----------

export function selftest() {
  const fails = [];
  const T = (name, fn) => {
    let ok = false;
    try { ok = fn(); } catch (e) { fails.push(`${name}: hata — ${e.message}`); return; }
    if (!ok) fails.push(`başarısız: ${name}`);
  };

  const hot = (files, tokens) => ({ files, totals: { files: files.length, lines: 0, bytes: 0, tokens, missing: 0 } });
  const f = (over = {}) => ({ file: "C:/p/CLAUDE.md", depth: 0, missing: false, lines: 100, tokens: 400, ...over });

  T("kırık import hata verir", () =>
    checkFiles(hot([f({ missing: true })], 0)).some((x) => x.check === "broken-import" && x.severity === "error"));
  T("çok büyük dosya hata verir", () =>
    checkFiles(hot([f({ lines: 700 })], 900)).some((x) => x.check === "hot-file-oversized"));
  T("büyük dosya uyarı verir", () =>
    checkFiles(hot([f({ lines: 400 })], 900)).some((x) => x.check === "hot-file-large"));
  T("normal dosya temiz", () =>
    !checkFiles(hot([f()], 500)).length);
  T("bütçe aşımı hata verir", () =>
    checkFiles(hot([f()], 9000)).some((x) => x.check === "hot-budget-exceeded"));
  T("ignore kuralı susturur", () =>
    !checkFiles(hot([f({ missing: true })], 0), { ignore: ["broken-import"] }).length);

  const dir = (over = {}) => ({
    file: "C:/p/CLAUDE.md", line: 3, kind: "bullet", heading: "H",
    text: "x", raw: "x", subjects: [], imperative: false, prohibition: false, ...over,
  });

  T("bayat yol uyarı verir", () =>
    checkDirectives([dir({ subjects: [{ token: "yok/olmayan-dosya-xyz.md", kind: "path" }] })])
      .some((x) => x.check === "stale-path"));
  T("şablon yolu bayat sayılmaz", () =>
    !checkDirectives([dir({ subjects: [{ token: "skills/<ad>/SKILL.md", kind: "path" }] })]).length);
  T("belirsiz emir bilgi verir", () =>
    checkDirectives([dir({ text: "Dosyaları silerken dikkatli ol", imperative: true })])
      .some((x) => x.check === "vague-directive"));

  const a = dir({ file: "A.md", text: "Tüm UI metinleri MessageService üzerinden gelmeli hardcoded metin olmamalı" });
  const b = dir({ file: "B.md", text: "Tüm UI metinleri MessageService üzerinden gelmeli hardcoded metin olmasın" });
  const c = dir({ file: "C.md", text: "Migration klasörleri sağlayıcı başına ayrı tutulur postgres ve mssql" });
  T("yinelenen direktif yakalanır", () =>
    findDuplicates([a, b, c]).some((x) => x.file === "A.md" && x.otherFile === "B.md"));
  T("alakasız direktif eşleşmez", () =>
    !findDuplicates([a, b, c]).some((x) => x.file === "C.md" || x.otherFile === "C.md"));

  const sess = [{
    id: "s", agent: "t", project: "p",
    events: [{ kind: "call", family: "shell", command: "git reset --hard HEAD~1", ts: "2026-01-01T00:00:00Z" }],
  }];
  const prohibit = dir({ text: "asla reset --hard kullanma", prohibition: true, subjects: [{ token: "reset --hard", kind: "code" }] });
  T("ihlal adayı yakalanır", () =>
    checkCompliance([prohibit], sess).some((x) => x.check === "prohibition-seen" && x.occurrences === 1));
  T("ihlal adayı doğrulama ister", () =>
    checkCompliance([prohibit], sess)[0].verify === true);

  const dead = dir({ text: "terraform plan çıktısını incele", subjects: [{ token: "terraform plan", kind: "code" }] });
  T("ölü direktif yakalanır", () =>
    checkCompliance([dead], sess).some((x) => x.check === "dead-directive"));
  T("komut olmayan özne uyum denetimine girmez", () =>
    !checkCompliance([dir({ subjects: [{ token: "MessageService", kind: "code" }] })], sess).length);
  T("şablonlu komut kararlı çekirdeğinden aranır", () =>
    commandNeedle("claude plugin validate <repo> --strict") === "claude plugin validate");
  T("yollu komut yolun öncesinde durur", () =>
    commandNeedle("claude plugin validate C:/x/y --strict") === "claude plugin validate");
  T("şablonlu komut ölü sayılmaz", () => {
    const s2 = [{ id: "s", agent: "t", project: "p", events: [
      { kind: "call", family: "shell", command: "claude plugin validate . --strict", ts: "2026-01-01T00:00:00Z" }] }];
    const d2 = dir({ text: "Commit öncesi kapı", subjects: [{ token: "claude plugin validate <repo> --strict", kind: "code" }] });
    return !checkCompliance([d2], s2).some((x) => x.check === "dead-directive");
  });

  T("puanlama ağırlıklı", () => score([{ severity: "error" }, { severity: "info" }]).raw === 11);
  T("puan seviyesi dilden bağımsız anahtar döndürür", () =>
    ["poor", "fair", "good", "clean"].includes(score([{ severity: "error" }]).level));

  // Dil kapısı: üretilen her check id'si katalogda karşılığı olmalı, yoksa rapor
  // o bulguda sessizce düzyazısız kalır. Çeviri eksiği testte patlasın, kullanıcıda değil.
  const EMITTED = [
    "broken-import", "hot-file-oversized", "hot-file-large", "hot-budget-exceeded",
    "hot-budget-high", "stale-path", "vague-directive", "duplicate-directive",
    "prohibition-seen", "dead-directive",
  ];
  T("her check id'si katalogda var", () => EMITTED.every((c) => MESSAGE_KEYS.includes(c)));
  T("katalogda fazladan id yok", () => MESSAGE_KEYS.every((c) => EMITTED.includes(c)));
  T("her mesaj iki dilde de dolu", () =>
    EMITTED.every((c) => ["en", "tr"].every((L) => {
      const r = renderFinding({ check: c, vars: { depth: 1, lines: 1, tokens: 1, files: 1, token: "x", hits: 1, pct: 1, text: "t" } }, L);
      return typeof r.why === "string" && r.why.length > 0
        && typeof r.fix === "string" && r.fix.length > 0
        && typeof r.detail === "string" && r.detail.length > 0;
    })));
  T("çeviri gerçekten dile göre değişir", () => {
    const f = { check: "duplicate-directive", vars: { pct: 86 } };
    return renderFinding(f, "en").fix !== renderFinding(f, "tr").fix
      && renderFinding(f, "en").detail === "86% overlap";
  });
  T("bilinmeyen dil İngilizceye düşer", () =>
    renderFinding({ check: "stale-path", vars: { token: "x" } }, "de").detail === "`x` not found");

  return { total: 25, fails };
}
