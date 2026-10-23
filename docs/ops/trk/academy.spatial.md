# TRK-academy.spatial — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.spatial`  
**Title:** 2D navigable room canvas, VR-ready scene state  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `academy.lobbies` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Users navigate a **2D room canvas** bound to lobby session scene state.
2. Scene state is serializable, durable, and VR-ready per §8.3 (not a one-off DOM toy).
3. Hosts can update scene without breaking seat/presence invariants.
4. Works with stream provider **none** — no fake SFU credentials.
5. Shell consumes scene API honestly when A/V is refused.

---

## 2 · Current code state (tip)

### 2.1 Lobbies spine (dependency done)

| Area          | Reality                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| Service       | `svc-academy` · `/api/academy`                                                    |
| Scene field   | Sessions carry serializable jsonb `scene`                                         |
| Schema        | `db/schema.ts` — scene as §8.3 2D spatial layer                                   |
| Stream        | `ACADEMY_STREAM_PROVIDER=none` → `NullStreamProvider` **refuses** join credential |
| Non-custodial | No LEDGER_URL                                                                     |

### 2.2 Spatial product residual

| Area                         | Reality                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| Full 2D navigable canvas UI  | **Residual** (state exists; product canvas not title-complete) |
| VR client                    | Residual                                                       |
| Scene schema versioning      | Residual                                                       |
| Concurrent scene edit policy | Re-verify at implement                                         |

### 2.3 Already true

Seats, presence, capacity, host rights work without SFU. Scene is server field, not only localStorage.

---

## 3 · Doctrine constraints

| Law                       | Implication                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| §8.3 VR-ready 2D          | Version scene shape; don’t paint WebGL demo as Done without contract |
| No fabricated credentials | Stream none refuses — spatial must not depend on fake A/V            |
| PII in scene              | Don’t store secrets/PII in scene JSON                                |
| Tracing                   | No scene contents in spans                                           |
| Brand                     | UI chrome vendor-clean                                               |
| No dual-edit              | Open academy lobby PRs                                               |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — scene contract

- [ ] Documented scene schema (version field, allowed keys).
- [ ] Host updateScene API tests + attendee read.
- [ ] Reject oversized / invalid payloads.

### Stage 2 — 2D canvas product

- [ ] Shell canvas navigates from server scene.
- [ ] Reconnect restores server scene.
- [ ] Works with stream provider none.

### Stage 3 — VR-ready

- [ ] Scene export for VR adapter (§13 if external).
- [ ] Performance budget documented.

### Tracker `done` bar

Flip only when navigable canvas product uses server scene — jsonb column alone is not the title.

---

## 5 · Open questions

1. Host authoring templates?
2. Max scene size / rate limits?
3. Spectator-only spatial mode?
4. Link curriculum objects into scene?

---

## 6 · Gaps (named)

1. Full canvas UI residual.
2. Scene schema productization residual.
3. VR client residual.
4. Concurrent edit policy residual.
5. Shell integration residual.

---

## 7 · Risks

| Risk                  | Why it hurts             |
| --------------------- | ------------------------ |
| Client-only scene     | Desync / lost room state |
| PII in scene          | Privacy incident         |
| Depending on fake SFU | Credential lie           |
| Unbounded scene JSON  | DoS                      |

---

## 8 · Estimated size

| Slice                        | Size    |
| ---------------------------- | ------- |
| Schema contract + API polish | **S–M** |
| Canvas UI                    | **L**   |
| VR adapter                   | **L**   |

**First implement PR (when free):** **S–M** — versioned scene schema + tests; UI follow-on.

---

## 9 · Related docs / code

- `services/svc-academy` schema scene, stream provider
- Tracker `academy.lobbies` note
- Doctrine §8.3

---

## 10 · Explicit non-goals for this pack

- No fabricating stream join credentials.
- No money in scene state.
- No `features.mjs` edit.
