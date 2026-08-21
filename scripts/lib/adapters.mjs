/**
 * agent-blackbox — adaptör katmanı
 *
 * Farklı kodlama ajanlarının yerel oturum kayıtlarını TEK bir olay şemasına çevirir.
 * Bu dosya `agentlens` ailesinin ortak parçasıdır; kanonik kopya agent-blackbox'tadır
 * ve diğer repolara `scripts/lib/adapters.mjs` olarak aynen kopyalanır.
 *
 * TASARIM İLKESİ: Bu modül HİÇBİR ŞEY GÖNDERMEZ. Sadece yerel dosya okur. Ağ çağrısı
 * yoktur ve olmamalıdır. Düşünce (thinking) metni asla normalize olaya taşınmaz.
 *
 * Doğrulama durumu (v0.1):
 *   claude-code  → gerçek transcript'lerle doğrulandı
 *   codex        → gerçek rollout'larla doğrulandı
 *   gemini-cli   → DOĞRULANMADI; belgelenmiş dosya düzenine göre yazıldı. Dosya yoksa
 *                  sessizce "algılanmadı" döner; asla veri uydurmaz.
 *
 * Normalize olay şeması:
 *   { seq, ts, kind, tool, family, command, paths[], url, text, ok, denied,
 *     durationMs, callId, sandboxBypass, chars, raw }
 *   `text` MAX_TEXT'te kesilir; `chars` (prompt/say olaylarında) kesilmemiş uzunluğu tutar.
 *   kind:   "prompt" | "say" | "call" | "result"
 *   family: "shell" | "edit" | "read" | "search" | "network" | "subagent" | "mcp" | "plan" | "other"
 */

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";

export const MAX_TEXT = 400;
export const cut = (s, n = MAX_TEXT) => {
  const t = String(s ?? "").replace(/\r\n/g, "\n");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const HOME = homedir();

// ---------- düşük seviyeli yardımcılar ----------

/** Büyük dosyaları tamamen okumadan baş ve son parçasını alır (liste görünümü için). */
function headTail(file, headBytes = 131072, tailBytes = 65536) {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return { head: buf.toString("utf8"), tail: "" };
    }
    const h = Buffer.alloc(headBytes);
    readSync(fd, h, 0, headBytes, 0);
    const t = Buffer.alloc(tailBytes);
    readSync(fd, t, 0, tailBytes, size - tailBytes);
    return { head: h.toString("utf8"), tail: t.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Satır satır JSON; bozuk satır sessizce atlanır (yarım yazılmış son satır normaldir). */
function* jsonl(text) {
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    try { yield JSON.parse(s); } catch { /* yarım satır */ }
  }
}

function readJsonlFile(file) {
  return [...jsonl(readFileSync(file, "utf8"))];
}

/**
 * Sembolik bağlar İZLENİR: kayıt dizinleri sık sık başka bir diske ya da depoya bağlanır
 * (Dirent.isDirectory() bir symlink için false döner; sadece ona güvenmek o kayıtları
 * tamamen görünmez yapar). Döngüye girmemek için gerçek yollar takip edilir.
 */
function walk(dir, match, out = [], depth = 0, seen = new Set()) {
  if (depth > 6 || !existsSync(dir)) return out;
  let real;
  try { real = realpathSync(dir); } catch { real = dir; }
  if (seen.has(real)) return out;
  seen.add(real);

  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) walk(p, match, out, depth + 1, seen);
    else if (match(e.name)) out.push(p);
  }
  return out;
}

const iso = (v) => {
  if (!v) return null;
  const d = typeof v === "number" ? new Date(v * (v < 1e12 ? 1000 : 1)) : new Date(v);
  return isNaN(d) ? null : d.toISOString();
};

const withinDays = (ts, days) => {
  if (!days || !ts) return true;
  return Date.now() - new Date(ts).getTime() <= days * 86400000;
};

/** JS/JSON kaynağından `key: "..."` biçimli string değerleri kaçışları bozmadan çeker. */
function pluckStrings(src, key) {
  const out = [];
  const re = new RegExp('["\']?' + key + '["\']?\\s*:\\s*"', "g");
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let buf = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { buf += src[i] + src[i + 1]; i += 2; continue; }
      if (c === '"') break;
      buf += c;
      i++;
    }
    try { out.push(JSON.parse('"' + buf + '"')); } catch { out.push(buf); }
  }
  return out;
}

// ---------- tool adı normalizasyonu ----------

