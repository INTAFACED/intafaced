// One environment through the TypeScript svc-agents' `env.ts`, in a fresh process (it reads `process.env` once, on
// import): prints the parsed environment as JSON, or the refusal's message. Run by `record-door.mjs`.

import { existsSync } from 'node:fs';

if (!existsSync(new URL('../../../services/svc-agents/src/env.ts', import.meta.url))) {
  console.error('env-probe: services/svc-agents no longer exists (the Rust crate replaced it); nothing to probe.');
  process.exit(2);
}

const vars = JSON.parse(process.env.AGENTS_ENV_PROBE ?? '{}');
for (const k of Object.keys(process.env)) if (k !== 'PATH' && k !== 'TZ') delete process.env[k];
Object.assign(process.env, vars);
try {
  const { env } = await import('../../../services/svc-agents/src/env.ts');
  process.stdout.write(JSON.stringify({ ok: env }));
} catch (err) {
  process.stdout.write(JSON.stringify({ refused: err instanceof Error ? err.message : String(err) }));
}
