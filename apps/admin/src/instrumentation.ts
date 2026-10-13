/**
 * Runs once when the admin server starts (not during `next build`). A server in
 * production posture refuses to boot on dev keys, the Anvil chain or published
 * passwords — see packages/config/src/production-posture.ts.
 *
 * It EXITS rather than throwing: a throw from register() leaves `next start` alive with the
 * port bound, answering 500 to everything, which no restart policy or alert reads as a crash.
 * The message names variables, never values.
 */
export async function register(
  env: Record<string, unknown> = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  if (env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertProductionPosture } = await import('@intafaced/config');
  try {
    assertProductionPosture(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'admin.production_posture_refused');
    exit(1);
  }
}
