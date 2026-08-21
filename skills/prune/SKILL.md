---
name: prune
description: Work out what can come out of an instruction file — a line-by-line plan that marks each flagged directive cut, move, fix, rewrite or enforce, with the reason and the evidence behind it, and proposes which sections belong in an on-demand file instead of the always-loaded one. Use when the user wants to shrink or clean up CLAUDE.md or AGENTS.md, asks what they can delete from their instructions, says "CLAUDE.md'yi kısalt", "bunu temizleyelim", "what can I remove from my instructions", "my context file is too big", or runs /gardener:prune. Not for the inventory and findings — that is gardener:audit. Not for measuring whether rules are obeyed — that is gardener:compliance.
---

# Prune plan (prune)

Turn "this file is too long" into a specific list of lines with a reason each. The script
produces a plan and writes nothing; every edit is the user's call.

**Language rule: write every user-facing output in the language the user is speaking with you.**
**Safety rule: never edit an instruction file without showing the exact lines and getting
agreement. Deleting a rule someone relies on is silent and expensive — it shows up weeks
later as behaviour nobody can explain.**

## Step 1 — Get the plan

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gardener.mjs" --prune --repo "<repo>" --md
```

Requires Node.js 18+. The plan flags only lines with a concrete reason; it will never
propose cutting the whole file. If it flags nothing, the file may still be too long — that
is a structure problem, and step 3 is where it gets solved.

## Step 2 — Judge each action

| Action | Means | Before accepting it |
| --- | --- | --- |
| **cut** | the same instruction exists elsewhere | Read both. Keep the one in the narrower scope, unless the wider one is the canonical source |
| **move** | its subject never appears in real sessions | Ask whether the work never came up, or never came up *because* the rule worked. A safety rule that succeeded looks identical to a dead one |
| **fix** | it points at a file that is gone | Check whether the file moved before deleting the rule |
| **rewrite** | compliance cannot be read off it | Turn it into an action: what, when, with which tool |
| **enforce** | written but not holding | Text is the wrong instrument. Propose a hook, a lint rule or a permission entry |

That **move** caveat matters more than any other line in this skill. "Never force-push to a
repo you do not own" showing zero occurrences is the rule working, not the rule being
useless. Say so instead of proposing removal.

## Step 3 — The structural cut is bigger than the line-by-line one

The report names the file that dominates the budget. Line edits will not fix a 600-line
file; splitting it will. Read it and sort its sections into three:

- **Always** — decisions the agent needs on every request: conventions it must follow,
  hard boundaries, the two or three things that are always wrong here. Stays.
- **On demand** — reference material: schemas, entity lists, API tables, setup steps,
  historical context. Moves to a file the agent reads when relevant, and the always-file
  keeps one line saying when to read it.
- **Belongs elsewhere** — anything that is really a skill (a repeatable procedure) or a
  decision record (something settled once). Propose the destination.

Give the actual split with section names and estimated line counts, not the principle.

## Step 4 — Propose, then edit one file at a time

Show the proposed diff for a single file, wait, apply, then move to the next. When moving
sections out, the always-file must keep a pointer — a section silently removed is a rule
silently deleted.

After each edit, rerun `--audit` and report the new total against the old. That number is
the only proof the work did anything.

## Step 5 — Reply

Short: what the file costs now, how many lines are flagged and under which actions, the
structural split you propose with rough sizes, and the single change with the biggest
effect. End with the before/after estimate if you already applied something. If the file is
healthy, say so — a lean instruction file that survives an audit is the goal, not a finding.
