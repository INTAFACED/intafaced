// garden/asset-id-schema on planted files: two contract fields as main had them before the AssetId brand
// (withdrawal-allowance.ts and bank-business-books.ts) fire and name `assetIdSchema`; the same fields written from
// `assetIdSchema`, a test file, a file outside the contracts package and a non-asset field stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(asset-id-schema)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-asset-id-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const contract = (name) => `packages/contracts/src/${name}.ts`;
const head = "import { z } from 'zod';\nimport { assetIdSchema } from './asset-id.js';\n";

test('the unbranded asset id fields main had fire and name assetIdSchema', { skip }, () => {
  const out = findings({
    [contract('withdrawal-allowance')]:
      head +
      'export const withdrawalAllowanceInputSchema = z.object({ userId: z.string().guid(), assetId: z.string().min(1).max(16) }).strict();\n',
    [contract('bank-business-books')]:
      head + 'export const s = z.object({ account: z.object({ id: z.string().guid(), name: z.string(), assetId: z.string() }) });\n',
    [contract('nullable')]: head + 'export const s = z.object({ assetId: z.string().nullable() });\n',
  });
  assert.equal(out.length, 3, out.join('\n'));
  for (const l of out) assert.match(l, /assetIdSchema/u);
});

test('the branded field, a test, a file outside contracts and another field stay quiet', { skip }, () => {
  const out = findings({
    [contract('branded')]: head + 'export const s = z.object({ assetId: assetIdSchema.min(1).max(16), userId: z.string() });\n',
    [contract('branded-nullable')]: head + 'export const s = z.object({ assetId: assetIdSchema.nullable() });\n',
    ['packages/contracts/src/fixture.test.ts']: head + 'export const s = z.object({ assetId: z.string() });\n',
    ['services/svc-pay/src/row.ts']: "import { z } from 'zod';\nexport const s = z.object({ assetId: z.string() });\n",
  });
  assert.deepEqual(out, []);
});
