# UI kit: which part to use

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

One kit, in `packages/ui` (`import { … } from '@intafaced/ui'`). Every customer screen builds from these parts.
**Do not create local tables, buttons or inputs.** If a part is missing something, change the part (one PR to
`packages/ui`), do not copy it into a screen. Raw `<button>`, `<input>` and `<table>` in a screen are review blockers.

See every part in every state: `pnpm --filter @intafaced/ui gallery` (http://127.0.0.1:3290, add `?only=table`,
`input`, `page` or `figures` for one part). All figures in the gallery are TEST DATA.

## Which part for what

| You need                                    | Use                                    | Notes                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows and columns of data                    | `Table`                                | Sortable, sticky header, numeric lanes, selection, loading/empty/error rows, `virtualize` for long lists.                                                                                                 |
| Sort rows on the client                     | `sortRows`, `nextSort`                 | `numeric` columns compare exact decimals, so their `value`/`sortValue` must be plain decimal strings (format in `cell`); anything else is logged and sorted as unknown. Unknown values always sort last.  |
| A text box or an amount box                 | `Input` (`kind="text"` or `"decimal"`) | Decimal keeps the string. Typing and paste use the `AmountInput` parser, except that typing the other decimal mark (`,` on a `.` keyboard) is refused, so `1,000` is never read as `1.000`.               |
| Label, hint, error, required around a box   | `Field`                                | Wires label, hint and error to the control for screen readers. Error shows an icon and words, not colour alone.                                                                                           |
| Order-form amount with Max / BBO / steppers | `AmountInput` (existing)               | Same decimal rules as `Input`.                                                                                                                                                                            |
| Page title, actions, breadcrumbs, width     | `Page`, `PageHeader`, `PageSection`    | `width`: `narrow` (672 lane), `content` (1224), `full`. One `h1` per page.                                                                                                                                |
| A region with nothing, refused or parked    | `EmptyState`                           | `variant`: `empty`, `refused`, `unavailable`. Refused and unavailable **require** a `reason`. Never "coming soon".                                                                                        |
| Loading skeleton or retryable error         | `StateBlock` (existing), `Skeleton`    |                                                                                                                                                                                                           |
| One headline figure with its time           | `Stat`                                 | `value={null}` draws a dash, never 0. Pass `asOf` to show a freshness chip. Leave `now` out and the chip re-checks itself; pass `now` only if your screen re-renders on its own clock.                    |
| Label/value rows (receipts, detail panes)   | `KeyValue`                             | A real `<dl>`. Values right-aligned in one lane.                                                                                                                                                          |
| Small label                                 | `Badge`                                | tone: neutral, lime, warn, error, up, down. up/down only for market direction.                                                                                                                            |
| Is this data live, stale, unknown, refused  | `StatusChip`                           | Shape plus word, never colour alone. `freshnessOf` decides from `asOf`, `now`, `staleAfterMs`. Leave `now` out and the chip re-checks itself; pass `now` only if your screen re-renders on its own clock. |
| Buttons, tabs, menus, dialogs, selects      | the existing parts in `@intafaced/ui`  | `Button`, `Tabs`, `Menu`, `Dialog`, `Select`, `Checkbox`, `Switch`, `Tooltip`, `ToastProvider`.                                                                                                           |

## Rules every part follows

- **Density**: `density="comfortable"` (default, 44 px controls and rows) or `"dense"` (pro desk, 32 px controls, 28 px table header). Sizes are tokens, not numbers in components.
- **Money is a string.** Props take pre-formatted strings or `null`. No `Number`, `parseFloat`, `toFixed` or unary `+` on an amount (`money-safety.test.ts` fails the build).
- **Missing is not zero.** `null` draws "—". A refused or unavailable region says why.
- **Colour is never the only cue.** Status has a word and a shape; errors have an icon and text.
- **Keyboard and focus**: every part is keyboard operable and shows the lime focus ring. Table rows: arrows, Home, End, PageUp, PageDown move; Enter opens; Space selects.
- **Tokens only.** No hex colours outside `src/theme/tokens.ts`. Readable text is `fg` or `fg-2`; `fg-3` is for placeholders and decoration (it is 4.0:1 on black, below AA for small text).
- **Weights 400, 500, 600** in kit parts (DESIGN.md). Tabular figures on every number column.

## Tokens

`src/theme/tokens.ts` is the source; `tokens.css` is generated (`pnpm exec tsx src/theme/generate.ts` in `packages/ui`). Values come from the OKX
measurement (`MEASURED-TOKENS.md`, cited per token in the file). New this release: `--if-error`/`--if-error-text`, `--if-ctl-h`, `--if-ctl-h-dense`,
`--if-table-row-h`, `--if-table-row-h-dense`, `--if-table-head-h`, `--if-table-head-h-dense`. `--if-base` (the admin stylesheet's name) is now an alias of
`--if-bg`. Two names still hold different values in the admin stylesheet and the kit (`--if-warn`, `--if-font-mono`); no app loads both, and a test fails if a third appears.

## Known conflicts (DESIGN.md vs measured values)

DESIGN.md is the authority; where a measured value disagrees, this is what the kit does. Items marked **decision** change what every live screen looks like, so they are Nitro's taste call and are not applied here.

| #   | DESIGN.md says                                              | Measured / current token                  | Kit does                                                                                           |
| --- | ----------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1  | text `#F5F5F5`, muted `#A3A3A3`                             | `fg` white, `fg-2` `#909090`              | Keeps current tokens. **Decision**: switching shifts every screen.                                 |
| C2  | surfaces `#0D0D0D`/`#171717`, dividers `#262626`/`#303030`  | `panel` `#121212`, `line` `#2E2E2E`       | Keeps current tokens. **Decision**.                                                                |
| C3  | main controls are 44 px targets                             | measured list/table row 60 px             | Table rows 44 (dense 32). The 60 px `row-h` stays for two-line list rows.                          |
| C4  | cosmetic dividers are not a substitute for accessible focus | OKX focus is a 1 px white border          | Lime 2 px focus ring, as the rest of the kit.                                                      |
| C5  | weights 400, 500, 600 only                                  | `2xl` and `hero` text tokens are 700      | New parts use 400/500/600. The 700 tokens are unchanged. **Decision**.                             |
| C6  | tabular figures on Inter (`tnum`)                           | OKX uses proportional figures off-desk    | Tabular figures everywhere in the kit.                                                             |
| C7  | placeholder and disabled text must stay readable            | OKX placeholder is white at 30%           | Placeholder uses `fg-3`; hints and captions use `fg-2` (AA).                                       |
| C8  | n/a                                                         | OKX puts white text on the green buy fill | Keeps near-black text on `up` (white on this green fails AA).                                      |
| C9  | smallest text is 13 px                                      | `text-xs` and `text-2xs` are 12 px        | Hints, errors, headers and chips use 12 px (OKX measured it). **Decision**.                        |
| C10 | main controls are 44 px; no arbitrary density scale         | pro desk rows and inputs are 28 to 32 px  | `dense` (32 px) exists for the desk; DESIGN.md allows desk-local density for review. **Decision**. |
