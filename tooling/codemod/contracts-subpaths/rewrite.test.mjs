// node --test tooling/codemod/contracts-subpaths/rewrite.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewrite } from './rewrite.mjs';

const names = new Map([
  ['createEdgeContext', 'edge'],
  ['edgeHeaders', 'edge'],
  ['quantAlgoSchema', 'quant-algo'],
  ['crmCampaignSchema', 'crm-workflows'],
  ['crmTaskSchema', 'crm-workflows'],
  ['guestNoticeSchema', 'guest-notifications'],
]);

test('value names go to the file that defines each; type names stay on the barrel as an erased import type', () => {
  const from = `import { quantAlgoSchema, type EdgeContext, createEdgeContext as edge, edgeHeaders } from '@intafaced/contracts';\n`;
  assert.equal(
    rewrite(from, names),
    [
      `import type { EdgeContext } from '@intafaced/contracts';`,
      `import { createEdgeContext as edge, edgeHeaders } from '@intafaced/contracts/edge';`,
      `import { quantAlgoSchema } from '@intafaced/contracts/quant-algo';`,
      '',
    ].join('\n'),
  );
});

test('an import type, a subpath import and an unrelated package are left as they are; a second run changes nothing', () => {
  const kept = [
    `import type { EdgeContext } from '@intafaced/contracts';`,
    `import { edgeHeaders } from '@intafaced/contracts/edge';`,
    `import { z } from 'zod';`,
  ].join('\n');
  assert.equal(rewrite(kept, names), kept);
  const once = rewrite(`import {\n  edgeHeaders,\n  quantAlgoSchema,\n} from '@intafaced/contracts';`, names);
  assert.equal(rewrite(once, names), once);
});

test('a re-export goes to the defining file', () => {
  assert.equal(
    rewrite(`export { edgeHeaders } from '@intafaced/contracts';`, names),
    `export { edgeHeaders } from '@intafaced/contracts/edge';`,
  );
});

test('a namespace import becomes the bare names it reads, from their files, types as types', () => {
  const from = [
    `import * as workflow from '@intafaced/contracts';`,
    `const a = workflow.crmCampaignSchema.parse(x);`,
    `const b: workflow.CrmInput = workflow.guestNoticeSchema.parse(workflow.crmTaskSchema.parse(y));`,
  ].join('\n');
  assert.equal(
    rewrite(from, names),
    [
      `import type { CrmInput } from '@intafaced/contracts';`,
      `import { crmCampaignSchema, crmTaskSchema } from '@intafaced/contracts/crm-workflows';`,
      `import { guestNoticeSchema } from '@intafaced/contracts/guest-notifications';`,
      `const a = crmCampaignSchema.parse(x);`,
      `const b: CrmInput = guestNoticeSchema.parse(crmTaskSchema.parse(y));`,
    ].join('\n'),
  );
});

test('it refuses rather than guess: a value name no file exports, a namespace member the file already names', () => {
  assert.throws(() => rewrite(`import { missingThing } from '@intafaced/contracts';`, names, 'a.ts'), /a\.ts: missingThing/);
  const clash = `import * as w from '@intafaced/contracts';\nconst crmTaskSchema = 1;\nw.crmTaskSchema.parse(crmTaskSchema);`;
  assert.throws(() => rewrite(clash, names, 'b.ts'), /b\.ts: w\.\* members crmTaskSchema/);
});
