/**
 * ensure-streams (#10660): a JetStream call that times out on a busy machine is tried again from a new connection
 * and the streams are made; an error the server gave on purpose, or a timeout past the deadline, stops at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureAll } from './ensure-streams.mjs';

const natsError = (code, message) => Object.assign(new Error(message), { name: 'NatsError', code });

/** A fake bus: `fail(call)` returns the error the n-th ensure call throws, or nothing. */
function bus(fail) {
  const made = [];
  let calls = 0;
  let open = 0;
  let closed = 0;
  return {
    made,
    get opened() {
      return open;
    },
    get closed() {
      return closed;
    },
    connect: async () => {
      open++;
      return { jetstreamManager: async () => ({}), close: async () => void closed++ };
    },
    ensure: async (_jsm, m) => {
      const err = fail(++calls);
      if (err) throw err;
      made.push(m);
    },
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, pause: async (ms) => void (t += ms) };
};

test('a timeout on one call is tried again from a new connection, and every stream is made', async () => {
  const b = bus((n) => (n === 2 ? natsError('TIMEOUT', 'TIMEOUT') : null));
  const c = clock();
  const tries = await ensureAll({ modules: ['bank', 'edge', 'ledger'], connect: b.connect, ensure: b.ensure, ...c });
  assert.equal(tries, 2);
  assert.deepEqual(b.made.slice(-3), ['bank', 'edge', 'ledger']);
  assert.equal(b.opened, 2);
  assert.equal(b.closed, 2, 'the failed connection is closed too');
});

test('no responders and a dropped connection are transient too', async () => {
  for (const code of ['503', 'CONNECTION_REFUSED', 'DISCONNECT']) {
    const b = bus((n) => (n === 1 ? natsError(code, code) : null));
    assert.equal(await ensureAll({ modules: ['bank'], connect: b.connect, ensure: b.ensure, ...clock() }), 2, code);
  }
});

test('an error the server gave on purpose stops at once', async () => {
  const b = bus(() => natsError('BAD API', 'insufficient resources'));
  await assert.rejects(ensureAll({ modules: ['bank'], connect: b.connect, ensure: b.ensure, ...clock() }), /insufficient resources/);
  assert.equal(b.opened, 1);
});

test('a timeout that lasts past the deadline stops with that timeout', async () => {
  const b = bus(() => natsError('TIMEOUT', 'TIMEOUT'));
  await assert.rejects(
    ensureAll({ modules: ['bank'], connect: b.connect, ensure: b.ensure, retryForMs: 5_000, ...clock() }),
    (err) => err.code === 'TIMEOUT',
  );
  assert.equal(b.opened, 6, 'tried at 0, 1, 2, 3, 4 and 5 s, then gave up');
});

test('run as a script without NATS_URL it refuses by name', () => {
  const env = { ...process.env };
  delete env.NATS_URL;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./ensure-streams.mjs', import.meta.url))], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NATS_URL is unset/);
});
