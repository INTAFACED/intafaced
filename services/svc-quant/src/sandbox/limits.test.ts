import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  QUANT_QUOTA_RESOURCES,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createPaperBook } from './book.js';
import { ESCAPE_CORPUS } from './escape-corpus.js';
import { runIsolate } from './isolate.js';

// J-algo-dev-12 (AL-limits-02): sandbox limits by plan, the developer's limits read, and the escape corpus.
const SECRET = 'a-quant-sandbox-limits-test-edge-secret';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

const PLAN = 'TEST default';
const FULL = { wall_clock_ms: 5_000n, memory_bytes: 1_000_000n, output_bytes: 100_000n } as const;

async function setup(sandbox: Partial<Record<keyof typeof FULL, bigint>> = FULL) {
  const quota = createMemoryQuota({ defaultProfile: PLAN, sandbox });
  const runs = createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate);
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    paperFeeBps: '0',
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(quota.gate),
    runs,
    quota: quota.repository,
  });
  let seq = 0;
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  const setSandbox = (limit: keyof typeof FULL, value: string | null, reason = 'LOCAL TEST sandbox limit') => {
    seq += 1;
    return writer.ops.quota.sandbox({ profile: PLAN, limit, value, reason, idempotencyKey: `quant.sandbox:${PLAN}:${limit}:${seq}` });
  };
  // The plan's quotas, set so only the sandbox limits decide here.
  for (const resource of QUANT_QUOTA_RESOURCES) {
    await writer.ops.quota.set({ profile: PLAN, resource, limit: '100', reason: 'LOCAL TEST quota', idempotencyKey: `quota:${resource}` });
  }
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    writer,
    reader: app.createCaller(signed(OPERATOR, ['admin:read'])),
    setSandbox,
    runs,
  };
}

const run = (key: string, source = 'console.log("hello")') => ({
  language: 'javascript' as const,
  source,
  cash: '1000',
  environment: 'paper',
  idempotencyKey: key,
});