const FAMILY_BY_TOOL = {
  bash: "shell", powershell: "shell", shell: "shell", shell_command: "shell",
  exec_command: "shell", terminal: "shell", run_shell_command: "shell", run_terminal_cmd: "shell",
  edit: "edit", write: "edit", multiedit: "edit", notebookedit: "edit", apply_patch: "edit",
  replace: "edit", write_file: "edit", create_file: "edit", str_replace_editor: "edit",
  read: "read", read_file: "read", view_image: "read", notebookread: "read",
  grep: "search", glob: "search", search_file_content: "search", codebase_search: "search",
  list_directory: "search", ls: "search",
  webfetch: "network", websearch: "network", web_fetch: "network",
  google_web_search: "network", web__run: "network",
  task: "subagent", agent: "subagent", spawn_agent: "subagent", workflow: "subagent",
  update_plan: "plan", todowrite: "plan", exitplanmode: "plan",
};

export function toolFamily(name = "") {
  const n = String(name).toLowerCase();
  if (n.startsWith("mcp__") || n.startsWith("mcp.")) return "mcp";
  return FAMILY_BY_TOOL[n] || "other";
}

// ---------- adaptör: Claude Code ----------

const claudeCode = {
  id: "claude-code",
  label: "Claude Code",
  verified: true,
  root: () => join(HOME, ".claude", "projects"),

  detect() { return existsSync(this.root()); },

  listSessions({ days = 0 } = {}) {
    if (!this.detect()) return [];
    const files = walk(this.root(), (n) => n.endsWith(".jsonl"));
    const out = [];
    for (const file of files) {
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.size === 0) continue;
      const endedAt = new Date(st.mtimeMs).toISOString();
      if (!withinDays(endedAt, days)) continue;
      const { head, tail } = headTail(file);
      const meta = { agent: this.id, id: basename(file, ".jsonl"), file, endedAt, bytes: st.size };
      for (const o of jsonl(head)) {
        if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
        if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
        if (o.version && !meta.version) meta.version = o.version;
        if (o.timestamp && !meta.startedAt) meta.startedAt = iso(o.timestamp);
        if (o.message?.model && !meta.model) meta.model = o.message.model;
      }
      for (const o of jsonl(tail || head)) {
        if (o.type === "ai-title" && o.aiTitle) meta.title = cut(o.aiTitle, 90);
        else if (o.type === "last-prompt" && o.lastPrompt && !meta.title) meta.title = cut(o.lastPrompt, 90);
      }
      out.push(meta);
    }
    return out;
  },

  loadSession(file) {
    const records = readJsonlFile(file);
    const s = newSession(this.id, basename(file, ".jsonl"), file);
    const permissionModes = new Set();
    const pending = new Map(); // tool_use_id -> call event
    let seq = 0;

    for (const o of records) {
      const ts = iso(o.timestamp);
      if (o.cwd && !s.cwd) s.cwd = o.cwd;
      if (o.gitBranch && !s.gitBranch) s.gitBranch = o.gitBranch;
      if (o.version) s.version = o.version;
      if (o.permissionMode) permissionModes.add(o.permissionMode);
      if (ts) { if (!s.startedAt) s.startedAt = ts; s.endedAt = ts; }

      if (o.type === "ai-title" && o.aiTitle) { s.title = cut(o.aiTitle, 90); continue; }

      if (o.type === "file-history-snapshot") {
        const tracked = o.snapshot?.trackedFileBackups || {};
        for (const [rel, b] of Object.entries(tracked)) {
          s.backups.push({
            relPath: rel,
            dir: b.realParentDir || null,
            version: b.version ?? null,
            backupFileName: b.backupFileName || null,
            backupTime: iso(b.backupTime),
          });
        }
        continue;
      }

      const content = o.message?.content;

      if (o.type === "user") {
        if (o.isMeta) continue;
        if (typeof content === "string") {
          s.events.push({ seq: seq++, ts, kind: "prompt", family: "other", text: cut(content), chars: String(content).length });
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b.type === "text") {
            s.events.push({ seq: seq++, ts, kind: "prompt", family: "other", text: cut(b.text), chars: String(b.text ?? "").length });
          } else if (b.type === "tool_result") {
            const call = pending.get(b.tool_use_id);
            const raw = typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : "";
            const denied = !!o.toolDenialKind || /^The user (doesn't want to proceed|rejected)/.test(raw);
            const ev = {
              seq: seq++, ts, kind: "result", callId: b.tool_use_id,
              tool: call?.tool || null, family: call?.family || "other",
              paths: call?.paths || [],
              ok: denied ? null : !b.is_error,
              denied,
              // Write yeni dosya oluşturduğunda geri alma "sil" demektir, "eski hâline getir" değil.
              created: o.toolUseResult?.type === "create",
              text: cut(raw),
              durationMs: call?.ts && ts ? new Date(ts) - new Date(call.ts) : null,
              userFeedback: o.userFeedback ? cut(o.userFeedback, 200) : null,
            };
            if (call) call.result = ev;
            s.events.push(ev);
          }
        }
        continue;
      }

      if (o.type === "assistant") {
        if (o.message?.model) s.model = o.message.model;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b.type === "thinking") { s.thinkingBlocks++; continue; } // metin ASLA taşınmaz
          if (b.type === "text") {
            if (b.text && b.text.trim()) s.events.push({ seq: seq++, ts, kind: "say", family: "other", text: cut(b.text) });
          } else if (b.type === "tool_use") {
            const ev = normalizeClaudeCall(b, ts, seq++, o);
            pending.set(b.id, ev);
            s.events.push(ev);
          }
        }
      }
    }
    s.permissionModes = [...permissionModes];
    return s;
  },
};

