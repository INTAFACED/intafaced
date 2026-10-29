import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RECEIPT, runHostDispatch } from './host-dispatch.mjs';

const script = fileURLToPath(new URL('./host-dispatch.mjs', import.meta.url));
const customerIndex = '<!doctype html><html><body><div id="root"></div></body></html>';
const inviteIndex = '<!doctype html><html><body><div id="app"></div></body></html>';
const descriptor = JSON.stringify({ product: 'intafaced-customer', frontend: 'react', transport: 'same-origin', schemaVersion: 1 });
const edgeError = (path) => JSON.stringify([{ error: { message: 'No procedure', code: -32004, data: { code: 'NOT_FOUND', path } } }]);

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

/** One stub server per host. `handle(path)` returns [status, body] or null to leave the socket silent. */
async function stubs(handlers) {
  const servers = {};
  const hits = { apex: [], app: [], join: [] };
  const ports = {};
  for (const role of Object.keys(handlers)) {
    servers[role] = createServer((req, res) => {
      hits[role].push(`${req.method} ${req.url}`);
      const answer = handlers[role](req.url);
      if (answer === null) return;
      res.statusCode = answer[0];
      res.end(answer[1]);
    });
    ports[role] = await listen(servers[role]);
  }
  const names = { apex: 'apex.test', app: 'app.test', join: 'join.test' };
  // Each owner HTTPS host name is answered by its own local stub. The check itself still sees https origins.
  const fetchImpl = (url, init) => {
    const target = new URL(url);
    const role = Object.keys(names).find((key) => names[key] === target.hostname);
    if (!role || !ports[role]) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    return fetch(`http://127.0.0.1:${ports[role]}${target.pathname}${target.search}`, init);
  };
  const env = {
    INTAFACED_APEX_HOST: 'https://apex.test',
    INTAFACED_APP_HOST: 'https://app.test',
    INTAFACED_JOIN_HOST: 'https://join.test',
  };
  return { env, fetchImpl, hits, close: () => Promise.all(Object.values(servers).map(stop)) };
}

const healthy = {
  apex: () => [200, 'marketing'],
  app: (path) => (path === '/customer-deployment.json' ? [200, descriptor] : [200, customerIndex]),
  join: (path) => (path.startsWith('/api/ops/trpc/') ? [404, edgeError(path.slice('/api/ops/trpc/'.length))] : [200, inviteIndex]),
};

async function withRun(handlers, mutate, assertions) {
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-host-dispatch-'));
  const stub = await stubs(handlers);
  try {
    const receiptFile = join(temp, 'host-dispatch.json');
    const env = { ...stub.env, ...(mutate ?? {}) };
    await assertions({
      stub,
      env,
      receiptFile,
      temp,
      run: (extra = {}) => runHostDispatch({ env, fetchImpl: stub.fetchImpl, receiptFile, timeoutMs: 400, ...extra }),
    });
  } finally {
    await stub.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test('three served hosts write a receipt with a result and build id per host', async () => {
  await withRun(healthy, undefined, async ({ run, receiptFile, temp, stub }) => {
    const { ok, hosts } = await run({ now: () => new Date('2026-10-20T12:00:00Z') });
    assert.equal(ok, true);
    assert.deepEqual(
      hosts.map((host) => [host.role, host.host, host.result]),
      [
        ['apex', 'https://apex.test', 'served'],
        ['app', 'https://app.test', 'served'],
        ['join', 'https://join.test', 'served'],
      ],
    );
    for (const host of hosts) assert.match(host.buildId, /^[0-9a-f]{16}$/);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.status, 'served');
    assert.equal(receipt.checkedAt, '2026-10-20T12:00:00.000Z');
    assert.deepEqual(readdirSync(temp), ['host-dispatch.json'], 'no temp file is left behind');
    for (const role of ['apex', 'app', 'join'])
      assert.ok(
        stub.hits[role].every((hit) => hit.startsWith('GET ')),
        `${role}: GET only`,
      );
  });
});

test('the join host answering with the customer index is host.join_wrong_build', async () => {
  await withRun({ ...healthy, join: () => [200, customerIndex] }, undefined, async ({ run }) => {
    const { ok, hosts } = await run();
    assert.equal(ok, false);
    assert.equal(hosts.find((host) => host.role === 'join').result, 'host.join_wrong_build');
    assert.equal(hosts.find((host) => host.role === 'app').result, 'served');
  });
});

test('the app host not serving the customer descriptor is host.app_wrong_build', async () => {
  await withRun({ ...healthy, app: () => [200, inviteIndex] }, undefined, async ({ run }) => {
    const { hosts } = await run();
    assert.equal(hosts.find((host) => host.role === 'app').result, 'host.app_wrong_build');
  });
});

test('a blank host setting refuses by name and nothing is fetched', async () => {
  for (const [setting, code] of [
    ['INTAFACED_APEX_HOST', 'host.apex_unset'],
    ['INTAFACED_APP_HOST', 'host.app_unset'],
    ['INTAFACED_JOIN_HOST', 'host.join_unset'],
  ]) {
    await withRun(healthy, { [setting]: '  ' }, async ({ run, stub, receiptFile }) => {
      const { ok, hosts } = await run();
      assert.equal(ok, false);
      assert.deepEqual(
        hosts.map((host) => host.result),
        [code],
      );
      assert.deepEqual(stub.hits, { apex: [], app: [], join: [] }, setting);
      assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'refused');
    });
  }
});

