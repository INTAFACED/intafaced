import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addImport, rewrite } from './garden-shared-helpers-codemod.mjs';

const MAJORITY = `import { a } from './a';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const x = isRecord(a);
`;

test('the majority isRecord body is replaced by the shared import', () => {
  const r = rewrite(MAJORITY);
  assert.deepEqual(r.changed, [{ helper: 'isRecord', as: 'isRecord' }]);
  assert.match(r.text, /^import \{ isRecord \} from '@intafaced\/contracts\/guards';$/m);
  assert.doesNotMatch(r.text, /function isRecord/);
  assert.match(r.text, /export const x = isRecord\(a\);/);
});

test('every equivalent spelling is replaced', () => {
  for (const src of [
    `const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));\n`,
    `const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);\n`,
    `const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);\n`,
    `function isRecord(raw: unknown): raw is Record<string, unknown> {\n  return !!raw && typeof raw === 'object' && !Array.isArray(raw);\n}\n`,
  ]) {
    const r = rewrite(src);
    assert.equal(r.changed.length, 1, src);
    assert.doesNotMatch(r.text, /isRecord =|function isRecord/, src);
  }
});

test('a looser copy (no array check) is kept under its own body', () => {
  const src = `function isRecord(value: unknown): value is Record<string, unknown> {\n  return typeof value === 'object' && value !== null;\n}\n`;
  const r = rewrite(src);
  assert.equal(r.text, src);
  assert.deepEqual(r.kept, [{ helper: 'isRecord', reason: 'body differs from the shared one' }]);
});

test('an exported copy is kept', () => {
  const src = `export function isRecord(v: unknown): v is Record<string, unknown> {\n  return Boolean(v && typeof v === 'object' && !Array.isArray(v));\n}\n`;
  const r = rewrite(src);
  assert.equal(r.text, src);
  assert.deepEqual(r.kept, [{ helper: 'isRecord', reason: 'exported' }]);
});

test('a sleep copy under another name keeps its name through an aliased import', () => {
  const src = `import { b } from 'b';\nconst pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\nawait pause(5);\n`;
  const r = rewrite(src);
  assert.deepEqual(r.changed, [{ helper: 'sleep', as: 'pause' }]);
  assert.match(r.text, /^import \{ sleep as pause \} from '@intafaced\/contracts\/sleep';$/m);
  assert.match(r.text, /await pause\(5\);/);
});

test('a fixed-time or act-wrapped wait is not a sleep and is kept', () => {
  for (const src of [
    `const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));\n`,
    `const wait = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));\n`,
    `const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));\n`,
  ]) {
    assert.equal(rewrite(src).text, src, src);
  }
});

test('an existing import from the same module gains the name instead of a second line', () => {
  const out = addImport(`import { a } from '@intafaced/contracts/guards';\nx;\n`, '@intafaced/contracts/guards', 'isRecord');
  assert.equal(out, `import { a, isRecord } from '@intafaced/contracts/guards';\nx;\n`);
});

test('--only limits the rewrite to one helper', () => {
  const src = MAJORITY + `const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\n`;
  assert.deepEqual(rewrite(src, 'sleep').changed, [{ helper: 'sleep', as: 'sleep' }]);
  assert.deepEqual(rewrite(src, 'isRecord').changed, [{ helper: 'isRecord', as: 'isRecord' }]);
});
