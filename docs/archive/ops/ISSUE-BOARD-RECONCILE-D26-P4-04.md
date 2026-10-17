# Issue board reconcile — D26-P4-04

**Board item:** D26-P4-04, [`DENON-HARD-PARALLEL-BOARD-2026-08-09.md`](../DENON-HARD-PARALLEL-BOARD-2026-08-09.md) §8 — _close shipped stubs; link issue → ADR → tracker._
**Lane:** `denon-d26-p4-04-issue-reconcile` (this row only).
**Tip at write:** `1723273b` (`origin/main`). Re-derive before acting again.
**Census:** `gh` / GitHub MCP `list_issues` on `Phantom-X-007/intafaced` — **35 open**, **0 previously closed**. AXIS A5 (`docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md`) already named the write-only board; this pass is the table, not a mass-close script.

## 0 · Rules used

- Close **only** generated tracker stubs whose mountain is tracker `done` **and** a **merged** PR unambiguously shipped that mountain.
- Do **not** close because AXIS guessed “eight”; do **not** close `ready` / `wip` / `socket` rows.
- Do **not** close Class X, Shehzad / `protocol-plane`, or human-decision issues.
- Do **not** edit `features.mjs` (P4-09).
- GitHub never used `Closes #N` on these stubs (`closed_by_pull_requests.total_count` was 0 on sampled issues). Proof is the merge record, not an auto-close link.

## 1 · Counts (this pass)

| Bucket                                                       | Count                           | Action                              |
| ------------------------------------------------------------ | ------------------------------- | ----------------------------------- |
| **Shipped — closed with proof PR**                           | **9**                           | Comment + `state_reason: completed` |
| **Still open** (real residual / not tracker-done)            | **12**                          | Left open                           |
| **Left alone** (Shehzad / protocol-plane / Class X-adjacent) | **14**                          | No close, no spam comment           |
| **Duplicate (noted, not closed)**                            | 2 GitHub overlaps, both Shehzad | See §4                              |
| **Open after this pass**                                     | **26**                          | 12 + 14                             |

## 2 · Closed — shipped stubs (proof PR)

All nine were generated from `tooling/tracker/features.mjs` on 2026-07-27. Tracker row is `done`. Spec pack under `docs/ops/trk/` where one exists.