test('http, credentials, paths and a disabled TLS check are refused before any fetch', async () => {
  for (const bad of ['http://app.test', 'https://user:pass@app.test', 'https://app.test/path', 'https://app.test?x=1', 'app.test']) {
    await withRun(healthy, { INTAFACED_APP_HOST: bad }, async ({ run, stub }) => {
      const { hosts } = await run();
      assert.deepEqual(
        hosts.map((host) => host.result),
        ['host.app_invalid'],
        bad,
      );
      assert.deepEqual(stub.hits, { apex: [], app: [], join: [] }, bad);
    });
  }
  await withRun(healthy, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, async ({ run, stub }) => {
    const { hosts } = await run();
    assert.deepEqual(
      hosts.map((host) => host.result),
      ['host.tls_verification_disabled'],
    );
    assert.deepEqual(stub.hits, { apex: [], app: [], join: [] });
  });
});

test('a host that does not resolve, answers an error, redirects or times out is host.not_served naming the host', async () => {
  await withRun({ apex: healthy.apex, join: healthy.join }, undefined, async ({ run }) => {
    const { hosts } = await run();
    const app = hosts.find((host) => host.role === 'app');
    assert.equal(app.result, 'host.not_served');
    assert.equal(app.host, 'https://app.test');
  });
  await withRun({ ...healthy, apex: () => [502, 'bad gateway'] }, undefined, async ({ run }) => {
    const { hosts } = await run();
    assert.equal(hosts.find((host) => host.role === 'apex').result, 'host.not_served');
  });
  await withRun({ ...healthy, apex: () => null }, undefined, async ({ run, receiptFile }) => {
    const { ok, hosts } = await run();
    assert.equal(ok, false);
    assert.equal(hosts.find((host) => host.role === 'apex').result, 'host.not_served');
    assert.equal(hosts.find((host) => host.role === 'join').result, 'served', 'one slow host does not hide the others');
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'refused');
  });
});

test('an api path whose prefix was rewritten is host.proxy_prefix_changed; a non-edge answer is host.proxy_unproven', async () => {
  const rewritten = {
    ...healthy,
    join: (path) => (path.startsWith('/api/ops/trpc/') ? [404, edgeError('ops/trpc/host-dispatch.probe')] : [200, inviteIndex]),
  };
  await withRun(rewritten, undefined, async ({ run }) => {
    const { ok, hosts } = await run();
    assert.equal(ok, false);
    const join = hosts.find((host) => host.role === 'join');
    assert.equal(join.result, 'host.proxy_prefix_changed');
    assert.match(join.detail, /ops\/trpc\/host-dispatch\.probe/);
  });
  // The index fallback answering the api path means the edge was never reached.
  await withRun({ ...healthy, join: () => [200, inviteIndex] }, undefined, async ({ run }) => {
    const { hosts } = await run();
    assert.equal(hosts.find((host) => host.role === 'join').result, 'host.proxy_unproven');
  });
});

