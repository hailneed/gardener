---
name: compliance
description: Check whether the rules in an instruction file are actually followed — cross-reference prohibitions against the commands really run in local sessions to surface violation candidates, and list the rules whose subject never came up at all, so dead weight is visible instead of assumed. Use when the user asks whether their rules work, suspects the agent is ignoring CLAUDE.md, wants to know which instructions still earn their place, says "kurallarım uygulanıyor mu", "does the agent actually follow this", "which rules are dead weight", or runs /gardener:compliance. Not for the cost inventory — that is gardener:audit. Not for a removal plan — that is gardener:prune.
---

# Are the rules followed? (compliance)

An instruction file is a set of claims about how work gets done. This checks those claims
against what actually ran, using the session logs already on disk. No quota, no network.

**Language rule: write every user-facing output in the language the user is speaking with you.**
**Evidence rule: this produces candidates, not verdicts. Open every one before reporting it
as a violation — the tool matches text, it does not understand the rule.**

## Step 1 — Measure

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gardener.mjs" --compliance --repo "<repo>" --md
```

Bound the window with `--days 90` when the history is long. Read the source note: how many
sessions were scanned and how many were unreadable. A rule can only be judged against the
sessions that were actually read.

## Step 2 — Verify every violation candidate

A candidate means: this rule forbids something, and that something appears in a real
command. That is a lead, not a finding. For each one, read the example commands and decide:

- **Real violation** — the rule says do not do X, and X was done. Report it with the date
  and project.
- **Scope mismatch** — the rule forbids X *in a particular place*, and these commands ran
  elsewhere. The tool cannot see that distinction. Drop it, and say the rule's wording is
  what made it ambiguous.
- **Different sense** — the same words, a different meaning. Drop it silently.

Say how many candidates you dropped. A shrinking list is the point of this step.

## Step 3 — A real violation is a finding about the rule, not only about the run

When a prohibition was genuinely broken, ask which:

1. **Not read** — buried in a long file, or in a file that is not loaded. `/gardener:audit`
   shows whether it loads at all and what it competes with.
2. **Not actionable** — it states a preference, not a boundary. Rewrite it as one.
3. **Wrong** — the prohibition does not match how the work actually has to be done. The
   rule is the thing to change.
4. **Unenforceable by text** — a rule that keeps losing needs a hook, a lint rule or a
   permission entry. Say plainly that text is the wrong instrument here.

## Step 4 — Read the dead-weight list carefully

These are rules whose subject never appears in any session. Before recommending removal,
separate two cases that look identical in the data:

- **The work never came up.** A rule about a tool the user does not use is genuinely dead
  weight, and its cost is paid on every request.
- **The rule worked.** A prohibition with zero occurrences is a rule doing its job. Removing
  it is exactly how the failure comes back.

The distinction is the rule's *direction*: prohibitions with zero hits are usually
successes; instructions to do something with zero hits are usually dead. Say which reading
applies for each one, and never propose deleting a safety rule on a zero count.

## Step 5 — Reply

Short: how many sessions were scanned, how many candidates you verified and how many
survived, each real violation with its cause from step 3, and the dead-weight lines you
would actually remove — with the safety rules explicitly excluded and why. If nothing is
violated, say it in one line: the rules holding is the outcome the file exists for.
