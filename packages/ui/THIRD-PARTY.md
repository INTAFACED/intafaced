# Third-party code and assets in `packages/ui` (customer-app redesign kit)

Rules: COMPONENT-PLAN section 3.1 (copy at a recorded commit, header on every copied file, one line here).
Nothing here is fetched at runtime; no CDN, no hot-linking.

## Copied code

Source for every row: **shadcn/ui, Base UI flavour** (`apps/v4/registry/bases/base/ui/<name>.tsx`),
repository https://github.com/shadcn-ui/ui, commit `30a58d4498f270af1c1e981a7d78a15cf5740841`
(main on 2026-10-12), licence **MIT** (Copyright (c) 2023 shadcn), copied 2026-10-13.

The upstream files use `cn-*` placeholder classes that are filled in by shadcn's own style sheets.
We kept the part structure and props and wrote the styling ourselves from `src/theme/tokens.ts`
(UI-SPEC section 2). Each file carries the required source header.

| Our file                                      | Upstream file                      | What changed                                                              |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `components/tabs.tsx`                         | `tabs.tsx`                         | Tokens; sliding underline via `Tabs.Indicator`; lime tone for the top bar |
| `components/toggle-group.tsx`                 | `toggle-group.tsx`                 | Single-choice string API; chip and range-pill looks                       |
| `components/menu.tsx`                         | `dropdown-menu.tsx`                | Renamed; submenus left out; dark panel menu                               |
| `components/popover.tsx`                      | `popover.tsx`                      | Tokens; menu motion                                                       |
| `components/tooltip.tsx`                      | `tooltip.tsx`                      | Tokens; opens on hover and focus                                          |
| `components/dialog.tsx`                       | `dialog.tsx`                       | Tokens; scrim; fade and scale                                             |
| `components/alert-dialog.tsx`                 | `alert-dialog.tsx`                 | Tokens; no close icon                                                     |
| `components/select.tsx`                       | `select.tsx`                       | Tokens; 32 and 40 px triggers                                             |
| `components/navigation-menu.tsx`              | `navigation-menu.tsx`              | Top-bar triggers; 56 px icon + title + description cards                  |
| `components/autocomplete.tsx`                 | `combobox.tsx`                     | Rebuilt on Base UI Autocomplete for the header search                     |
| `components/checkbox.tsx`, `switch.tsx`       | `checkbox.tsx`, `switch.tsx`       | Tokens; lime when on                                                      |
| `components/collapsible.tsx`, `accordion.tsx` | `collapsible.tsx`, `accordion.tsx` | Tokens; 150 ms height animation                                           |
| `components/button.tsx`                       | `button.tsx`                       | Our variants (primary, secondary, ghost, buy, sell) and sizes (28 to 56)  |

Written by us, not copied (structure only from the library docs):
`components/toast.tsx` (Base UI 1.8.0 Toast docs, MIT; shadcn's Base UI flavour has no toast, it uses Sonner),
`segmented.tsx`, `skeleton.tsx`, `numbers.tsx`, `hero-number.tsx`, `sparkline.tsx`, `coin-icon.tsx`,
`status-tag.tsx`, `state-block.tsx`, `amount-input.tsx` and its logic.

Not used (COMPONENT-PLAN 3.1 rule 4): anything from `cosscom/ui` (Origin UI, AGPL-3.0), React Bits, any paid "Pro" tier.

## Coin artwork (`src/components/coins/*.svg`)

Drawings: **0xa3k5/web3icons**, https://github.com/0xa3k5/web3icons, commit
`763a55d66a03b21b603eb249f2df7c64a7522089` (main on 2026-10-05), licence **MIT**
(Copyright (c) 2024 0xa3k5), path `raw-svgs/tokens/background/<TICKER>.svg`, copied 2026-10-13.
Per-file source, licence and commit are in `src/components/coins/manifest.json`; `coin-art.test.ts` fails if the
generated `coin-art.generated.ts` drifts from the SVG files.

| File       | Asset                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| `btc.svg`  | BTC                                                                                 |
| `eth.svg`  | ETH (the upstream "background" variant is a black tile; kept as shipped)            |
| `usdt.svg` | USDT                                                                                |
| `usdc.svg` | USDC                                                                                |
| none       | IFC: INTAFACED's own asset has no brand art yet, so it renders as a lettered circle |

**The drawings are MIT; the marks themselves are trademarks of their projects.** They are shown only to identify
an asset we actually list, are never altered, and the manifest is the single list of what may be shown.
COMPONENT-PLAN section 4 item 3: Nitro or counsel to confirm before launch. Fallback if a licence question
arises: `spothq/cryptocurrency-icons` (CC0), not used so far.

## Packages (installed, exact pins in `package.json`)

| Package                               | Version      | Licence                            | Use                                          |
| ------------------------------------- | ------------ | ---------------------------------- | -------------------------------------------- |
| `@base-ui/react`                      | 1.8.0        | MIT                                | Headless parts for every overlay and control |
| `@number-flow/react`                  | 0.6.2        | MIT                                | `HeroNumber` only                            |
| `lucide-react`                        | 1.48.0       | ISC (some icons MIT, from Feather) | Icons, each imported by name                 |
| `class-variance-authority`            | 0.7.1        | Apache-2.0                         | Variant classes                              |
| `clsx`, `tailwind-merge`              | 2.1.1, 3.7.0 | MIT                                | Class merging                                |
| `@fontsource-variable/inter`          | 5.3.0        | OFL-1.1                            | UI font (pending founder decision D1)        |
| `@fontsource-variable/jetbrains-mono` | 5.3.0        | OFL-1.1                            | IDs and addresses only                       |

OKX is a visual reference only. No OKX logo, font, icon drawing, illustration, wording or capture is in this package.

## Licence texts

Full notices, copied from the upstream `LICENSE` files at the commits recorded above.

### shadcn/ui (copied component code)

Source: https://github.com/shadcn-ui/ui, `LICENSE.md` at commit `30a58d4498f270af1c1e981a7d78a15cf5740841`

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 0xa3k5/web3icons (coin artwork)

Source: https://github.com/0xa3k5/web3icons, `LICENCE` at commit `763a55d66a03b21b603eb249f2df7c64a7522089`

```text
MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
