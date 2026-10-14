# Preview: products that are not live yet

A **Preview** product is shown in full, with **clearly labelled sample data**, and sends nothing. This folder is the one shared place for the
chip, the caption, the "nothing was sent" sheet and the sample data. Read it before you build or change a Preview screen.

Decided by the founder: every product is shown. Anything not live carries a small "Preview" label and is never mixed with real data.

## The three registry states

`apps/customer/src/app/feature-registry.ts` gives every feature one of three states:

| State     | Meaning                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `live`    | Real screen, real data.                                                                                         |
| `preview` | Sample-data screen from this folder. Reachable, with the Preview chip, **only while the build flag allows it**. |
| `hidden`  | Not linked anywhere. A customer build redirects it to its tab home.                                             |

**Build flag `VITE_PREVIEW_PRODUCTS`** (`isPreviewEnabled()` in the registry):

- `1`: Preview is on (staging builds set this).
- `0` or anything else: Preview is off.
- Unset: on for `vite dev` and the local test stack build (`VITE_LOCAL_TEST=1`); **off in every other build**, so production never shows Preview unless the founder decides at launch.

With the flag off a `preview` row behaves exactly like a `hidden` one (menus drop it, search drops it, the path redirects). Use
`isPreviewPath(path)` / `previewFeatureFor(path)` to ask "is this a Preview screen right now", and never read `feature.status` directly for
navigation (use `effectiveStatus`).

## Routes and screens

Every Preview product lives at **`/preview/<id>`**. Each has a registry row (same id), a room (route) and a lazily loaded screen folder. An older address (for example `/trade/futures`) is an alias room that redirects to the `/preview/<id>` route; it is part of the same registry row, so it is hidden together with it.

| Product id | Route (link here)   | Older address (redirects) | Screen folder (you own it)  | Menu  |
| ---------- | ------------------- | ------------------------- | --------------------------- | ----- |
| `futures`  | `/preview/futures`  | `/trade/futures`          | `screens/preview/futures/`  | Trade |
| `options`  | `/preview/options`  | `/trade/options`          | `screens/preview/options/`  | Trade |
| `margin`   | `/preview/margin`   | `/trade/margin`           | `screens/preview/margin/`   | Trade |
| `copy`     | `/preview/copy`     | `/trade/copy`             | `screens/preview/copy/`     | Trade |
| `bots`     | `/preview/bots`     | `/trade/bots`             | `screens/preview/bots/`     | Trade |
| `agents`   | `/preview/agents`   | `/agents`                 | `screens/preview/agents/`   | Trade |
| `p2p`      | `/preview/p2p`      | `/p2p`                    | `screens/preview/p2p/`      | Trade |
| `earn`     | `/preview/earn`     | `/bank/earn`              | `screens/preview/earn/`     | Money |
| `loans`    | `/preview/loans`    | `/bank/loans`             | `screens/preview/loans/`    | Money |
| `deposit`  | `/preview/deposit`  | `/uc/recharge`            | `screens/preview/deposit/`  | Money |
| `withdraw` | `/preview/withdraw` | `/uc/withdraw`            | `screens/preview/withdraw/` | Money |
| `card`     | `/preview/card`     | `/bank/cards`             | `screens/preview/card/`     | Pay   |
| `ifc`      | `/preview/ifc`      | none                      | `screens/preview/ifc/`      | More  |
| `academy`  | `/preview/academy`  | `/academy`                | `screens/preview/academy/`  | More  |

Always link to `/preview/<id>` (`previewProducts[id].path`), never to an older address. `app/screens.ts` lazy-imports `screens/preview/<id>` (its `index.tsx`, default export, props `ScreenProps`).

### Folder ownership

