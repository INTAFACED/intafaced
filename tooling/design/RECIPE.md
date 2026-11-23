# Moving a batch of rooms into Volt (#9433)

One batch is one row of `node tooling/design/volt-count.mjs --summary` (an area and a template), or the rooms of that
row already on their template. One PR per batch.

1. **List the batch's screen files:** `node tooling/design/volt-count.mjs` prints each room with its state, file and
   findings.
2. **Rooms not on their template yet** (`not-migrated`): rebuild the screen on its template from
   `@intafaced/ui/lit/templates`, copying a room already in Volt on the same template (`features/money/business-team/`
   for flow; the gallery's `packages/ui/src/lit/templates/__gallery__/fixtures.tsx` for the rest). Keep every control,
   every word and every state; put the room's line `// volt-room: <route>` (`portal:<page>` for a merchant portal
   page) at the top of the screen file that draws it. Never edit a shared list in a batch.
3. **Run the codemod:** `node tooling/design/volt-recipe.mjs --write <file> ...` (paths under `apps/customer/src`). It
   moves the old Button, Badge and StatusTag and every class in its `CLASSES` map onto the kit, drops a class no
   stylesheet names (`GONE`), and prints with its line each finding it left, a class a test finds an element by among
   them; its `PARTS` map says why the old parts it leaves have no twin. `--plan --rank` ranks what every room leaves.
4. **Each finding left needs judgement.** By kind (volt-count's names):
   - `old-kit` other than Button: use the kit's part (`Field`, `Segmented`, `Tabs`, `KeyValue`, `Sheet`, `EmptyState`…
     in `@intafaced/ui/lit`); where the kit has none, a native control inside `lt-field`.
   - `own-class`: delete it when the template already lays the part out; else the kit's class (`lt-…`, in
     `packages/ui/src/lit/templates/templates.css`). A part the kit lacks is added to the kit, tokens only, in its own
     commit, never drawn in the room.
   - `outside-component`: a part from outside the room's folder that draws off the kit, imported directly or through a
     barrel (`../trade`; the finding names the file that holds it). Redraw it from the kit where it lives, once, for every room that shares it (volt-count judges it by the same rule); a generic part goes into the kit.
   - `stylesheet`, `inline-style`: delete; the template and the kit's classes carry the layout.
5. **Prove it:** `pnpm --filter @intafaced/customer exec vitest run src/app/volt-count.test.ts`
   shows n rose by the batch and nothing fell. A batch leaves `volt-off-kit.json` and `kit-ceilings.json` as they are, into a
   layer or into main: a stale entry passes, and only an added room or a raised ceiling fails.
   `node tooling/design/volt-prune.mjs`, run on a branch from main in a PR of its own, is the only thing that lowers them. Typecheck, the customer unit tests and the Look gate's pictures pass in CI on the batch's head; the journeys
   the rooms reach pass on the layer's PR into main, where the CI review judges the before and after pictures. A journey test changes only when the PR names its step and proves
   it again. Every `data-testid`, `data-cell` and `data-col` a journey test finds by stays:
   `node --test tooling/design/volt-keep-ids.test.mjs` (run with the tooling tests) names any the batch dropped.

## A batch on its layer branch

A batch PR goes into its template's layer branch, `volt/<template>`, and runs CI's fast checks only. Never arm it with
`--auto`, since no ruleset guards a layer branch: its owner calls `watch_pull_request` on it and, on its all-green wake,
merges it with `gh pr merge <n> --squash --match-head-commit <sha>`. The layer's own PR into main runs everything main requires.

The call-records codemod (`tooling/codemod/call-records/`, its `callAs` runs among them) rewrites the call sites in the
same rooms. A redraw changes markup and kit parts only, never a call expression (`api.query`, `api.call`, `callAs`, a
read hook's arguments). Merge main into the layer branch and push that merge to it directly, never by a PR, whose squash
drops main as a parent (Doctrine gates refuses one), at least once a day, and at once whenever a call-records run lands
on main. A conflict at a call site is settled by re-running that codemod on the branch, never by hand.
