/**
 * Runs once when the admin server starts (not during `next build`). A server in
 * production posture refuses to boot on dev keys, the Anvil chain or published
 * passwords — see packages/config/src/production-posture.ts.
 */
export async function register(env: Record<string, unknown> = process.env): Promise<void> {
  if (env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertProductionPosture } = await import('@intafaced/config');
  assertProductionPosture(env);
}
