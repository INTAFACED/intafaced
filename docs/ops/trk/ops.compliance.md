# TRK-ops.compliance — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.compliance`  
**Title:** Screening queues, geo-block, VPN/Tor detection  
**Module / phase:** `core-ops` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `identity.kyc`  
**Tip freeze:** `origin/main` @ `56696496` (re-derive before implement)  
**Pack type:** research only — **list content is Class X** (counsel/human); mechanism can ship empty-safe.

---

## 1 · What “done” means (plain language)

1. Operators have **queues** for screening hits / review — not only a silent config flag.
2. Geo-block and access decisions use **configured** lists with honest “list not configured” status (never pretend screened-clean when empty).
3. VPN/Tor detection if titled is either real signal or explicit residual — no fake certainty.
4. KYC dependency respected: identity tier gates compose with screening.
5. Denon screening authority work path-checked before dual-edit.

---

## 2 · Current code state (tip)

### 2.1 Mechanism already strong (packages/config)

| Piece                | Path                                    | Honesty                            |
| -------------------- | --------------------------------------- | ---------------------------------- |
| Screening list parse | `packages/config/src/screening.ts`      | Empty list ≠ clean bill of health  |
| Access check         | `checkAccess` + `screeningStatus`       | Surfaces `listConfigured` / counts |
| Tests                | `packages/config/src/screening.test.ts` | Empty vs populated distinctions    |

Law already encoded: “we checked and you are clean” vs “we have never had a list” must not look the same.

### 2.2 Edge / region

- Edge and module access use config screening; Denon open PRs historically touch screening/env (**#432** CONFLICTING, **#448** etc.) — **babysit only**.
- Permissionless dex short-circuit still runs **region screening first** (ordering §24).

### 2.3 What title still lacks

| Gap                    | Reality                                        |
| ---------------------- | ---------------------------------------------- |
| Operator **queues** UI | Not a full case-management product on tip      |
| VPN/Tor detection      | Not proven as a complete titled capability     |
| List **content**       | Class X — agents do not author sanctions lists |

---

## 3 · Doctrine constraints

| Law          | Implication                                       |
| ------------ | ------------------------------------------------- |
| Class X      | Sanctions/geo **content** = Nitro human + counsel |
| Empty-safe   | Unconfigured list must not claim full screen      |
| No dual-edit | Denon #432/#448 screening/secret paths            |
| KYC          | Depends on `identity.kyc` for full queue story    |

---

## 4 · DoD sketch (checkable — staged)

### Slice A — honesty residual

- [x] Operator-visible screening status (configured vs empty) in admin / edge status
- [x] Tests already in config — wire display without inventing lists
- [x] **D26-P1-O1:** request-time refuse when list unset (`INTAFACED_SCREENING_FAIL_CLOSED` → `denied.screening_unconfigured`); default OFF; no Class X content

### Slice B — queues

- [x] Case queue mechanism + disposition (partner_cleared refuses without partner) — durable UI/DB residual
- [x] Freeze/allow decisions do not invent KYC tier

### Slice C — VPN/Tor (if kept in title)

- [x] Signal source named; fail-open vs fail-closed law (`network-signal.ts`)
- [ ] Partner procurement / real feed — Class X residual

---

## 5 · Open questions

1. Who supplies production list files (ops vs counsel pipeline)?
2. Queue in `apps/admin` vs separate case tool?
3. Wait for Denon #432 merge before edge dual paths?

---

## 6 · Estimated size

| Slice             | Size                    |
| ----------------- | ----------------------- |
| Status surfacing  | **S**                   |
| Full queues + VPN | **L** + Class X content |

---

## 7 · Related docs / code

- `packages/config/src/screening.ts` · `screening.test.ts`
- Denon babysit: #432 edge/screening, #448 secret map
- Long-form twin: [TRK-ops.compliance.md](./TRK-ops.compliance.md)

---

## 8 · Explicit non-goals

- No inventing sanctions list content.
- No dual-edit Denon screening PRs.
- No claiming empty screening as full compliance done.

---

## 9 · Partner collision map (re-derive)

| PR   | Relevance                   | Agent action           |
| ---- | --------------------------- | ---------------------- |
| #432 | screening/edge env          | babysit · no dual-edit |
| #448 | secret blast radius / gates | babysit                |
| #436 | launch flags vs traffic     | babysit                |

Implement queues only on path-clean tips after re-freeze.

## 10 · First PR shape (mechanism only)

| PR  | Scope                                                 |
| --- | ----------------------------------------------------- |
| 1   | Admin screening status panel (listConfigured honesty) |
| 2   | Queue schema + audit (no list content)                |
| 3   | VPN/Tor decision or title narrow                      |

Class X list files stay human-supplied.