| Issue                                                       | Tracker                | Proof merged PR                                                                                                                                                                                                                       | ADR / spec                                                                                                  | Closed |
| ----------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| [#5](https://github.com/Phantom-X-007/intafaced/issues/5)   | `identity.webauthn`    | [#93](https://github.com/Phantom-X-007/intafaced/pull/93) (merged 2026-07-29)                                                                                                                                                         | Law §9; tracker note names #93                                                                              | yes    |
| [#7](https://github.com/Phantom-X-007/intafaced/issues/7)   | `matching.engine`      | [#26](https://github.com/Phantom-X-007/intafaced/pull/26) (merged 2026-07-27)                                                                                                                                                         | [`2026-08-04-matching-dual-target.md`](../adr/2026-08-04-matching-dual-target.md)                           | yes    |
| [#8](https://github.com/Phantom-X-007/intafaced/issues/8)   | `web.shell`            | [#757](https://github.com/Phantom-X-007/intafaced/pull/757) deletes the `apps/web` scaffold the stub named; [#741](https://github.com/Phantom-X-007/intafaced/pull/741) / [#754](https://github.com/Phantom-X-007/intafaced/pull/754) | [`2026-08-03-retire-apps-web-port-to-vue-shell.md`](../adr/2026-08-03-retire-apps-web-port-to-vue-shell.md) | yes    |
| [#10](https://github.com/Phantom-X-007/intafaced/issues/10) | `p2p.offers`           | [#33](https://github.com/Phantom-X-007/intafaced/pull/33) (merged 2026-07-27)                                                                                                                                                         | [`2026-08-04-p2p-escrow-and-dispute-law.md`](../adr/2026-08-04-p2p-escrow-and-dispute-law.md)               | yes    |
| [#12](https://github.com/Phantom-X-007/intafaced/issues/12) | `blueprint.onboarding` | [#36](https://github.com/Phantom-X-007/intafaced/pull/36) (merged 2026-07-27)                                                                                                                                                         | `docs/ops/trk/blueprint.*`                                                                                  | yes    |
| [#13](https://github.com/Phantom-X-007/intafaced/issues/13) | `bank.accounts`        | [#35](https://github.com/Phantom-X-007/intafaced/pull/35) (merged 2026-07-27)                                                                                                                                                         | [`2026-08-04-bank-vertical-law.md`](../adr/2026-08-04-bank-vertical-law.md)                                 | yes    |
| [#14](https://github.com/Phantom-X-007/intafaced/issues/14) | `agents.gateway`       | [#34](https://github.com/Phantom-X-007/intafaced/pull/34) (merged 2026-07-27)                                                                                                                                                         | tracker note: reference mount                                                                               | yes    |
| [#15](https://github.com/Phantom-X-007/intafaced/issues/15) | `academy.lobbies`      | [#208](https://github.com/Phantom-X-007/intafaced/pull/208) (merged 2026-07-30)                                                                                                                                                       | `docs/ops/trk/` academy; SFU remains `socket.stream-provider`                                               | yes    |
| [#16](https://github.com/Phantom-X-007/intafaced/issues/16) | `market.vendors`       | [#1109](https://github.com/Phantom-X-007/intafaced/pull/1109) · [#1115](https://github.com/Phantom-X-007/intafaced/pull/1115) · [#1126](https://github.com/Phantom-X-007/intafaced/pull/1126)                                         | `docs/ops/trk/market.vendors.md` / `TRK-market.vendors.md`                                                  | yes    |

#8’s title still says “apps/web scaffold”. That path was deleted on purpose. Closing the stub does **not** reopen Vue craft (`nitro-frontend-all`).

## 3 · Still open — not tracker-done (or not a stub we can prove shipped)

| Issue                                                         | Tracker / topic        | Status       | ADR / spec                                                                                                                                                                | Why not closed                                                                                                                                                      |
| ------------------------------------------------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#4](https://github.com/Phantom-X-007/intafaced/issues/4)     | `infra.i18n`           | `ready`      | `docs/ops/trk/infra.i18n.md`                                                                                                                                              | Not `done`. Shell i18n is HUMAN Vue.                                                                                                                                |
| [#6](https://github.com/Phantom-X-007/intafaced/issues/6)     | `token.governance`     | `socket`     | [`2026-08-04-token-economics-outcomes.md`](../adr/2026-08-04-token-economics-outcomes.md)                                                                                 | Ballot exists; outcome/quorum not built.                                                                                                                            |
| [#9](https://github.com/Phantom-X-007/intafaced/issues/9)     | `pay.gateway`          | `ready`      | [`2026-08-04-pay-rails-and-psp-socket.md`](../adr/2026-08-04-pay-rails-and-psp-socket.md) · [`2026-08-07-pay-public-api-law.md`](../adr/2026-08-07-pay-public-api-law.md) | Live acquirer / KYB grant still residual.                                                                                                                           |
| [#18](https://github.com/Phantom-X-007/intafaced/issues/18)   | `ops.support`          | `ready`      | `docs/ops/trk/ops.support.md`                                                                                                                                             | #1494 landed desk proofs; row still not `done` (no real-env loop / Vue).                                                                                            |
| [#19](https://github.com/Phantom-X-007/intafaced/issues/19)   | `ops.affiliates`       | `wip` Denon  | `docs/ops/trk/ops.affiliates.md`                                                                                                                                          | Rates + producer wire residual (D26-P1-O2).                                                                                                                         |
| [#20](https://github.com/Phantom-X-007/intafaced/issues/20)   | `ops.compliance`       | `wip`        | `docs/ops/trk/ops.compliance.md`                                                                                                                                          | Sanctions **content** is Class X.                                                                                                                                   |
| [#21](https://github.com/Phantom-X-007/intafaced/issues/21)   | `ops.analytics`        | `wip` Denon  | [`2026-08-07-ops-analytics-warehouse-read-replica.md`](../adr/2026-08-07-ops-analytics-warehouse-read-replica.md)                                                         | Warehouse/cubes not production-live.                                                                                                                                |
| [#22](https://github.com/Phantom-X-007/intafaced/issues/22)   | `ops.admin`            | `ready`      | `docs/ops/trk/ops.admin.md`                                                                                                                                               | Console residual + Class X SSO; Vue HUMAN.                                                                                                                          |
| [#23](https://github.com/Phantom-X-007/intafaced/issues/23)   | `ops.notifications`    | `ready`      | `docs/ops/trk/ops.notifications.md`                                                                                                                                       | Fan-out vs §13 channels still a mountain.                                                                                                                           |
| [#83](https://github.com/Phantom-X-007/intafaced/issues/83)   | Stream A claim         | coordination | `docs/NITRO-STREAM-A-CLAIM.md` · LIVE-LANES `nitro-frontend-all`                                                                                                          | Checklist still open (S2 prices, visual sign-off). Not a tracker stub.                                                                                              |
| [#109](https://github.com/Phantom-X-007/intafaced/issues/109) | S2 market history seed | open need    | `docs/STREAM-A-PHASE1-PLAN.md`                                                                                                                                            | No merged PR that seeds honest non-zero history.                                                                                                                    |
| [#197](https://github.com/Phantom-X-007/intafaced/issues/197) | CI billing decision    | human        | retired spend-control docs; public-repo Actions law in `AGENTS.md`                                                                                                        | **Premise obsolete** (repo public; hosted Actions free). Left open — owner billing issue, not an agent-completed stub. Candidate for Denon to close as not-planned. |

## 4 · Left alone — Shehzad / protocol-plane

Do not close. Agents babysit only. Handshake ADR: [`2026-08-08-protocol-plane-p0-handshake-and-rails.md`](../adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md). Board: `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`.

| Issue                                                                                                                                                                                      | Tracker / topic           | Note                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------- |
| [#11](https://github.com/Phantom-X-007/intafaced/issues/11)                                                                                                                                | `protocol.smart-accounts` | `owner: shehzad002`. Overlaps **#927** Tier A (duplicate **noted**, not closed). |
| [#17](https://github.com/Phantom-X-007/intafaced/issues/17)                                                                                                                                | `mining.pool`             | Shehzad. Overlaps **#934** Tier H (duplicate **noted**, not closed).             |
| [#927](https://github.com/Phantom-X-007/intafaced/issues/927)–[#937](https://github.com/Phantom-X-007/intafaced/issues/937), [#956](https://github.com/Phantom-X-007/intafaced/issues/956) | chain Tiers A–L           | Label `protocol-plane`. 12 issues.                                               |

## 5 · What this pass did not do

- No `features.mjs` status flips (P4-09).
- No close of #18 despite #1494 — tracker still `ready`.
- No auto-reconciler script (AXIS A5 item 4). A script that closes on tracker `done` without a merge SHA would have been the spam-close this mountain forbids.
- No comments on the 26 issues left open.

## 6 · Leverage

Existing GitHub issue stubs + tracker registry + ADRs + merged PR records. No second issue tracker, no Vue, no `svc-edge` edit.