test('a failed run keeps the last good receipt, marked stale with the failing run time; no half receipt is written', async () => {
  const good = healthy;
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-host-dispatch-'));
  const receiptFile = join(temp, 'host-dispatch.json');
  const stub = await stubs(good);
  try {
    const first = await runHostDispatch({
      env: stub.env,
      fetchImpl: stub.fetchImpl,
      receiptFile,
      timeoutMs: 400,
      now: () => new Date('2026-10-20T10:00:00Z'),
    });
    assert.equal(first.ok, true);
    // A second run with the join host down.
    const failing = await runHostDispatch({
      env: { ...stub.env, INTAFACED_JOIN_HOST: 'https://nowhere.test' },
      fetchImpl: stub.fetchImpl,
      receiptFile,
      timeoutMs: 400,
      now: () => new Date('2026-10-20T11:00:00Z'),
    });
    assert.equal(failing.ok, false);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.status, 'refused');
    assert.equal(receipt.lastGood.stale, true);
    assert.equal(receipt.lastGood.staleSince, '2026-10-20T11:00:00.000Z');
    assert.equal(receipt.lastGood.checkedAt, '2026-10-20T10:00:00.000Z');
    assert.equal(receipt.lastGood.status, 'served');
    // A third failing run keeps pointing at the same good run and the time it first went stale.
    await runHostDispatch({
      env: { ...stub.env, INTAFACED_JOIN_HOST: 'https://nowhere.test' },
      fetchImpl: stub.fetchImpl,
      receiptFile,
      timeoutMs: 400,
      now: () => new Date('2026-10-20T12:00:00Z'),
    });
    const third = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(third.lastGood.checkedAt, '2026-10-20T10:00:00.000Z');
    assert.equal(third.lastGood.staleSince, '2026-10-20T11:00:00.000Z');
    assert.equal(third.lastGood.lastGood, undefined);
    // A good run replaces it all.
    const recovered = await runHostDispatch({ env: stub.env, fetchImpl: stub.fetchImpl, receiptFile, timeoutMs: 400 });
    assert.equal(recovered.ok, true);
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).lastGood, undefined);
    assert.deepEqual(readdirSync(temp), ['host-dispatch.json']);
  } finally {
    await stub.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an unreadable earlier receipt is ignored, not trusted', async () => {
  await withRun({ ...healthy, apex: () => [500, ''] }, undefined, async ({ run, receiptFile }) => {
    writeFileSync(receiptFile, '{ not json');
    const { ok } = await run();
    assert.equal(ok, false);
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).lastGood, undefined);
  });
});

