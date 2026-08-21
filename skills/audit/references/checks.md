# Check catalogue and triage guide

Every check is a transparent test in `scripts/lib/checks.mjs`. A hit means "this condition
held", not "a model judged it". Turn any check off with `--ignore <id>`.

Scoring: `error = 10`, `warn = 4`, `info = 1`. Total ≥ 40 → `kötü`, ≥ 15 → `orta`,
> 0 → `iyi`, 0 → `temiz`. The number ranks files against each other, nothing more.

## What counts as hot context

Only what loads on **every request**:

- `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`
- the repo's `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/CLAUDE.md`
- everything those pull in through `@path`, resolved transitively

**Out of scope:** skill bodies and `references/` files. They load on demand, and measuring
them is `skillbench`'s job. Mixing the two would make a large skill library look like a
context problem when it is not.

## Budgets

| Threshold | Value | Reading |
| --- | --- | --- |
| file, warn | 300 lines | Past this a file is hard to hold in mind, and the cost repeats |
| file, error | 600 lines | At this size instruction-following measurably degrades |
| total, warn | 4 000 estimated tokens | Still comfortable, worth watching |
| total, error | 8 000 estimated tokens | Every request starts with a large fraction already spent |

Token figures come from `bytes / 4`, not from a tokenizer. They are consistent enough to
compare files against each other and to track a change over time; they are not exact, and
the report says so every time.

## Checks

| id | sev | fires when | triage |
| --- | --- | --- | --- |
| `broken-import` | error | an `@path` does not resolve | Always real, and silent: you believe those rules load and they do not. Fix first. |
| `hot-file-oversized` | error | a hot file over 600 lines | Real. Line edits will not fix it — the file needs splitting into always-loaded and on-demand parts. |
| `hot-file-large` | warn | a hot file over 300 lines | Standing debt. Worth acting on when the user is already editing that file. |
| `hot-budget-exceeded` | error | total over 8 000 estimated tokens | The honest answer to "why does my agent ignore instructions". |
| `hot-budget-high` | warn | total over 4 000 estimated tokens | Not a problem yet. The useful habit: add a rule, remove a rule. |
| `stale-path` | warn | a backticked path in a rule does not exist | Resolution tries the file's own directory, its own repo root, the audited repo and a suffix match across the repo index before declaring it missing — so a hit usually means it really is gone. Placeholder paths (`<name>`, `Xxx`) are never checked. |
| `duplicate-directive` | warn / info | two directives overlap above 55% | `warn` across files, `info` within one file. Read both texts: identical wording is dead weight, near-identical wording with different scope is a future contradiction. |
| `vague-directive` | info | an imperative with hedging language and no concrete subject | Only worth raising while the user is editing that file. |

## Compliance checks

These need session history and appear under `/gardener:compliance`.

| id | sev | fires when | triage |
| --- | --- | --- | --- |
| `prohibition-seen` | warn | a rule forbids a command whose stable core appears in real commands | **A candidate, not a verdict.** The rule may forbid the command in a particular place or context; the matcher cannot see that. Open the examples. |
| `dead-directive` | info | a rule's command subject appears in no session | Separate two cases that look identical: the work never came up (dead weight) versus the rule worked (a success). Prohibitions with zero hits are usually successes. |

Only command-shaped subjects are checked. Configuration keys (`trusted: false`), code
expressions (`window.PageContext.messages`) and SQL fragments are excluded — matching those
against shell commands produces noise, not findings. Templated commands are matched on
their stable core, so `claude plugin validate <repo> --strict` still matches a real
`claude plugin validate . --strict`.

## What gardener cannot tell you

- **Whether a rule is correct.** It measures presence, cost, duplication and whether the
  subject shows up. Whether the instruction is good advice is a human judgement.
- **Whether a non-command rule was followed.** "All UI text goes through MessageService" is
  not checkable from session logs; it needs a lint rule in the repo.
- **Contradictions in meaning.** Two rules can agree word-for-word and still conflict in
  intent. Duplication is detectable; contradiction is not.
