// One environment through the TypeScript svc-academy's `env.ts`, in a fresh process (it reads `process.env` once, on
// import): prints the parsed environment as JSON, or the refusal's message. Run by `record-door.mjs`.

const vars = JSON.parse(process.env.ACADEMY_ENV_PROBE ?? '{}');
for (const k of Object.keys(process.env)) if (k !== 'PATH' && k !== 'TZ') delete process.env[k];
Object.assign(process.env, vars);
try {
  const { env } = await import('../../../services/svc-academy/src/env.ts');
  process.stdout.write(JSON.stringify({ ok: env }));
} catch (err) {
  process.stdout.write(JSON.stringify({ refused: err instanceof Error ? err.message : String(err) }));
}
