# 02-FINDINGS — L0 + money/auth (residual wave #229–#238)

## L0 machine truth (this tip, local)

| Gate         | Command                                    | Result                                            |
| ------------ | ------------------------------------------ | ------------------------------------------------- |
| Brand        | `node tooling/ci/brand-scan.mjs`           | **PASS** — 721 files, 0 forbidden names           |
| Custody      | `node tooling/ci/custody-scan.mjs`         | **PASS** — 95 files / 3 Protocol Plane services   |
| Vendor shell | `node tooling/ci/vendor-shell-scan.mjs`    | **PASS** — 1105 vendor files, 9 hazard patterns   |
| Tracker      | `node tooling/scripts/tracker.mjs --check` | **PASS** — docs/TRACKER.md + README.md up to date |

**Not run this fire (delta-scoped WAVE-AUDIT, not full verify):** full `pnpm verify` (build/typecheck/test/format). Product CI on post-#238 tip `46d688e` was **Actions SUCCESS** on main.

## Layer notes on delta only

### L1 doctrine / money law

- No new ledger recipes, no balance held outside ledger, no money-as-`number` surfaces in service code this wave.
- #234 **improves** vendor custody hygiene (dead mutators gone + scan in DoD).

### L2 auth / ownership

- **#229 cascade HOLDS pattern:**
  - set on `blueprintCreated` by `userId`
  - clear on `blueprintDeleted` **only if** `profiles.blueprint_id` still equals deleted id (match-guard)
  - no cross-service SQL from svc-blueprint
  - durable JetStream + idempotent consumers (per PR claim; unit test present)
- Tracker marks `blueprint.ownership` **done** with identity requirement — consistent with code path.

### L3 money paths

- **No new claim/post/convert/stake/mint/pay service paths** in merged delta.
- Stream A money panes (#235/#236) are **display honesty only** — correct residual: real withdraw/rail still sandbox or Class M open (#226).
- #236 **closed a false-done UX risk** (hard-coded C2C quote/balance) without inventing new product balances.

### L4 dual-book / plane

- UI dual-book banners (#231/#232/#235) are **honesty affordances**, not ADR close.
- **Dual-book ADR still human** — residual unchanged.

### L5–L7 edge / mount / WS

- Not touched in merged #229–#238.
- Open #227 is WS positions — **not in this verdict as merged**.

### L8 tracker honesty

- #230 + cascade done notes align with residual ownership session.
- launch/indexer remain **ready** (not false done) — HOLDS.

### L9 vendor

- Shell only for Stream A; #234 removes dead wallet mutators and locks scan.
- Vendor remains **UI shell · quarantined as ledger** (PEACE scoreboard unchanged).

## Money / auth residuals (still open — not closed by this wave)

1. **#226 Class M** — live EVM crypto rail open; CI green; **Nitro must not merge**; Denon money self-audit then author/Denon.
2. **Dual-book ADR** — human / owner policy discipline.
3. **Secrets / wallet keystore / disclosed rotation** — owner ops.
4. **Pay rails sandbox** residual until real rails (and until #226 reviewed).
5. **Market sell CCXT `cost`**, sub-account ownership S2S, Stream A PROOF — prior PEACE residuals, not re-proved this fire.
6. **Money e2e / PG suites** — still environment-dependent; not claimed green here.

## False-done check (this wave)

| Claim risk            | Check                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Cascade "done"        | Code + match-guard + test files present on tip — **not** docs-only                          |
| OTC/C2C empty honesty | Fake merchant / 7.00 / 21212 removed per PR paths — UI residual closed for those inventions |
| Vendor wallet safe    | Dead mutators deleted; scan would fail if reintroduced                                      |
| Dual-book "solved"    | **Must not claim** — banners only                                                           |
| Live pay ready        | **Must not claim** — #226 open Class M                                                      |
| Go-live               | **Must not claim**                                                                          |

## Adversarial posture (maker-checker)

- Delta is majority Class N UI honesty + one identity cascade + one CI hygiene PR.
- **No new agent-fixable P0 found** on merged paths.
- Highest live risk remains **outside** the merged set: open **#226** Class M — critic/self-audit is **Denon’s**, not this archive’s implementer.
- Partial overnight audit already named cascade residual closed by #229 — reconfirmed on tip.
