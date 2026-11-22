// node --test tooling/scripts/service-reach.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lastStart, makeCodeReader, makeRecorder, settleCode } from './journey-reach.mjs';
import { CODE_REACH_ENV, codeReachDir, nodeServiceReach, ranFiles, sourceOf } from './service-reach.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./service-reach.mjs', import.meta.url));
const lines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('a built service file is named by the source it was built from, and nothing else is named', () => {
  const at = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
  const has = new Set(['services/svc-bank/src/cards/card-service.ts']);
  const exists = (p) => has.has(path.relative(ROOT, p));
  assert.equal(sourceOf(at('services/svc-bank/dist/cards/card-service.js'), ROOT, exists), 'services/svc-bank/src/cards/card-service.ts');
  assert.equal(
    sourceOf(at('services/svc-bank/dist/cards/gone.js'), ROOT, exists),
    null,
    'a built file whose source is not in the checkout',
  );
  assert.equal(
    sourceOf(at('packages/contracts/dist/index.js'), ROOT, () => true),
    null,
    'a package is not the service',
  );
  assert.equal(
    sourceOf(at('node_modules/fastify/fastify.js'), ROOT, () => true),
    null,
  );
  assert.equal(
    sourceOf('node:internal/modules/run_main', ROOT, () => true),
    null,
  );
  assert.equal(
    sourceOf('https://example.test/services/svc-bank/dist/a.js', ROOT, () => true),
    null,
  );
  const ran = ranFiles(
    [
      { url: 'a', functions: [{ ranges: [{ count: 0 }] }] },
      { url: 'b', functions: [{ ranges: [{ count: 0 }] }, { ranges: [{ count: 2 }] }] },
      { url: 'c', functions: [{ ranges: [{ count: 1 }] }] },
    ],
    (u) => (u === 'c' ? null : `services/svc-x/src/${u}.ts`),
  );
  assert.deepEqual(ran, ['services/svc-x/src/b.ts'], 'only a script with a function that ran, and only a service source');
});

/** Runs `body` in a child that records into `out` with every file:// script named by its basename. */
function child(dir, out, body) {
  const mod = path.join(dir, 'work.mjs');
  writeFileSync(mod, 'export function work() { return 1; }\nexport function idle() { return 2; }\n');
  const script = path.join(dir, 'child.mjs');
  writeFileSync(
    script,
    `import { startCodeReach } from ${JSON.stringify(pathToFileURL(PRELOAD).href)};
startCodeReach(${JSON.stringify(out)}, {
  tick: 100,
  toSource: (u) => (u.startsWith('file:') && u.endsWith('/work.mjs') ? 'services/svc-x/src/work.ts' : null),
});
const { work } = await import(${JSON.stringify(pathToFileURL(mod).href)});
${body}
`,
  );
  return script;
}

test('a process records each window, the files whose functions ran in it, and its end when it exits', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-reach-'));
  const out = path.join(dir, 'x.jsonl');
  const r = spawnSync(process.execPath, [child(dir, out, 'await new Promise((r) => setTimeout(r, 250)); work();')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = lines(out);
  assert.ok(Number.isFinite(got[0].start), 'its first line is its start');
  assert.ok(Number.isFinite(got.at(-1).end), 'its last line is its end');
  const windows = got.filter((l) => 'from' in l);
  assert.ok(windows.length >= 2, 'a window each tick, an empty one too');
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i].from, windows[i - 1].to, 'the windows leave no time out');
  assert.equal(windows[0].from, got[0].start);
  // The module's top level ran on import, in the first window; work() ran in the last one, read as the process exited.
  assert.deepEqual(windows[0].files, ['services/svc-x/src/work.ts']);
  assert.deepEqual(windows.at(-1).files, ['services/svc-x/src/work.ts'], 'what ran just before exit is read at exit');
  assert.ok(
    windows.slice(1, -1).some((w) => !w.files),
    'a window in which none of its files ran names none',
  );
});