test('the command exits 1 with the typed code and writes a receipt when a setting is blank', () => {
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-host-dispatch-'));
  try {
    const receiptFile = join(temp, 'out.json');
    const result = spawnSync(process.execPath, [script, '--out', receiptFile], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /host\.apex_unset/);
    assert.match(result.stdout, /host\.app_unset/);
    assert.match(result.stdout, /host\.join_unset/);
    assert.equal(existsSync(receiptFile), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/** The local stack's own sites: real loopback servers, checked with the real fetch. */
async function withLoopback(handlers, assertions) {
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-host-dispatch-'));
  const servers = [];
  const env = { APP_ENV: 'test' };
  try {
    for (const [role, setting] of [
      ['apex', 'INTAFACED_APEX_HOST'],
      ['app', 'INTAFACED_APP_HOST'],
      ['join', 'INTAFACED_JOIN_HOST'],
    ]) {
      const server = createServer((req, res) => {
        const [status, body] = handlers[role](req.url);
        res.statusCode = status;
        res.end(body);
      });
      servers.push(server);
      env[setting] = `http://127.0.0.1:${await listen(server)}`;
    }
    await assertions({ env, receiptFile: join(temp, 'host-dispatch.json') });
  } finally {
    await Promise.all(servers.map(stop));
    rmSync(temp, { recursive: true, force: true });
  }
}

test('LOCAL TEST: three served loopback sites write a receipt marked test, with each host and its result', async () => {
  await withLoopback(healthy, async ({ env, receiptFile }) => {
    const { ok, written } = await runHostDispatch({ env, receiptFile, localTest: true, timeoutMs: 2000 });
    assert.equal(ok, true);
    assert.equal(written, true);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.test, true);
    assert.equal(receipt.status, 'served');
    assert.deepEqual(
      receipt.hosts.map((host) => [host.role, host.host, host.result]),
      [
        ['apex', env.INTAFACED_APEX_HOST, 'served'],
        ['app', env.INTAFACED_APP_HOST, 'served'],
        ['join', env.INTAFACED_JOIN_HOST, 'served'],
      ],
    );
  });
});

test('LOCAL TEST: a blank or non-loopback host is refused by name and nothing is written or fetched', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-host-dispatch-'));
  try {
    const receiptFile = join(temp, 'host-dispatch.json');
    const fetchImpl = () => assert.fail('nothing is fetched');
    const blank = await runHostDispatch({ env: { APP_ENV: 'test' }, receiptFile, localTest: true, fetchImpl });
    assert.deepEqual(
      blank.hosts.map((host) => host.result),
      ['host.apex_unset', 'host.app_unset', 'host.join_unset'],
    );
    assert.equal(blank.written, false);
    const env = {
      APP_ENV: 'dev',
      INTAFACED_APEX_HOST: 'https://intafaced.com',
      INTAFACED_APP_HOST: 'http://localhost:3210',
      INTAFACED_JOIN_HOST: 'http://127.0.0.1',
    };
    const elsewhere = await runHostDispatch({ env, receiptFile, localTest: true, fetchImpl });
    assert.deepEqual(
      elsewhere.hosts.map((host) => host.result),
      ['host.apex_invalid', 'host.app_invalid', 'host.join_invalid'],
    );
    assert.equal(existsSync(receiptFile), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('LOCAL TEST: refused outside a dev or test APP_ENV, and never into the receipt a build publishes', async () => {
  await withLoopback(healthy, async ({ env, receiptFile }) => {
    for (const APP_ENV of [undefined, 'staging', 'production', 'prod', 'TEST']) {
      const run = await runHostDispatch({ env: { ...env, APP_ENV }, receiptFile, localTest: true });
      assert.deepEqual(run.hosts, [{ role: 'all', host: null, result: 'host.local_test_refused' }]);
      assert.equal(run.written, false);
    }
    assert.equal(existsSync(receiptFile), false);
    const before = existsSync(DEFAULT_RECEIPT) ? readFileSync(DEFAULT_RECEIPT, 'utf8') : null;
    const cli = spawnSync(process.execPath, [script, '--local-test'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /host dispatch \(TEST\): all \(not checked\) host\.local_test_refused/);
    assert.match(cli.stdout, /no receipt written/);
    assert.equal(existsSync(DEFAULT_RECEIPT) ? readFileSync(DEFAULT_RECEIPT, 'utf8') : null, before);
  });
});

test('LOCAL TEST: the command checks loopback sites with the real fetch and exits 0', async () => {
  await withLoopback(healthy, async ({ env, receiptFile }) => {
    // Spawned without blocking, so this process's loopback servers can answer the command.
    const cli = await new Promise((done) => {
      const child = spawn(process.execPath, [script, '--local-test', '--out', receiptFile], { env: { PATH: process.env.PATH, ...env } });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stdout += chunk));
      child.on('close', (status) => done({ status, stdout }));
    });
    assert.equal(cli.status, 0, cli.stdout);
    assert.match(cli.stdout, new RegExp(`host dispatch \\(TEST\\): app ${env.INTAFACED_APP_HOST} served`));
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).test, true);
  });
});
