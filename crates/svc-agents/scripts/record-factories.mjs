// Records, from the TypeScript svc-agents in this checkout, what the Rust factories slice is held to
// (`tests/factories_parity.rs`): for each factory, every case in `scripts/factories/<factory>.mjs` sent through the
// router's caller as the person it names (scopes, tier) under the tier laws it names, at a fixed clock, and the answer:
// the data the call returned (after its output schema), or its error's code and message. One file per factory,
// `tests/fixtures/factories/<factory>.golden.json`.
//
// A case file exports `cases` (`{ name, path, input?, tier?, scopes?, laws? }`; `laws` is `AGENTS_TIER_LAWS`'s text)
// and may export `deps(c)`, the router dependencies a case adds (a port double); the Rust test builds the same double.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-agents^..." build`):
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-factories.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-factories.mjs --check  fails when one is stale
//
// It stops being runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-agents/src/`;
const NAME = 'record-factories';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-agents no longer exists; the files it wrote are the reference now.`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

// The fixed clock both sides read: 2026-11-19T00:00:00Z, the wire replay's.
export const FIXED_MS = Date.UTC(2026, 10, 19);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_MS);
    else super(...args);
  }
  static now() {
    return FIXED_MS;
  }
}
globalThis.Date = FixedDate;

const { createAgentsRouter } = await import(`${SVC}router.ts`);
const { parseTierLaws } = await import(`${SVC}tier-laws.ts`);
const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const { createEdgeContext, encodePrincipal, signPrincipalHeader } = await load('@intafaced/contracts');

export const SECRET = 'placeholder-agents-record-factories-edge-secret';
export const USER = '11111111-1111-4111-8111-111111111111';

const ctx = (c) => {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: c.scopes ?? ['agents:read', 'agents:execute', 'identity:write'],
    tier: c.tier ?? 'basic',
    mfa: false,
    expiresAt: new RealDate('2099-01-01T00:00:00.000Z'),
  });
  return createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' })({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-record-factories',
  });
};

/** The router as the wire replay builds it: every optional dependency left out, the fee asset `fixture-asset`. */
const baseDeps = (c) => ({
  runtime: {},
  gateway: { routingTable: { routes: [] } },
  meter: {},
  feeAssetId: 'fixture-asset',
  tierLaws: parseTierLaws(c.laws ?? undefined),
});

async function answer(router, c) {
  const caller = router.createCaller(ctx(c));
  const fn = c.path.split('.').reduce((o, k) => o[k], caller);
  try {
    const data = c.input === undefined ? await fn() : await fn(c.input);
    return { data: data === undefined ? null : data };
  } catch (err) {
    return { error: { code: err.code ?? 'UNKNOWN', message: err.message } };
  }
}

const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const dir = `${CRATE}tests/fixtures/factories/`;
mkdirSync(dir, { recursive: true });
const sources = fileURLToPath(new URL('./factories/', import.meta.url));
let stale = 0;
for (const file of readdirSync(sources)
  .filter((f) => f.endsWith('.mjs'))
  .sort()) {
  const factory = file.replace(/\.mjs$/, '');
  const mod = await import(pathToFileURL(`${sources}${file}`).href);
  const out = [];
  for (const c of mod.cases) {
    const deps = { ...baseDeps(c), ...(mod.deps ? await mod.deps(c) : {}) };
    const router = createAgentsRouter(deps);
    out.push({
      name: c.name,
      path: c.path,
      ...(c.input === undefined ? {} : { input: c.input }),
      tier: c.tier ?? 'basic',
      scopes: c.scopes ?? ['agents:read', 'agents:execute', 'identity:write'],
      laws: c.laws ?? null,
      ...(c.port === undefined ? {} : { port: c.port }),
      answer: await answer(router, c),
    });
  }
  const target = `${dir}${factory}.golden.json`;
  const text = execFileSync(PRETTIER, ['--stdin-filepath', target], {
    input: `${JSON.stringify({ cases: out })}\n`,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(target, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${target.slice(ROOT.length)}`);
      stale += 1;
    }
  } else {
    writeFileSync(target, text);
    console.log(`${NAME}: ${factory}: ${out.length} cases`);
  }
}
if (CHECK) {
  if (stale > 0) process.exit(1);
  console.log(`${NAME}: up to date`);
}