test('a service with no signal handler of its own still writes its end on SIGTERM, and still ends by the signal', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-reach-'));
  const out = path.join(dir, 'x.jsonl');
  const c = spawn(process.execPath, [child(dir, out, 'setInterval(() => {}, 1000); work(); process.send?.("up"); console.log("up");')]);
  await new Promise((r) => c.stdout.once('data', r));
  c.kill('SIGTERM');
  const [code, signal] = await new Promise((r) => c.once('exit', (...a) => r(a)));
  assert.equal(signal, 'SIGTERM', `it ends by the signal, as it would without the recorder (code ${code})`);
  const got = lines(out);
  assert.ok(Number.isFinite(got.at(-1).end), 'its end is written');
  assert.ok(
    got.some((l) => l.files?.includes('services/svc-x/src/work.ts')),
    'what it ran before the signal is written',
  );
});

test('the stack starts a Node service with the preload, which writes nothing a request carried', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-reach-'));
  const code = codeReachDir(dir);
  assert.equal(code, path.join(dir, 'logs', 'code'));
  const node = nodeServiceReach(code, 'bank', { A: '1' });
  assert.deepEqual(node.flags, ['--import', pathToFileURL(PRELOAD).href]);
  assert.equal(node.env.A, '1');
  assert.equal(node.env[CODE_REACH_ENV], path.join(code, 'bank.jsonl'));
  assert.throws(() => nodeServiceReach(code, '../bank', {}), /not a service name/);
  const script = path.join(dir, 'svc.mjs');
  writeFileSync(script, 'setTimeout(() => {}, 150);\n');
  const r = spawnSync(process.execPath, [...node.flags, script], { env: { ...process.env, ...node.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = lines(node.env[CODE_REACH_ENV]);
  assert.ok(Number.isFinite(got[0].start) && Number.isFinite(got.at(-1).end), 'the preload ran: a start and an end');
  assert.ok(
    got.every((l) => !l.files),
    'a file outside services/svc-*/dist is never named',
  );
  // Imported for its helpers (the stack, the journey harness), it records nothing.
  const quiet = path.join(dir, 'quiet.jsonl');
  const q = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(PRELOAD).href)})`], {
    env: { ...process.env, [CODE_REACH_ENV]: quiet },
  });
  assert.equal(q.status, 0);
  assert.throws(() => readFileSync(quiet), /ENOENT/);
});

test('a window goes to every journey file that ran inside it; a killed process and a silent one are gaps', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-reach-'));
  const bank = path.join(dir, 'bank.jsonl');
  const pay = path.join(dir, 'pay.jsonl');
  const w = (f, o) => appendFileSync(f, `${JSON.stringify(o)}\n`);
  // What ran before the reader starts (the stack's own start) is nobody's.
  w(bank, { pid: 1, start: 0 });
  w(bank, { pid: 1, from: 0, to: 50, files: ['services/svc-bank/src/boot.ts'] });
  w(pay, { pid: 7, start: 0 });
  const reader = makeCodeReader(dir);
  const rec = makeRecorder({ root: dir, distDir: null, routes: [], bus: false, codeServices: () => reader.services() });
  rec.enter('J-a-01.pw.mjs', 100);
  rec.enter('J-b-02.pw.mjs', 200);
  rec.enter('J-c-03.pw.mjs', 300);
  w(bank, { pid: 1, from: 50, to: 150, files: ['services/svc-bank/src/cards/card-service.ts', '../../etc/passwd'] });
  w(bank, { pid: 1, from: 150, to: 210 });
  w(bank, { pid: 1, from: 210, to: 250, files: ['services/svc-bank/src/loans/loan-service.ts'] });
  // Killed with no end: the next process's start means what the first ran after its last window is lost.
  w(bank, { pid: 2, start: 320 });
  w(bank, { pid: 2, from: 320, to: 400 });
  w(pay, { pid: 7, from: 0, to: 400 });
  w(pay, { pid: 7, end: 400 });
  rec.code(reader.read());
  assert.deepEqual(reader.lag(400), [], 'every live process has written up to 400');
  assert.deepEqual(reader.lag(450), ['bank'], 'bank has not written past 400 yet; pay has ended');
  await settleCode(reader, rec, { now: 450, waitMs: 0 });
  const a = rec.take('J-a-01.pw.mjs');
  const b = rec.take('J-b-02.pw.mjs');
  const c = rec.take('J-c-03.pw.mjs');
  assert.deepEqual(a.codeServices, ['bank', 'pay']);
  assert.deepEqual(a.code, ['services/svc-bank/src/cards/card-service.ts'], 'a path of any other shape is dropped');
  assert.equal(a.code.includes('services/svc-bank/src/boot.ts'), false, "what ran before the reader started is nobody's");
  assert.deepEqual(b.code, ['services/svc-bank/src/loans/loan-service.ts'], 'a window before the file began is not its');
  assert.deepEqual(c.code, []);
  assert.deepEqual(a.codeGap, []);
  assert.deepEqual(b.codeGap, ['bank'], 'pid 1 ran unread from 250 to 320, inside J-b and J-c');
  assert.deepEqual(c.codeGap, ['bank'], 'bank wrote nothing past 400, and the read was at 450');
  assert.deepEqual(reader.lag(450), [], 'a gap is counted once');
});

test('with no service recording, a record carries no code fields', () => {
  const rec = makeRecorder({ root: '/nowhere', distDir: null, routes: [], bus: false, codeServices: () => [] });
  rec.enter('J-a-01.pw.mjs', 1);
  rec.served([{ service: 'bank', time: 2, served: false }], 'J-a-01.pw.mjs');
  const r = rec.take('J-a-01.pw.mjs');
  assert.equal('codeServices' in r, false);
  assert.equal('code' in r, false);
});

test("the reader starts at each file's last process: an earlier process's history is never read", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-reach-'));
  const bank = path.join(dir, 'bank.jsonl');
  const w = (o) => appendFileSync(bank, `${JSON.stringify(o)}\n`);
  // Over 2 MiB of an earlier process, ended, then the live one: the start line sits past the first 1 MiB step back.
  w({ pid: 1, start: 0 });
  const many = Array.from({ length: 400 }, (_, i) => `services/svc-bank/src/a/f${i}.ts`);
  for (let t = 0; t < 200; t++) w({ pid: 1, from: t, to: t + 1, files: many });
  w({ pid: 1, end: 200 });
  const at = statSync(bank).size;
  assert.ok(at > 2 * 2 ** 20);
  w({ pid: 2, start: 300 });
  w({ pid: 2, from: 300, to: 350 });
  assert.equal(lastStart(bank), at, 'the offset of the last start line');
  const reader = makeCodeReader(dir);
  assert.deepEqual(reader.lag(350), [], 'pid 2 is the live process and has written up to 350');
  assert.deepEqual(reader.lag(400), ['bank']);
  assert.deepEqual(reader.read(), [], 'nothing written before the reader started is returned');
  const one = path.join(dir, 'pay.jsonl');
  appendFileSync(one, `${JSON.stringify({ pid: 7, start: 0 })}\n`);
  assert.equal(lastStart(one), 0, 'a file that is one process from its first line');
  // Every boundary of a 1 MiB step: a start line split across two steps is still found.
  for (const pad of [2 ** 20 - 30, 2 ** 20 - 5, 2 ** 20, 2 ** 20 + 3]) {
    const f = path.join(dir, `ledger.jsonl`);
    writeFileSync(f, `${'x'.repeat(pad - 1)}\n`);
    const start = statSync(f).size;
    appendFileSync(f, `${JSON.stringify({ pid: 3, start: 1 })}\n${'y'.repeat(2 ** 20)}\n`);
    assert.equal(lastStart(f), start, `pad ${pad}`);
  }
});
