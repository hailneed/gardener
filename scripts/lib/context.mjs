/**
 * gardener — sıcak bağlam keşfi, import çözümü ve direktif ayrıştırma
 *
 * TASARIM İLKESİ: Ağ çağrısı yok, dosya yazılmaz. Sadece okur.
 *
 * "Sıcak bağlam", ajanın **her istekte** yüklediği metindir: global talimat dosyası,
 * projenin kendi talimat dosyası ve bunların `@yol` ile çektiği her şey. Buradaki her
 * satırın bedeli tek seferlik değil, oturum boyunca tekrar tekrar ödenir — bu yüzden
 * bakımı yapılmayan bir talimat dosyası deponun en pahalı metnidir.
 *
 * KAPSAM DIŞI: skill gövdeleri ve `references/` dosyaları. Onlar talep üzerine yüklenir,
 * her istekte değil — ölçümleri `skillbench`'in işidir.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

/** Ajan başına, her istekte yüklenen dosya adayları. */
export const GLOBAL_FILES = [
  { agent: "claude-code", path: join(HOME, ".claude", "CLAUDE.md") },
  { agent: "codex", path: join(HOME, ".codex", "AGENTS.md") },
  { agent: "gemini-cli", path: join(HOME, ".gemini", "GEMINI.md") },
];

export const PROJECT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", join(".claude", "CLAUDE.md")];

// ---------- token tahmini ----------

/**
 * Kaba ama dürüst bir tahmin: İngilizce/Türkçe düz metinde token başına ~4 bayt.
 * Gerçek tokenizer'a erişimimiz yok; bu yüzden çıktıda her zaman "tahmini" der.
 */
export const estimateTokens = (text) => Math.round(Buffer.byteLength(String(text || ""), "utf8") / 4);

// ---------- import çözümü ----------

const IMPORT_RE = /^@(\S.*)$/;

/**
 * `@yol` satırlarını özyinelemeli çözer. Göreli yollar, içeren dosyanın dizinine göre
 * çözülür. Döngü ve derinlik korumalıdır; çözülemeyen import kaybolmaz, `missing` olarak
 * raporlanır — sessizce atlamak "bu kural yükleniyor" yanılgısı yaratır.
 */
export function resolveImports(file, { depth = 0, seen = new Set(), out = [] } = {}) {
  const abs = resolve(file);
  if (depth > 6 || seen.has(abs.toLowerCase())) return out;
  seen.add(abs.toLowerCase());

  if (!existsSync(abs)) {
    out.push({ file: abs, depth, missing: true, text: "", lines: 0, bytes: 0, tokens: 0, imports: [] });
    return out;
  }

  let text = "";
  try { text = readFileSync(abs, "utf8"); } catch { /* okunamıyorsa boş sayılır */ }
  const imports = [];
  for (const raw of text.split("\n")) {
    const m = IMPORT_RE.exec(raw.trim());
    if (!m) continue;
    const target = m[1].trim();
    imports.push(isAbsolute(target) || /^[A-Za-z]:/.test(target) ? target : resolve(dirname(abs), target));
  }

  out.push({
    file: abs, depth, missing: false, text,
    lines: text.split("\n").length,
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: estimateTokens(text),
    imports,
  });

  for (const imp of imports) resolveImports(imp, { depth: depth + 1, seen, out });
  return out;
}

/** Bir proje için her istekte yüklenen dosya kümesi (global + proje + import'lar). */
export function hotSet({ repo = null, agent = "all" } = {}) {
  const files = [];
  const seen = new Set();

  for (const g of GLOBAL_FILES) {
    if (agent !== "all" && agent !== g.agent) continue;
    if (!existsSync(g.path)) continue;
    for (const f of resolveImports(g.path, { seen })) files.push({ ...f, agent: g.agent, scope: "global" });
  }

  if (repo) {
    const root = resolve(repo);
    for (const rel of PROJECT_FILES) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      const agentOf = basename(p).startsWith("AGENTS") ? "codex" : basename(p).startsWith("GEMINI") ? "gemini-cli" : "claude-code";
      if (agent !== "all" && agent !== agentOf) continue;
      for (const f of resolveImports(p, { seen })) files.push({ ...f, agent: agentOf, scope: "project" });
    }
  }

  const totals = files.reduce((a, f) => ({
    files: a.files + 1,
    lines: a.lines + f.lines,
    bytes: a.bytes + f.bytes,
    tokens: a.tokens + f.tokens,
    missing: a.missing + (f.missing ? 1 : 0),
  }), { files: 0, lines: 0, bytes: 0, tokens: 0, missing: 0 });

  return { repo: repo ? resolve(repo) : null, files, totals };
}