- One builder owns one `screens/preview/<id>/` folder (everything inside it, including its CSS, tests and harness). Do not edit another builder's folder.
- Shared files are owned by the registry builder: everything directly in `src/preview/` (chip, caption, sheet, frame, products), `src/preview/fixtures/types.ts`, the registry, menus and routes. Ask for a change instead of editing them.
- **Your fixture file** `src/preview/fixtures/<id>.ts` belongs to the builder of `screens/preview/<id>/`. Grow it as you need; keep it sample-only.
- Screen CSS goes in `@layer components`, with `--if-*` tokens only, in your own folder.

## Fixtures: the sample data

`src/preview/fixtures/<id>.ts` exports `<id>Fixture`, built with `definePreviewFixture(product, note, rows)`:

```ts
export interface PreviewFixture<Rows> {
  readonly product: PreviewProductId;
  readonly sample: true; // always true; real data never carries it
  readonly note: string; // one plain-English line saying what the sample shows
  readonly rows: Rows; // any shape you need; rows of {label, value, detail} use SampleLine
}
```

Rules:

1. Money is a **decimal string** or `bigint`, never a float. One number format per amount. Prices carry `$`.
2. The numbers are invented and plausible. Never copy a real account's figures.
3. A fixture file imports only `./types` (and other files in `fixtures/`). It never imports the API client (`shared/api`), the data layer (`data/`), a `features/` module or the session.
4. A Preview screen imports its fixture **directly** (`../../../preview/fixtures/futures`), not through a barrel, so it is easy to see who reads sample data.
5. Nothing outside `src/preview/` and `src/screens/preview/` may import a fixture, and a Preview screen may not import the API client or any data hook. Sample numbers must never reach real totals, the one-account strip or Home. `preview-isolation.test.ts` fails the build if either rule is broken.
6. Preview screens do not make requests at all. No `fetch`, no socket, no query hook.

## The shared UI

All exported from `src/preview/index.ts`:

- **`PreviewScreen`**: the frame. `<PreviewScreen product="futures">…</PreviewScreen>` draws the page title with the Preview chip, the caption, and mounts the shared sheet. Use it as the root of every screen.
- **`PreviewChip`**: the small "Preview" label (12 px, outlined, grey; not lime, not amber). Put it next to every tab, menu item or **panel title** of a Preview product: `<h2>Positions <PreviewChip /></h2>`. The page title already has one.
- **`PreviewCaption`**: the line "Preview: sample numbers, not your account". `PreviewScreen` shows it once at the top; show it again at the top of any separate panel that sits outside the frame (a docked panel, a drawer).
- **`PreviewActionButton`**: a button that opens the sheet instead of doing anything. **Every action button in a Preview screen is one** (Place order, Subscribe, Follow, Withdraw, Start bot, and so on): `<PreviewActionButton product="futures" variant="buy" size={40}>Buy / Long</PreviewActionButton>`. It takes the kit `Button` props except `type` and `onClick`.
- **`usePreviewSheet()`**: `const { open } = usePreviewSheet(); open('futures')` for a trigger that is not a button (a table row, a card). Only inside `PreviewScreen`.
- **The sheet** (shown by the provider): title "Preview: nothing was sent", body "{Product} is not live yet. Nothing was sent, and nothing on your account changed.", one "OK" button. Do not build a second one and do not reword it.
- **`PreviewSamplePanel`**: a ready-made table of `SampleLine` rows from a fixture, for simple lists.
- **`previewProducts`**, `previewProductIds`: names, routes and menu doors in one place.

A form in a Preview screen must not have a real `<form onSubmit>` that does work; keep fields local and route the submit button through `PreviewActionButton`.

## Wording

Plain English. English source only (UI-SPEC 4.4). No internal terms. Never write "demo", "fake" or "mock" on screen: it is **Preview** and **sample**. Do not draw a card-network logo or any real brand mark.

## Checks that run for you

- `src/app/feature-registry.test.ts`: states, flag, menus.
- `src/preview/preview-isolation.test.ts`: the import rules above.
- `src/preview/preview.pw.mjs` (Playwright): a Preview route shows the chip, the caption and the sheet.
