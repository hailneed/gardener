# gardener

[![CI](https://github.com/hailneed/gardener/actions/workflows/ci.yml/badge.svg)](https://github.com/hailneed/gardener/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#requirements)

> **Context hygiene for agent instruction files.** Resolves `CLAUDE.md`, `AGENTS.md` and
> everything they import into one inventory of your hot context, prices what it costs on
> **every request**, and finds broken imports, stale references and duplicated rules.
>
> No network calls. No API key. No quota. It never writes to your instruction files.

**Site:** https://hailneed.github.io/gardener/ · *Türkçe açıklama aşağıda.*

Your instruction file is the most expensive text in the repo: every line is paid for not
once but on **every single request**. Yet nobody maintains it. It grows, it contradicts
itself, it points at files that no longer exist — and nobody knows which rule is actually
being followed.

## What it looks like

```
$ npx --yes github:hailneed/gardener --audit --repo . --md
```

```markdown
# gardener — hot context audit

**Source note:** 6 files · 182 lines · ~2638 estimated tokens, per request ·
76 directives · **score:** 12 (good)

## What loads

| File                          | scope   | depth | lines | ~tokens |
|-------------------------------|---------|-------|-------|---------|
| `~/.claude/CLAUDE.md`         | global  | 0     | 7     | 60      |
| `~/agent/instructions.md`     | global  | 1     | 53    | 749     |
| `~/agent/identity.md`         | global  | 2     | 46    | 553     |
| `~/agent/memory/MEMORY.md`    | global  | 2     | 30    | 676     |
| `.claude/CLAUDE.md`           | project | 0     | 45    | 600     |
| **total**                     |         |       | **182** | **2638** |

## Findings

| Sev  | Check               | where               | what         |
|------|---------------------|---------------------|--------------|
| warn | duplicate-directive | instructions.md:52  | 86% overlap  |
| warn | duplicate-directive | instructions.md:32  | 69% overlap  |

- **duplicate-directive** (warn) — The same instruction in two places trains the reader
  to skim, and once one copy is updated and the other is not, they contradict.
  → *Remove one, or if the scopes really do differ, state the difference explicitly.*

## Duplicated instructions

- 86% overlap — `instructions.md:52` ⟷ `CLAUDE.md:16`
  - Before adding anything here ask: "would this help me in another project too?"…
  - Before adding something new: "would this be useful in another project?"…
```

That 86% overlap is a real finding from a real instruction set. Two copies of the same
rule, in two files, both loaded on every request.

## Commands

| Command | What you get |
|---|---|
| `/gardener:audit` | **What loads**: the import chain resolved, lines and estimated token cost, broken imports, stale paths, duplicated instructions |
| `/gardener:compliance` | **Is it followed**: prohibitions cross-referenced against commands actually run, plus rules whose subject never once came up |
| `/gardener:prune` | **What can go**: a line-by-line `cut` / `move` / `fix` / `rewrite` / `enforce` plan, with reasons |

## What counts as hot context

Only text loaded on **every request**:

- `~/.claude/CLAUDE.md` · `~/.codex/AGENTS.md` · `~/.gemini/GEMINI.md`
- the repo's `CLAUDE.md` · `AGENTS.md` · `GEMINI.md` · `.claude/CLAUDE.md`
- everything they pull in with `@path`, **transitively**

**Out of scope:** skill bodies and `references/` files. Those load on demand; measuring
them is [`skillbench`](https://github.com/hailneed/skillbench)'s job. Conflating the two
would make a large skill library look like a context problem.

Import resolution is real work: one file pulls another, which pulls another. The report
gives you the list that **actually loads**, not what the top file claims. An import that
cannot be resolved is never skipped silently — it is marked `⚠`, because believing
"those rules are loading" is the most expensive mistake available.

## Budgets

| Threshold | Value |
|---|---|
| per file, warn / error | 300 / 600 lines |
| total, warn / error | 4,000 / 8,000 estimated tokens |

Token counts come from a **bytes/4 estimate**, not a real tokenizer. That is enough to
compare files against each other and to track change over time; it is not exact, and the
report says so every time.

## How compliance is measured

The subject of a prohibition (a command like `git push --force`) is compared against the
commands in your real session logs. A match produces a **violation candidate**.

> This is a candidate generator, not proof. A rule may forbid a *location* or a *context*
> that the matcher cannot see. The skill opens each line, verifies it, and tells you how
> many it threw out.

To cut noise, only **command-shaped** subjects are checked: config keys (`trusted: false`),
code expressions (`window.PageContext.messages`) and SQL fragments stay out. Templated
commands are matched on their stable prefix — `claude plugin validate <repo> --strict`
matches a real `claude plugin validate . --strict`.

There is a mirror case: rules whose subject appears in **no** session. Two situations look
byte-identical in the data, and the skill is obliged to separate them:

- **The work never came up** → dead weight, paid for on every request.
- **The rule worked** → a zero count is a success. Deleting a safety rule because it has
  a zero count is the shortest path to bringing the bug back.

## Privacy and safety

- The script makes **no network calls** and **edits no files**. It produces a plan.
- The `prune` skill will not touch `CLAUDE.md` on its own — it shows the lines, asks for
  confirmation, and edits one file at a time.
- Unreadable sessions are not hidden; the source note carries the count.

## Install

```
# Inside Claude Code, once:
/plugin marketplace add hailneed/plugins
/plugin install gardener@hailneed
```

Then:

```
/gardener:audit
```

### Requirements

Claude Code + Node.js 18+. No dependencies, no API key.

## Without the plugin

```
git clone https://github.com/hailneed/gardener
cd gardener

node scripts/gardener.mjs --audit --repo ../my-project --md
node scripts/gardener.mjs --compliance --days 90 --md
node scripts/gardener.mjs --prune --repo ../my-project --md
node scripts/gardener.mjs --selftest
```

Flags: `--agent all|claude-code|codex|gemini-cli` · `--repo DIR` · `--days N` ·
`--lang en|tr` · `--out FILE` · `--limit N` · `--ignore check1,check2`.

## In CI

There is a GitHub Action, so you do not have to write the plumbing. The useful one here
is `max-tokens` — instruction files grow quietly and the cost is paid on every request, so
a number that fails the PR is the only practical way to keep that visible:

```yaml
- uses: hailneed/gardener@main
  with:
    max-tokens: 4000      # fail if the hot context grows past this
    fail-on: error        # error | warn | info | never
```

Error findings appear as **inline annotations** on the offending line, and the report is
written to the job summary.

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | directory to audit |
| `fail-on` | `error` | lowest severity that fails the job; `never` reports without failing |
| `max-tokens` | *(none)* | fail if the estimated hot-context total exceeds this |
| `max-score` | *(none)* | fail if `score.raw` exceeds this |
| `ignore` | *(none)* | comma-separated check ids to silence |
| `lang` | `en` | language of the human-readable prose |
| `summary` | `true` | write the report to the job summary |

The three thresholds are **independent**: a single broken import can arrive with a small
token total, and a bloated file can carry no findings at all. Outputs: `score` · `level` ·
`tokens` · `lines` · `files` · `findings` · `errors` · `json`.

```yaml
- uses: hailneed/gardener@main
  id: hot
  with:
    fail-on: never        # report, do not block
- run: echo "~${{ steps.hot.outputs.tokens }} tokens on every request"
```

### Or wire it yourself

The JSON output is **language-neutral**: `check`, `severity`, `vars` and `score.level`
are identical whatever `--lang` you pass, so a threshold never breaks on a translation.
Only `detail`, `why` and `fix` are localised.

```yaml
- run: node scripts/gardener.mjs --audit --repo . --out audit.json
- run: |
    node -e '
      const a = require("./audit.json");
      if (a.totals.tokens > 4000) { console.error("hot context: ~" + a.totals.tokens + " tokens"); process.exit(1); }
      const broken = a.findings.filter((f) => f.check === "broken-import");
      if (broken.length) { console.error(broken.length + " broken imports"); process.exit(1); }
    '
```

`score.level` is one of `poor` · `fair` · `good` · `clean`. An unknown flag exits **2**,
so a typo fails the job instead of passing silently.

## Roadmap (and how it makes money)

- **v0.1 (this repo):** 3 skills + a dependency-free scanner + 10 checks, MIT.
- **v0.2:** exact counts from a real tokenizer, contradiction candidates (two opposing
  rules on the same subject), memory-file hygiene, context budget over time,
  `--format sarif`.
- **Gardener Cloud (paid, optional):** continuous budget tracking for team instruction
  files, before/after comparison of what a rule change did to behaviour, and a
  "rules that actually apply in this repo" summary for new joiners. The plugin stays free.
  Waitlist: https://hailneed.github.io/gardener/#cloud

This repo is part of the `agentlens` family: the adapter layer is shared with
[`agent-blackbox`](https://github.com/hailneed/agent-blackbox), where the canonical copy lives.

## License

MIT.

---

## Türkçe

**gardener**, ajan talimat dosyaları için bağlam hijyeni aracıdır.

- **`/gardener:audit`** — `CLAUDE.md`, `AGENTS.md` ve `@yol` importlarını özyinelemeli
  çözer, **her istekte** yüklenenin satır ve tahmini token maliyetini çıkarır; kırık
  import, bayat atıf ve yinelenen talimatı işaretler.
- **`/gardener:compliance`** — yasakları gerçek oturumlarda çalıştırılmış komutlarla
  karşılaştırıp **ihlal adayı** üretir, konusu hiç geçmeyen kuralları listeler. Ölü
  ağırlık ile sessizce işini yapan kural ayrımında ısrar eder.
- **`/gardener:prune`** — işaretlenen her satır için `cut` / `move` / `fix` / `rewrite` /
  `enforce` planı; ayrıca her istekte yüklenen dosyada ne kalmalı, ne talep üzerine
  okunan dosyaya taşınmalı.

**Yapısı gereği dürüst:** token sayıları bayt/4 kestirimidir ve rapor bunu her seferinde
söyler; uyum bulguları doğrulanması gereken adaylardır; sıfır kez geçen bir yasak ölü
ağırlık değil, olası bir başarı olarak raporlanır.

**Hiçbir şey makineden çıkmaz, hiçbir dosya düzenlenmez.** Ağ çağrısı yok, API anahtarı
yok, kota yok. Node.js 18+, bağımlılık yok.

Çıktı varsayılan olarak İngilizcedir; Türkçe için `--lang tr` ver:

```
node scripts/gardener.mjs --audit --repo . --md --lang tr
```

```
/plugin marketplace add hailneed/plugins
/plugin install gardener@hailneed
```