describe('sandbox limits by plan (J-algo-dev-12)', () => {
  it('#3 names the unset limit before the run starts, and nothing is recorded', async () => {
    const { a, setSandbox } = await setup({ wall_clock_ms: 5_000n, output_bytes: 100_000n });
    await expect(a.sandbox.run(run('unset-1'))).rejects.toThrow(/^quant\.sandbox_limit_unset — memory_bytes: /);
    // The same key after the limit is set runs once: the refused start stored no run under it.
    await setSandbox('memory_bytes', '1000000');
    await expect(a.sandbox.run(run('unset-1'))).resolves.toMatchObject({ ok: true, logs: ['hello'] });
    // A limit put back to blank refuses again by name.
    await setSandbox('wall_clock_ms', null);
    await expect(a.sandbox.run(run('unset-2'))).rejects.toThrow(/^quant\.sandbox_limit_unset — wall_clock_ms: /);
  });

  it('#3 a saved strategy start names the unset limit too', async () => {
    const { a } = await setup({ wall_clock_ms: 5_000n, memory_bytes: 1_000_000n });
    const saved = await a.studio.save({
      name: 'TEST strategy',
      blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '10000',
      environment: 'paper',
      clientStrategyId: 'client-1',
      idempotencyKey: 'save-1',
    });
    await expect(a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-1' })).rejects.toThrow(
      /^quant\.sandbox_limit_unset — output_bytes: /,
    );
  });

  it('#1 a sandbox limit with no reason is refused and nothing changes; only an operator may set one', async () => {
    const { a, reader, setSandbox } = await setup();
    await expect(setSandbox('memory_bytes', '5', '   ')).rejects.toThrow(/^quant\.quota_reason_unset/);
    const read = await reader.ops.quota.profile({ profile: PLAN });
    expect(read.sandbox.find((row) => row.limit === 'memory_bytes')?.value).toBe('1000000');
    await expect(
      a.ops.quota.sandbox({ profile: PLAN, limit: 'memory_bytes', value: '5', reason: 'mine', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setSandbox('memory_bytes', 'lots')).rejects.toThrow(/^quant\.params_invalid/);
  });

  it('#4 the developer reads every limit with its current value; blank reads null', async () => {
    const { a, setSandbox } = await setup();
    await setSandbox('output_bytes', null);
    const limits = await a.limits.get();
    expect(limits.profile).toBe(PLAN);
    expect(limits.source).toBe('default');
    expect(limits.sandbox).toEqual([
      { limit: 'wall_clock_ms', value: '5000' },
      { limit: 'memory_bytes', value: '1000000' },
      { limit: 'output_bytes', value: null },
    ]);
    expect(limits.ceilings).toEqual({ maxOps: '5000', maxSource: '8000' });
  });

  it('#5 every escape case ends in a typed refusal and the control run after them still runs', async () => {
    const { writer, a } = await setup();
    const ran = await writer.ops.sandbox.corpus({ profile: PLAN });
    expect(ran.cases).toHaveLength(ESCAPE_CORPUS.length);
    for (const c of ran.cases) expect(c.code, c.id).toMatch(/^quant\.sandbox_(escape|syntax|memory|output|timeout)$/);
    const by = Object.fromEntries(ran.cases.map((c) => [c.id, c.code]));
    expect(by['memory-bomb']).toBe('quant.sandbox_memory');
    expect(by['huge-output']).toBe('quant.sandbox_output');
    expect(by['network']).toBe('quant.sandbox_escape');
    expect(ran.control).toEqual({ ok: true, code: null, logs: ['control run after the escape corpus'] });
    // A developer's own run afterwards is unaffected.
    await expect(a.sandbox.run(run('after-corpus'))).resolves.toMatchObject({ ok: true, logs: ['hello'] });
    // The corpus is an operator's action.
    await expect(a.ops.sandbox.corpus({ profile: PLAN })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('#5 the corpus refuses by name under a profile whose limits are not set', async () => {
    const { writer } = await setup();
    await expect(writer.ops.sandbox.corpus({ profile: 'TEST nothing set' })).rejects.toThrow(
      /^quant\.sandbox_limit_unset — wall_clock_ms: /,
    );
  });
});

describe('the isolate enforces the run limits from outside the strategy', () => {
  const book = () => createPaperBook({ startingCash: '1000', venueVaultSet: false, feeBps: '0' });
  const limits = (run: { wallClockMs: number; memoryBytes: number; outputBytes: number }) => ({ maxOps: 50_000, maxSource: 64_000, run });

  it('refuses a run with no plan limits before interpreting anything', () => {
    expect(() => runIsolate('javascript', 'console.log("x")', book(), { maxOps: 5_000, maxSource: 8_000 }, true)).toThrow(
      /^quant\.sandbox_limit_unset/,
    );
  });

  it('stops text from growing past the memory limit before it is made', () => {
    const src = ['let s = "xxxxxxxxxxxxxxxx"', ...Array.from({ length: 30 }, () => 's = s + s')].join('\n');
    expect(() =>
      runIsolate('javascript', src, book(), limits({ wallClockMs: 5_000, memoryBytes: 64_000, outputBytes: 1_000 }), true),
    ).toThrow(/^quant\.sandbox_memory — memory_bytes: 65536 bytes would pass the limit of 64000 bytes/);
    // Two variables that each fit but together pass it are refused too.
    const two = 'let a = "' + 'x'.repeat(300) + '"\nlet b = "' + 'y'.repeat(300) + '"';
    expect(() =>
      runIsolate('javascript', two, book(), limits({ wallClockMs: 5_000, memoryBytes: 1_000, outputBytes: 1_000 }), true),
    ).toThrow(/^quant\.sandbox_memory/);
  });

  it('ends the run when the log reaches the output limit', () => {
    const src = 'console.log("0123456789")\nconsole.log("0123456789")\nconsole.log("0123456789")';
    expect(() => runIsolate('javascript', src, book(), limits({ wallClockMs: 5_000, memoryBytes: 10_000, outputBytes: 25 }), true)).toThrow(
      /^quant\.sandbox_output — output_bytes: the log reached the limit of 25 bytes after 2 lines/,
    );
    expect(
      runIsolate('javascript', src, book(), limits({ wallClockMs: 5_000, memoryBytes: 10_000, outputBytes: 33 }), true).logs,
    ).toHaveLength(3);
  });

  it('ends the run at the wall-clock limit', () => {
    // A zero limit is a deliberate value: the first operation after any time has passed ends the run.
    const src = Array.from({ length: 2_000 }, (_, i) => `let v${i % 5} = "${i}"`).join('\n');
    expect(() => runIsolate('javascript', src, book(), limits({ wallClockMs: 0, memoryBytes: 100_000, outputBytes: 100 }), true)).toThrow(
      /^quant\.sandbox_timeout — wall_clock_ms: exceeded 0 ms/,
    );
  });
});
