# Board Clear — Parallel sessions & collision wall

**Binding.** Multiple agent chats, Denon, and shehzad may push the same day.  
**Goal:** Board Clear still AFK-ships without dual-build, stale tip, or vibe thrash.

---

## 1 · Sources of parallel work (expect these)

| Actor                                 | Typical paths                                                             | Rule for Board Clear agent                                                               |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **This Board Clear GO**               | P-UI vendor shell, P-TRADE-LIGHT mm/spot/venue, P-WS, P-P5-LIGHT, P-TRACK | Claim LIVE-LANES program; PATHS_ONLY                                                     |
| **Other Nitro agent chats**           | Same agent programs if unclaimed                                          | **First claimer wins** on LIVE-LANES; second chat must pick free program or stop         |
| **Frontend / Stream A / app density** | `apps/**`, sometimes vendor shell                                         | Prefer **not** dual-edit vendor same files; if must, rebase often + small PRs            |
| **Order-route residual**              | `services/svc-trade` chaos/seed/scans, vendor Java doors                  | **Do not** open overlapping trade files without claim; order-route open PRs = coordinate |
| **@shehzad002**                       | pay, protocol, futures risk, otc/copy/algo, bank, identity money, Java M7 | **Babysit only** — never implement                                                       |
| **@Phantom-X-007 (Denon)**            | spine, specs, direction PRs                                               | Never force-push his branches; don’t steal open PR                                       |

---

## 2 · Pre-code collision ritual (every ship, every continue)

```
1. git fetch origin main
2. TIP=$(git log origin/main -1 --oneline)  → write into BOARD-CLEAR-NEXT.md “Tip when last acted”
3. gh pr list --state open
4. For EXACT NEXT ship PATHS_ONLY:
     - list open PRs whose files intersect (gh pr diff / gh pr view --json files)
     - if intersection with non-Board-Clear owner → skip ship, pick next non-overlapping agent residual
     - if intersection with another Board Clear PR → babysit that PR first; no second PR on same paths
5. LIVE-LANES: ensure program row is AGENT and not dual-claimed this session
6. Product ownership (COORDINATION-TRUTH-LAYERS): if mountain is human-owned / shehzad002 / not free → babysit only; never invent free
7. Only then worktree from origin/main tip
```

**Fail = dual-build** = two live PRs editing the same path without one closing.  
**Fail = wrong-mountain** = implement on tracker/LIVE-LANES human lock.

---

## 3 · Tip freshness (anti-stale)

| Rule                                          | Detail                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Never code on yesterday’s main                | Always branch/rebase from **current** `origin/main`                            |
| NEXT must carry tip                           | Field `Tip when last acted: <sha> <subject>`                                   |
| After **any** merge to main (yours or others) | Refresh NEXT open-PR table + tip line **before** next ship                     |
| Scoreboard lag OK short                       | NEXT exact ship is authority for “do now”; scoreboard same turn as your merges |

---

## 4 · LIVE-LANES multi-chat claim protocol

When starting a Board Clear ship:

1. Read `docs/LIVE-LANES.md`
2. If program free → set Owner session to **this chat id/label** + Status RUNNING (docs PR or same-ship PR ok)
3. If already RUNNING under another session → **do not code**; pick free program or babysit only
4. On ship merge/stop → free or leave AGENT as appropriate

Chat labels can be short: `board-clear-go-grok-1`, `board-clear-continue-2`.

---

## 5 · What to do when blocked by parallel work

| Situation                              | Action                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Open PR already covers your EXACT NEXT | Babysit to green merge; advance NEXT                                    |
| Foreign PR conflicts mid-rebase        | Prefer their tip if merged; re-apply your slice; no invent              |
| CI thrash from push storms             | Local verify first; one push per green local                            |
| Cannot claim any agent path            | PHASE B polish on non-overlapping docs/tests OR babysit #346-class only |

Never: invent to bypass; never steal H-\*; never empty NEXT.

---

## 6 · Continue / compact (unchanged AFK)

- Compact → agent opens NEXT only → run §2 ritual → continue
- Nitro never re-pastes mid-run
- Process death → host must re-launch (optional scheduler)

---

## 7 · Quality still outranks speed

Parallel pressure is **not** a license for vibe-green, invent mid, or Class M without failure tests.  
Engineering standard + L8 still bind.