function normalizeClaudeCall(block, ts, seq, record) {
  const tool = block.name || "?";
  const input = block.input || {};
  const family = toolFamily(tool);
  const ev = {
    seq, ts, kind: "call", tool, family, callId: block.id,
    command: null, paths: [], url: null, text: null,
    sandboxBypass: input.dangerouslyDisableSandbox === true,
    skill: record.attributionSkill || null,
    plugin: record.attributionPlugin || null,
  };
  if (family === "shell") {
    ev.command = String(input.command ?? "");
    ev.text = cut(input.description || ev.command);
  } else if (family === "edit" || family === "read") {
    const p = input.file_path || input.notebook_path || input.path;
    if (p) ev.paths.push(p);
    ev.text = cut(p || "");
  } else if (family === "search") {
    ev.text = cut(input.pattern || input.query || "");
    if (input.path) ev.paths.push(input.path);
  } else if (family === "network") {
    ev.url = input.url || null;
    ev.text = cut(input.url || input.query || "");
  } else if (family === "subagent") {
    ev.text = cut(input.subagent_type || input.description || "");
  } else {
    ev.text = cut(JSON.stringify(input), 200);
  }
  return ev;
}

// ---------- adaptör: Codex CLI ----------

const codex = {
  id: "codex",
  label: "Codex CLI",
  verified: true,
  root: () => join(HOME, ".codex", "sessions"),

  detect() { return existsSync(this.root()); },

  listSessions({ days = 0 } = {}) {
    if (!this.detect()) return [];
    const files = walk(this.root(), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
    const out = [];
    for (const file of files) {
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.size === 0) continue;
      const endedAt = new Date(st.mtimeMs).toISOString();
      if (!withinDays(endedAt, days)) continue;
      const { head, tail } = headTail(file);
      const meta = { agent: this.id, id: basename(file, ".jsonl").replace(/^rollout-/, ""), file, endedAt, bytes: st.size };
      for (const o of jsonl(head)) {
        const p = o.payload || {};
        if (o.type === "session_meta") {
          meta.id = p.session_id || meta.id;
          meta.cwd = p.cwd || null;
          meta.version = p.cli_version || null;
          meta.origin = p.originator || null;
          meta.startedAt = iso(p.timestamp || o.timestamp);
        }
        if (o.type === "turn_context" && p.model && !meta.model) meta.model = p.model;
        if (p.type === "user_message" && !meta.title) meta.title = cut(p.message, 90);
      }
      for (const o of jsonl(tail || head)) {
        const p = o.payload || {};
        if (p.type === "user_message" && !meta.title) meta.title = cut(p.message, 90);
      }
      out.push(meta);
    }
    return out;
  },

  loadSession(file) {
    const records = readJsonlFile(file);
    const s = newSession(this.id, basename(file, ".jsonl").replace(/^rollout-/, ""), file);
    const pending = new Map();
    let seq = 0;

    for (const o of records) {
      const ts = iso(o.timestamp);
      const p = o.payload || {};
      if (ts) { if (!s.startedAt) s.startedAt = ts; s.endedAt = ts; }

      if (o.type === "session_meta") {
        s.id = p.session_id || s.id;
        s.cwd = p.cwd || null;
        s.version = p.cli_version || null;
        continue;
      }
      if (o.type === "turn_context") {
        if (p.model) s.model = p.model;
        const mode = [p.approval_policy, p.sandbox_policy?.mode].filter(Boolean).join("/");
        if (mode && !s.permissionModes.includes(mode)) s.permissionModes.push(mode);
        continue;
      }
      if (p.type === "reasoning") { s.thinkingBlocks++; continue; }
      if (p.type === "user_message") {
        if (!s.title) s.title = cut(p.message, 90);
        s.events.push({ seq: seq++, ts, kind: "prompt", family: "other", text: cut(p.message), chars: String(p.message ?? "").length });
        continue;
      }
      if (p.type === "agent_message") {
        s.events.push({ seq: seq++, ts, kind: "say", family: "other", text: cut(p.message) });
        continue;
      }
      if (p.type === "custom_tool_call" || p.type === "function_call") {
        for (const ev of normalizeCodexCall(p, ts, () => seq++)) {
          if (ev.callId && !pending.has(ev.callId)) pending.set(ev.callId, ev);
          s.events.push(ev);
        }
        continue;
      }
      if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
        const raw = Array.isArray(p.output) ? p.output.map((x) => x.text || "").join("\n") : String(p.output ?? "");
        const call = pending.get(p.call_id);
        const failed = /Script failed|Script error|Exit code:\s*[1-9]/.test(raw);
        const ev = {
          seq: seq++, ts, kind: "result", callId: p.call_id,
          tool: call?.tool || null, family: call?.family || "other",
          paths: call?.paths || [],
          ok: !failed,
          denied: /rejected by the user|not approved/i.test(raw),
          text: cut(raw),
          durationMs: call?.ts && ts ? new Date(ts) - new Date(call.ts) : null,
        };
        if (call) call.result = ev;
        s.events.push(ev);
        continue;
      }
      if (p.type === "patch_apply_end") {
        const paths = Object.keys(p.changes || {});
        s.events.push({
          seq: seq++, ts, kind: "result", callId: p.call_id, tool: "apply_patch", family: "edit",
          paths, ok: p.success !== false, denied: false, text: cut(p.stdout || p.stderr || ""),
        });
        for (const [path, ch] of Object.entries(p.changes || {})) {
          s.backups.push({
            relPath: path, dir: null, version: null, backupFileName: null,
            backupTime: ts, changeType: ch.type || null, diff: ch.unified_diff || null,
          });
        }
      }
    }
    return s;
  },
};

