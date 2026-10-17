# Paste to Denon (Telegram)

Copy the block below. Short high-signal version (2026-07-27).

---

```
Hey — quick alignment on how we ship so we stay fast.

Repo rules stay as in CONTRIBUTING / AGENTS.md. The one habit that matters with both of us + AIs: always work in a worktree (pnpm wt …), open the agent in that folder, never edit the main checkout. Branch → PR → squash-merge; green CI before merge.

Review (so we don’t block each other):
• Your PRs — merge when CI is green. Have your agent self-check doctrine/money + pnpm verify and note it on the PR. No need to wait on my Approve (I’m not the code reviewer).
• My PRs — you or your agent review, then merge. My agents will open PRs for me; I won’t be driving git by hand.

When you start something multi-hour, one-line claim in Telegram + tracker so we don’t both build the same thing.

If anything in those docs is slowing you down, say so and we’ll cut it.
```