// ---------- direktif ayrıştırma ----------

const BULLET_RE = /^\s{0,6}(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Markdown biçimlendirmesini metinden arındırır (eşleştirme ve okunabilirlik için). */
const stripMd = (s) => String(s || "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
  .replace(/\s+/g, " ")
  .trim();

/**
 * Bir dosyayı direktiflere böler: madde imleri ve başlık altındaki emir cümleleri.
 * Kod blokları, tablolar, alıntılar ve import satırları direktif sayılmaz — onlar
 * referans veridir, talimat değil.
 */
export function parseDirectives(file, text) {
  const lines = String(text || "").split("\n");
  const out = [];
  const trail = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, "");

    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      trail.length = Math.max(0, level - 1);
      trail[level - 1] = stripMd(h[2]);
      continue;
    }

    if (!line.trim()) continue;
    if (IMPORT_RE.test(line.trim())) continue;
    if (/^\s*\|/.test(line)) continue;          // tablo satırı
    if (/^\s*>/.test(line)) continue;           // alıntı
    if (/^\s*(?:---|===|\*\*\*)\s*$/.test(line)) continue;

    const b = BULLET_RE.exec(line);
    const body = b ? b[1] : line.trim();
    const text2 = stripMd(body);
    if (text2.length < 12) continue;            // başlık kırıntısı, tek kelime vs.

    out.push({
      file,
      line: i + 1,
      kind: b ? "bullet" : "prose",
      heading: trail.filter(Boolean).join(" › "),
      text: text2.slice(0, 400),
      raw: body.slice(0, 400),
      subjects: extractSubjects(body),
      imperative: isImperative(text2),
      prohibition: prohibitionOf(text2),
    });
  }
  return out;
}

// ---------- özne çıkarımı ----------

/**
 * Yol sayılması için bir ayırıcı ve bir uzantı ZORUNLU. Çıplak dosya adı (`SKILL.md`,
 * `MEMORY.md`) çoğu zaman örnek olarak geçer, varlığını sınamak yanlış alarm üretir;
 * `/api/messages` gibi uzantısız dizgeler ise yol değil rotadır.
 */
const PATHISH = /^[.~]?[\w@.-]*[\\/][\w@./\\-]*\.[A-Za-z0-9]{1,8}$/;

/** Gerçek bir dosyaya değil, bir kalıba işaret eden yollar. */
const PLACEHOLDER_PATH = /[<>*?{}]|(?:^|[A-Za-z/\\-])(?:Xxx|Yyy)(?:[A-Z]|\b)|\b(?:xxx|yyy|foo|baz|ornek|example|sample|placeholder)\b/i;

/**
 * Direktifin neden bahsettiği: ters tırnak içindeki tanımlayıcılar ve yol benzeri
 * dizgeler. Serbest metinden kelime çıkarmıyoruz — gürültüsü faydasından fazla.
 */
