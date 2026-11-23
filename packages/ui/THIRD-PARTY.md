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

## Symbol font subsets (`src/lit/fonts/*.woff2`)

Volt's faces carry no arrows, geometric shapes or check marks (but ↑ ↓), so `src/lit/fonts.css` adds these subsets to
each Volt family by `unicode-range`. Both are subsets made by `scripts/symbol-fonts.py`, which checks each source's
sha256; licence **SIL OFL 1.1**, no Reserved Font Name; copied 2026-11-23.

| Our file                   | Source                                                                                                                        | Glyphs                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `volt-symbols.woff2`       | Inter 4.1 (https://github.com/rsms/inter, release `v4.1`), `web/InterVariable.woff2`                                          | Arrows, shapes and ✓ ✗ Inter draws              |
| `volt-symbols-small.woff2` | JetBrains Mono 2.304 (https://github.com/JetBrains/JetBrainsMono, release `v2.304`), `fonts/variable/JetBrainsMono[wght].ttf` | The small triangles, ✕ and the rest Inter lacks |

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

### Inter (symbol subset)

Source: https://github.com/rsms/inter, `LICENSE.txt` in release `v4.1`

```text
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### JetBrains Mono (symbol subset)

Source: https://github.com/JetBrains/JetBrainsMono, `OFL.txt` in release `v2.304`

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
