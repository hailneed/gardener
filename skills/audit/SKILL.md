---
name: audit
description: Show what an agent loads on every single request and what is wrong with it — resolve CLAUDE.md, AGENTS.md and their imports into one hot-context inventory, price it in lines and estimated tokens, and flag oversized files, broken imports, references to files that no longer exist and instructions duplicated across files. Use when the user asks what is in their context, why their agent seems to ignore instructions, whether CLAUDE.md has grown too big, wants to review or clean up their instruction files, says "CLAUDE.md'ye bak", "bağlamımda ne var", "audit my instructions", "is my CLAUDE.md too long", or runs /gardener:audit. Not for deciding what to remove — that is gardener:prune. Not for checking whether rules are obeyed — that is gardener:compliance.
---

# Hot context audit (audit)

Instruction files are the most expensive text in a repository: every line is paid for on
every request, forever. This shows what is actually loaded, what it costs and what is
broken. Local only, no quota.

**Language rule: write every user-facing output in the language the user is speaking with you.**
**Honesty rule: token counts are a bytes-over-four estimate, not a real tokenizer. Say
"estimated" every time you quote one; never present it as an exact figure.**

## Step 1 — Inventory

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gardener.mjs" --audit --repo "<repo>" --md
```

Default `--repo` is the current directory. Read
`${CLAUDE_PLUGIN_ROOT}/skills/audit/references/checks.md` before triaging — it explains what
each check means and when it is safe to ignore.

The report resolves `@path` imports transitively, so the file list is what actually loads —
not what the top-level file appears to say. A file marked ⚠ failed to resolve.

## Step 2 — Read the cost table first

The findings matter less than the first table. Three questions, in order:

1. **What is the total?** Under ~4k estimated tokens is comfortable. Past ~8k the agent
   starts every request with a large fraction of its attention already spent.
2. **Which file dominates?** Usually one file is 70–90% of the total. That is where the
   work is; everything else is rounding.
3. **Is anything loading that you forgot about?** Import chains are the usual surprise — a
   global file pulling in three others that pull in more.

Quote the numbers with their unit and the word "estimated". A user who trusts an exact
figure will be misled the first time they compare it with a real token count.

## Step 3 — Triage the findings

- **broken-import** — always real, and the worst kind of silent failure: you believe a set
  of rules is loaded and it is not. Fix first.
- **hot-file-oversized / hot-budget-exceeded** — real but not urgent in the way a bug is.
  Treat as a standing debt and point at `/gardener:prune` for the actual plan.
- **stale-path** — a rule pointing at a file that is gone. Check whether the file moved
  before deleting the rule; path resolution already searches the repo, so a hit here
  usually means the file really is missing.
- **duplicate-directive** — read both texts. Identical wording in two files is dead weight;
  near-identical wording with different scope is a contradiction waiting to happen. Say
  which one you would keep and why.
- **vague-directive** — only worth raising when the user is actively editing that file.

## Step 4 — Answer the question behind the question

"Why does my agent ignore instructions?" is the reason people run this. If the total is
large, say so plainly and name the mechanism: a rule competing with several thousand tokens
of other rules gets less weight than one of twenty. That is the honest answer, and it is
more useful than a list of checks.

If the context is small and clean, say that too — then the problem is the wording of a
specific rule, not the size of the file, and `/gardener:compliance` is the next step.

## Step 5 — Reply

Under 10 lines: total estimated cost and how it splits, the one file that dominates, any
broken import, the two or three findings worth acting on, and one pointer —
`/gardener:prune` for a removal plan, `/gardener:compliance` to check whether the rules are
being followed at all. Save a full report to
`~/.agentlens/gardener/audit-<YYYY-MM-DD>.md` (expand the home directory yourself; never
pass a literal `~` to the script) only when the user wants a document.