function normalizeCodexCall(p, ts, nextSeq) {
  const name = p.name || "?";
  const src = typeof p.input === "string"
    ? p.input
    : (typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {}));
  const base = () => ({
    seq: nextSeq(), ts, kind: "call", tool: name, family: toolFamily(name),
    callId: p.call_id, command: null, paths: [], url: null, text: null,
  });

  if (name === "shell_command" || name === "exec_command") {
    const cmd = pluckStrings(src, "command")[0] ?? pluckStrings(src, "cmd")[0] ?? "";
    const ev = base();
    ev.family = "shell";
    ev.command = cmd;
    ev.text = cut(cmd);
    return [ev];
  }
  if (name === "exec") {
    // Codex'in JS harness'i: içeride bir veya birden çok tools.shell_command({command:"..."}) olabilir.
    const cmds = pluckStrings(src, "command");
    if (cmds.length) {
      return cmds.map((c) => {
        const ev = base();
        ev.family = "shell";
        ev.command = c;
        ev.text = cut(c);
        return ev;
      });
    }
    const ev = base();
    ev.family = /tools\.web__run/.test(src) ? "network" : "other";
    ev.text = cut(src, 300);
    return [ev];
  }
  if (name === "apply_patch") {
    const ev = base();
    ev.family = "edit";
    for (const m of src.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) ev.paths.push(m[1].trim());
    ev.text = cut(ev.paths.join(", ") || src, 200);
    return [ev];
  }
  if (name === "view_image") {
    const ev = base();
    ev.family = "read";
    const path = pluckStrings(src, "path")[0];
    if (path) ev.paths.push(path);
    ev.text = cut(path || "");
    return [ev];
  }
  const ev = base();
  ev.text = cut(src, 200);
  return [ev];
}

// ---------- adaptör: Gemini CLI (DOĞRULANMADI) ----------

