// garden/no-service-sentence on planted screens of the copy bots room (the folder .oxlintrc.json switches it on for): a
// service's operator fields and a reply's `.message`, read or printed, fire; the room's own words and a screen in another
// folder do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPlanted } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = !existsSync(join(ROOT, 'node_modules', '.bin', 'oxlint')) && 'no node_modules';
const RULE = 'garden/no-service-sentence';
const ROOM = 'apps/customer/src/screens/trade/copybots';

test("each way a screen shows a service's sentence fires", skip, () => {
  const { files } = countPlanted(RULE, {
    [`${ROOM}/A.tsx`]: 'export const A = ({ r }) => <p>{r.residual}</p>;\n',
    [`${ROOM}/B.tsx`]: 'export const B = ({ s }) => <p>{s.statusLine ?? s.residuals}</p>;\n',
    [`${ROOM}/C.tsx`]: 'export const C = ({ failure }) => <p title={failure.message}>x</p>;\n',
    [`${ROOM}/D.tsx`]: 'export function D(api) {\n  const result = api.run();\n  return result.message;\n}\n',
    [`${ROOM}/E.tsx`]: 'export const E = ({ e }) => <p>{e.message}</p>;\n',
    [`${ROOM}/F.tsx`]: 'export const F = ({ e, t }) => <p>{`${t}: ${e?.message}`}</p>;\n',
    [`${ROOM}/G.tsx`]: "export const G = ({ e }) => <p>{e.code ? 'x' : e.message}</p>;\n",
  });
  assert.deepEqual(files, {
    [`${ROOM}/B.tsx`]: 2,
    [`${ROOM}/A.tsx`]: 1,
    [`${ROOM}/C.tsx`]: 1,
    [`${ROOM}/D.tsx`]: 1,
    [`${ROOM}/E.tsx`]: 1,
    [`${ROOM}/F.tsx`]: 1,
    [`${ROOM}/G.tsx`]: 1,
  });
});

test("the room's own words, a field merely named in a key, and a screen outside the room do not fire", skip, () => {
  const { total } = countPlanted(RULE, {
    [`${ROOM}/Clean.tsx`]: [
      "import { roomRefusal } from './refusals';",
      'export const Clean = ({ failure }) => {',
      '  const shown = roomRefusal(failure);',
      "  const keys = { residual: 'x', message: 'y' };",
      '  return <p data-k={Object.keys(keys).length}>{shown.title}</p>;',
      '};',
      '',
    ].join('\n'),
    'apps/customer/src/screens/trade/desk/Other.tsx': 'export const O = ({ e }) => <p>{e.message}</p>;\n',
  });
  assert.equal(total, 0);
});
