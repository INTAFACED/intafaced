# Lit glass kit (`@intafaced/ui/lit`)

The customer app's new look, built as a system: role tokens, components, eight templates and the 3D objects. It ships behind a switch: nothing changes until the root element carries `data-look="lit"`.

## Layout and owners

| Path                                  | What                                                                                   | Owner lane |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `contracts.ts`                        | Frozen names: roles, type roles, templates, states, slots, components, doors           | B1 (lead)  |
| `tokens.ts`, `lit.css`, `generate.ts` | Role token values for flat (switch off), lit dark, light, accents, Solid surfaces, Pro | B1         |
| `components/`                         | The component sheet                                                                    | B1         |
| `templates/`                          | The eight templates and the room scaffold                                              | B2         |
| `fx/`                                 | three.js objects on one shared canvas, poster and flat tier                            | B3         |
| `../a11y/`                            | Solid surfaces switch, worst-pixel contrast, forced colours, focus                     | B4         |

A new role, type role, slot or component name goes through `contracts.ts` (ask B1); lanes never add a token themselves.

## Rules every component and template keeps

- Read only `--lit-*` roles. No raw colour or shadow in a component. Spacing that scales with density reads the density roles (`gap-item`, `pad-panel`, `control-h`...); only the kit's own sheet may keep structural px (hairlines, icon boxes, hit targets), never a room or template.
- Logical sides only (`inset-inline`, `margin-inline-start`, `border-inline-start`), never left or right.
- No copy in the kit: every word a customer sees arrives as a prop, from the i18n catalogue or the legal text registry.
- Roles that depend on where the light is (rims, corner glow) are colours; the component draws the gradient, with its own light angle or corner, because a custom property is resolved where it is declared (`:root`), not where it is used.
- Image roles (`field`, `glass-bg`, `primary-bg`, `secondary-bg`, `key-bg`, `key-lit-bg`) are a colour when flat and a gradient when lit: use them only with the `background` shorthand.
- Glass (`glass-bg`, `glass-blur`) only on the nav and sheet layers. Content panels are solid, and money sits on them.
- One primary button per view. The focus ring is never the lit or selected colour.
- The risk band and the legal slots render only with `LegalSlotsSwitch` on (`templates/frame.tsx`). It is off by default until launch prep turns it on at the app root; off, there is no band and no space kept for it. On, the `legal` slot renders first on every template; its text comes from the registry, never from a room, and is never faded, brand-coloured or smaller than body text.
- Up and down colours (`data-dir`) apply inside a template room at zero specificity, so a room's own colour class on the same element wins without warning: leave colour on direction values to the templates.
- Every chart's parts reconcile to the total shown, or show "other". Illustrative figures say TEST.
- Money arrives as decimal strings and is formatted by `packages/i18n`, never as a `number`.
- No 3D on a confirm or review step.

## Switches on the root element

`data-look="lit"`, `data-accent="blue|ember|violet|emerald"` (blue default), `data-theme="light"` (not shipped), `data-surfaces="solid"` (also automatic with `prefers-contrast: more`, `forced-colors: active` or `prefers-reduced-transparency: reduce`), `data-mode="pro"`.

## Changing a value

Edit `tokens.ts`, run `pnpm exec tsx src/lit/generate.ts` in `packages/ui`, commit both. `lit.test.ts` checks drift, contrast of every text role on every solid surface in both schemes, the risk band, and that `apps/admin` never imports this kit.

Values are provisional until stage A1 (the look re-lit in blue inside the budgets) is judged; names are frozen.