const geminiCli = {
  id: "gemini-cli",
  label: "Gemini CLI",
  verified: false,
  root: () => join(HOME, ".gemini", "tmp"),

  detect() {
    const r = this.root();
    if (!existsSync(r)) return false;
    return walk(r, (n) => n.endsWith(".json")).length > 0;
  },

  listSessions({ days = 0 } = {}) {
    if (!this.detect()) return [];
    const files = walk(this.root(), (n) => n.endsWith(".json") && n !== "shell_history.json");
    const out = [];
    for (const file of files) {
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.size === 0) continue;
      const endedAt = new Date(st.mtimeMs).toISOString();
      if (!withinDays(endedAt, days)) continue;
      out.push({ agent: this.id, id: basename(file, extname(file)), file, endedAt, bytes: st.size, unverified: true });
    }
    return out;
  },

  loadSession(file) {
    const s = newSession(this.id, basename(file, extname(file)), file);
    s.unverified = true;
    let doc;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { return s; }
    const turns = Array.isArray(doc) ? doc : (doc.messages || doc.history || doc.turns || []);
    let seq = 0;
    for (const t of turns) {
      const ts = iso(t.timestamp || t.time || null);
      if (ts) { if (!s.startedAt) s.startedAt = ts; s.endedAt = ts; }
      const parts = t.parts || t.message?.parts || [];
      if (!parts.length && typeof t.message === "string") {
        s.events.push({ seq: seq++, ts, kind: t.role === "user" ? "prompt" : "say", family: "other", text: cut(t.message), chars: String(t.message ?? "").length });
        continue;
      }
      for (const part of parts) {
        if (part.text) {
          s.events.push({ seq: seq++, ts, kind: t.role === "user" ? "prompt" : "say", family: "other", text: cut(part.text), chars: String(part.text ?? "").length });
        } else if (part.functionCall) {
          const name = part.functionCall.name || "?";
          const args = part.functionCall.args || {};
          const ev = {
            seq: seq++, ts, kind: "call", tool: name, family: toolFamily(name),
            callId: null, command: null, paths: [], url: null, text: null,
          };
          if (ev.family === "shell") ev.command = String(args.command ?? args.cmd ?? "");
          const p = args.file_path || args.absolute_path || args.path;
          if (p) ev.paths.push(p);
          ev.text = cut(ev.command || p || JSON.stringify(args), 200);
          s.events.push(ev);
        } else if (part.functionResponse) {
          const r = part.functionResponse.response || {};
          const raw = typeof r === "string" ? r : (r.output || r.error || JSON.stringify(r));
          s.events.push({
            seq: seq++, ts, kind: "result", tool: part.functionResponse.name || null,
            family: toolFamily(part.functionResponse.name), paths: [],
            ok: !r.error, denied: false, text: cut(raw),
          });
        }
      }
    }
    return s;
  },
};

function newSession(agent, id, file) {
  return {
    agent, id, file,
    cwd: null, gitBranch: null, version: null, model: null, title: null,
    startedAt: null, endedAt: null, permissionModes: [], thinkingBlocks: 0,
    events: [], backups: [],
  };
}

// ---------- kayıt ----------

export const ADAPTERS = [claudeCode, codex, geminiCli];

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/** Kurulu ajanları algılar; kurulu olmayan sessizce dışarıda kalır. */
export function detectAgents() {
  return ADAPTERS.map((a) => ({
    id: a.id, label: a.label, verified: a.verified,
    root: a.root(), detected: a.detect(),
  }));
}

/** Tüm (veya seçili) ajanların oturumlarını en yeniden eskiye sıralı verir. */
export function listAllSessions({ agent = "all", days = 0 } = {}) {
  const out = [];
  for (const a of ADAPTERS) {
    if (agent !== "all" && agent !== a.id) continue;
    if (!a.detect()) continue;
    try { out.push(...a.listSessions({ days })); } catch { /* okunamayan ajanı atla */ }
  }
  return out.sort((x, y) => String(y.endedAt || "").localeCompare(String(x.endedAt || "")));
}

/** Oturumu id ile ya da "latest" ile yükler. */
export function loadSession({ agent = "all", session = "latest", days = 0 } = {}) {
  const list = listAllSessions({ agent, days });
  if (!list.length) return null;
  const meta = session === "latest"
    ? list[0]
    : list.find((s) => s.id === session || s.id.startsWith(session) || basename(s.file).includes(session));
  if (!meta) return null;
  const s = getAdapter(meta.agent).loadSession(meta.file);
  s.title = s.title || meta.title || null;
  s.endedAt = s.endedAt || meta.endedAt;
  return s;
}