export function extractSubjects(raw) {
  const out = [];
  for (const m of String(raw || "").matchAll(/`([^`\n]{2,80})`/g)) {
    const tok = m[1].trim();
    if (!tok) continue;
    out.push({ token: tok, kind: PATHISH.test(tok) ? "path" : "code" });
  }
  return out;
}

const IMPERATIVE_RE = /\b(?:must|should|always|never|do not|don'?t|use|run|write|keep|avoid|prefer|ensure|make sure)\b/i;
const IMPERATIVE_TR = /\b(?:asla|daima|her zaman|mutlaka|kullan|çalıştır|yaz|ekle|sil|dokunma|yapma|kullanma|atma|önce|sonra|gerekir|olmalı|olmaz|zorunlu)\b/i;

export function isImperative(text) {
  return IMPERATIVE_RE.test(text) || IMPERATIVE_TR.test(text);
}

/**
 * Yasak kalıpları. Türkçede olumsuzluk eki morfolojik olduğu için biçimbilim yerine
 * açık bir liste kullanıyoruz — yanlış pozitif üretmemek buradaki asıl kaygı.
 */
const PROHIBIT_RE = /\b(?:never|do not|don'?t|must not|avoid|no longer)\b/i;
const PROHIBIT_TR = /\b(?:asla|hiçbir zaman|yasak|kullanma|yapma|atma|dokunma|girme|yazma|olmaz|kapsam dışı|etme)\b/i;

/** Direktif bir yasak mı? Öyleyse yasaklanan özneleri döner. */
export function prohibitionOf(text) {
  const hit = PROHIBIT_RE.test(text) || PROHIBIT_TR.test(text);
  return hit ? true : false;
}

// ---------- toplama ----------

/** Sıcak kümedeki tüm dosyaların direktiflerini çıkarır. */
export function collectDirectives(hot) {
  const out = [];
  for (const f of hot.files) {
    if (f.missing || !f.text) continue;
    out.push(...parseDirectives(f.file, f.text));
  }
  return out;
}

/**
 * Depoyu bir kez gezip yol son eklerini eşlemek için indeks kurar.
 * Talimat dosyaları yolları çoğu zaman kökten değil okunabilir bir kısaltmayla yazar
 * (`Data/Db/Entities/Device.cs`); yalnızca kökten denemek bu yolları kırık gösterir.
 */
const REPO_INDEX = new Map();
const SKIP_DIR = /^(?:node_modules|\.git|bin|obj|dist|build|\.next|\.venv|__pycache__|packages)$/i;

export function buildRepoIndex(repo, { maxFiles = 20000 } = {}) {
  const root = resolve(repo);
  const key = root.toLowerCase();
  if (REPO_INDEX.has(key)) return REPO_INDEX.get(key);

  const set = new Set();
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || count >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) return;
      const p = join(dir, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = statSync(p).isDirectory(); } catch { isDir = false; } }
      if (isDir) { if (!SKIP_DIR.test(e.name)) walk(p, depth + 1); continue; }
      count++;
      set.add(p.slice(root.length + 1).replace(/\\/g, "/").toLowerCase());
    }
  };
  walk(root, 0);
  REPO_INDEX.set(key, set);
  return set;
}

const ROOT_MARKERS = [".git", ".claude-plugin", "package.json"];

/** Bir dosyanın ait olduğu depo kökü: yukarı çıkarak bilinen bir işaret arar. */
export function findOwnRoot(file) {
  let cur = dirname(resolve(file));
  for (let i = 0; i < 6; i++) {
    if (ROOT_MARKERS.some((m) => existsSync(join(cur, m)))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * Bir yol öznesinin var olup olmadığını dener: önce doğrudan yollar, sonra depo
 * indeksinde son ek eşlemesi. Kalıp yolları ve ayırıcısız adlar hiç denenmez.
 */
export function resolveSubjectPath(directiveFile, token, repo) {
  if (PLACEHOLDER_PATH.test(token)) return null;
  const clean = token.replace(/^[~.]?[\\/]/, "").replace(/\\/g, "/").split(/\s+/)[0];
  if (!clean || clean.length < 3 || !clean.includes("/")) return null;

  // Direktifin kendi deposu: import edilmiş bir dosyadaki yol, denetlenen projeye değil
  // o dosyanın kendi köküne göredir.
  const bases = [dirname(directiveFile)];
  const own = findOwnRoot(directiveFile);
  if (own) bases.push(own);
  if (repo) bases.push(resolve(repo));
  bases.push(HOME);
  for (const b of bases) {
    const p = resolve(b, clean);
    if (existsSync(p)) return { exists: true, path: p };
  }

  if (repo) {
    const needle = clean.toLowerCase();
    for (const rel of buildRepoIndex(repo)) {
      if (rel === needle || rel.endsWith("/" + needle)) return { exists: true, path: join(resolve(repo), rel) };
    }
  }
  return { exists: false, path: resolve(bases[0], clean) };
}

export const fileAge = (file) => {
  try { return Math.round((Date.now() - statSync(file).mtimeMs) / 86400000); } catch { return null; }
};
