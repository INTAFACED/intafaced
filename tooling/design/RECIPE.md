# Moving a batch of rooms into Volt (#9433)

One batch is one row of `node tooling/design/volt-count.mjs --summary` (an area and a template), or the rooms of that
row already on their template. One PR per batch.

1. **List the batch's screen files:** `node tooling/design/volt-count.mjs` prints each room with its state, file and
   findings.
2. **Rooms not on their template yet** (`not-migrated`): rebuild the screen on its template from
   `@intafaced/ui/lit/templates`, copying a room already in Volt on the same template (`features/money/business-team/`
   for flow; the gallery's `packages/ui/src/lit/templates/__gallery__/fixtures.tsx` for the rest). Keep every control,
   every word and every state; set `migrated.file` on its row in `apps/customer/src/app/room-templates.ts`.
3. **Run the codemod:** `node tooling/design/volt-recipe.mjs --write <file> ...` (paths under `apps/customer/src`). It
   moves the old Button and the `field`, `text-link` and `sr-only` classes onto the kit, and prints with its line each
   finding it left.
4. **Each finding left needs judgement.** By kind (volt-count's names):
   - `old-kit` other than Button: use the kit's part (`Field`, `Segmented`, `Tabs`, `KeyValue`, `Sheet`, `EmptyState`…
     in `@intafaced/ui/lit`); where the kit has none, a native control inside `lt-field`.
   - `own-class`: delete it when the template already lays the part out; else the kit's class (`lt-…`, in
     `packages/ui/src/lit/templates/templates.css`). A part the kit lacks is added to the kit, tokens only, in its own
     commit, never drawn in the room.
   - `outside-component`: a part from outside the room's folder that draws off the kit. Redraw it from the kit where it
     lives, once, for every room that shares it (volt-count judges it by the same rule); a generic part goes into the kit.
   - `stylesheet`, `inline-style`: delete; the template and the kit's classes carry the layout.
5. **Prove it:** `node tooling/design/volt-count.mjs --write` drops the batch's rooms from `volt-off-kit.json`;
   `pnpm --filter @intafaced/customer exec vitest run src/app/volt-count.test.ts` shows n rose by the batch and nothing
   fell. Typecheck, the customer unit tests, and the journeys the batch's rooms reach pass in CI on the PR's head; the
   CI review judges the before and after pictures. A journey test changes only when the PR names its step and proves
   it again.
