# TRK-blueprint.card — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `blueprint.card`  
**Title:** Share card render (1080×1350, 1200×630)  
**Module / phase:** `blueprint` · phase **4** · plane **F**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `blueprint.onboarding` (**done**)  
**Requires:** `services/svc-blueprint`  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no taste-only compose rewrites; no invent PNG host; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Share cards at **both** §7.2 canvases (1080×1350 and 1200×630) with **deterministic** SVG compose from profile + crew.
2. Optional **PNG rail** via `BLUEPRINT_CARD_RENDERER_URL` when configured; honest residual when not (`unavailable` data, never a fabricated asset URL).
3. Self-only (`blueprint:read`) — no other-user card render.
4. Card carries **zero personal data** by default (no name, id, or date) — safe to share; asserted in tests.
5. Palette-only colors from UI tokens; off-palette hex fails compose.
6. Export package includes card composition (§7.2 schemaVersion 2) — already true when SVG path ships.

---

## 2 · Current code state (tip)

### 2.1 Composition — done on tip

| Area      | Path / fact                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose   | `services/svc-blueprint/src/card/compose.ts` — pure function profile+crew → SVG                                                                            |
| Tests     | `compose.test.ts` — both canvases as literals (width/height **and** matching viewBox), determinism, in-canvas bounds, tag balance, palette fail on bad hex |
| Mount     | `blueprint.card` procedure — `blueprint:read`, self-only                                                                                                   |
| Export    | §7.2 export carries card (schemaVersion 2)                                                                                                                 |
| Copy-scan | §7.2 copy-scan runs on **rendered output** (not only source) across allowed profile values + negative control                                              |
| Zero PII  | Asserted — no name/id/date on card                                                                                                                         |

### 2.2 PNG rail — residual (blocks full title “→ PNG”)

| Area              | Path / fact                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Adapter (§0.4)    | `CardRenderer` interface in `card-renderer.ts`                                                           |
| Unconfigured boot | `UnconfiguredCardRenderer` without `BLUEPRINT_CARD_RENDERER_URL`                                         |
| Honest data       | Returns `{ status: "unavailable", code: "blueprint.card_renderer_unconfigured" }` as **data**, not throw |
| HTTP renderer     | `http-renderer.ts` — every failure path tested to return `unavailable` and **NEVER** a URL               |
| Why never a URL   | Fabricated asset URL becomes og:image → broken unfurl on someone else’s timeline                         |
| Done condition    | Rasterizer + object storage exist and real PNG URL lands in `card_asset_url`                             |

### 2.3 Tracker honesty

Tracker note is **largely accurate**: composition done; PNG half is the residual. Status remains `ready` until raster rail exists **or** product explicitly accepts SVG-only as mountain done (would need mountain event).

---

## 3 · Doctrine constraints

| Law           | Implication                                                  |
| ------------- | ------------------------------------------------------------ |
| §7.1 / §7.2   | Share card canvases + export (JSON + card)                   |
| §0.4 adapters | Renderer is a socketed adapter; unconfigured is a typed path |
| Brand palette | Fail off-palette hex (`packages/ui` tokens)                  |
| §19 / PII     | Card content safe to share; default zero personal data       |
| Self-only     | No other-user card; scopes enforce                           |
| Brand §0.7    | No partner/vendor names on card art                          |

---

## 4 · Dependency honesty

- **`blueprint.onboarding` done** — profile exists to compose.
- **`blueprint.ownership` export** includes card composition already; ownership cascade residual is separate.
- **Not Shehzad** — pure blueprint plane.
- **Ops residual:** who runs rasterizer host (no brand leak, no open arbitrary-text renderer without product call).

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — SVG path (largely true on tip)

- [x] Both canvases deterministic + palette + zero PII asserted
- [x] Mounted self-only procedure
- [x] Export includes card
- [ ] Product explicitly: “SVG enough for share” **or** continue to Stage 2

### Stage 2 — PNG rail (ops + adapter)

- [ ] Deploy rasterizer + object storage (Class X / ops if public)
- [ ] Set `BLUEPRINT_CARD_RENDERER_URL` in staging; prove real `card_asset_url`
- [ ] Failure paths still never invent URLs
- [ ] OWNER call: may user-supplied display name appear? (makes public renderer of arbitrary text in our branding)

### Tracker `done` bar

Flip when Stage 1 accepted as complete product **or** Stage 2 PNG proven. Do not flip on unconfigured renderer + SVG alone unless product writes that acceptance.

---

## 6 · Gaps (named)

1. No rasterizer / object storage in monorepo default ops.
2. `card_asset_url` never real without env.
3. Display-name-on-card product call outstanding.
4. OG/social integration owner unclear (shell vs blueprint).
5. No separate `TRK-blueprint.card.md` solid sister — this pack is the long form.

---

## 7 · Risks

| Risk                                  | Why it hurts                        |
| ------------------------------------- | ----------------------------------- |
| Fabricated PNG URL                    | Broken og:image off-platform        |
| Off-palette / brand-break art         | Brand law fail                      |
| PII on shared card                    | Privacy + §19 adjacency             |
| Taste-only compose rewrites           | Unbounded residual / no product ask |
| Open text renderer without moderation | Abuse / brand incident              |

---

## 8 · Estimated size

| Slice                 | Size       | Notes                   |
| --------------------- | ---------- | ----------------------- |
| SVG path              | **—**      | Largely done            |
| PNG rail ops + wire   | **S–M**    | Env + host + proof      |
| Display-name product  | **XS** law | Owner call only         |
| Social OG integration | **S–M**    | After PNG or SVG policy |

**First implement PR (when free):** product decision first — if SVG enough, honesty mountain event; if PNG required, **S** staging renderer + env + proof tests. No compose taste rewrites without product ask.

**Human blockers:** raster host / object storage; display-name product call; not blocked by money spine.

---

## 9 · Related docs / code

- `services/svc-blueprint/src/card/compose.ts` · `compose.test.ts`
- `services/svc-blueprint/src/card/card-renderer.ts` · `http-renderer.ts` · `renderer.test.ts`
- Tracker note in `tooling/tracker/features.mjs` (`blueprint.card`)
- Doctrine §7.1 / §7.2
- Related: `blueprint.ownership` export inclusion

---

## 10 · Explicit non-goals for this pack

- No taste-only compose rewrites without product ask.
- No inventing PNG URLs when renderer unconfigured.
- No features.mjs `done` from research alone.
- No other-user card APIs.
- No brand-break hex or partner logos on cards.
