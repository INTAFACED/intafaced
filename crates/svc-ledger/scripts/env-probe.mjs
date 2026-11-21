// One environment through the TypeScript svc-ledger's `env.ts`, in a fresh process (it reads `process.env` once, on
// import): prints the parsed environment as JSON, or the refusal's message. Run by `record-door.mjs`.

import { existsSync } from 'node:fs';

if (!existsSync(new URL('../../../services/svc-ledger/src/env.ts', import.meta.url))) {
  console.error('env-probe: services/svc-ledger no longer exists; nothing to probe.');
  process.exit(2);
}

const vars = JSON.parse(process.env.LEDGER_ENV_PROBE ?? '{}');
for (const k of Object.keys(process.env)) if (k !== 'PATH' && k !== 'TZ') delete process.env[k];
Object.assign(process.env, vars);
try {
  const m = await import('../../../services/svc-ledger/src/env.ts');
  const rails = (map) => Object.fromEntries(map.entries());
  process.stdout.write(
    JSON.stringify({
      ok: {
        env: m.env,
        clockSkewBoundMs: m.clockSkewBoundMs,
        idempotencyConflictMode: m.idempotencyConflictMode,
        railStatementUrls: rails(m.railStatementUrls),
        openItemsUrls: rails(m.openItemsUrls),
      },
    }),
  );
} catch (err) {
  process.stdout.write(JSON.stringify({ refused: err instanceof Error ? err.message : String(err) }));
}
