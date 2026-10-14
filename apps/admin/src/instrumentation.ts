/**
 * Runs once when the admin server starts (not during `next build`). A server in
 * production posture refuses to boot on dev keys, the Anvil chain or published
 * passwords — see packages/config/src/production-posture.ts.
 *
 * It EXITS rather than throwing: a throw from register() leaves `next start` alive with the
 * port bound, answering 500 to everything, which no restart policy or alert reads as a crash.
 * The message names variables, never values.
 *
 * The same boot also refuses an invalid HSTS setting (`config.hsts_invalid`, see `lib/security-headers.mjs`). It lives here, not in
 * the edge middleware, because middleware cannot exit and a throw there is a 500 on every request.
 */
export async function register(
  env: Record<string, unknown> = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  if (env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertProductionPosture, isProductionPosture } = await import('@intafaced/config');
  try {
    assertProductionPosture(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'admin.production_posture_refused');
    exit(1);
    return;
  }
  const { HSTS_REFUSE_CODE, hstsIssues } = await import('./lib/security-headers.mjs');
  const issues = hstsIssues(env, { productionPosture: isProductionPosture(env) });
  if (issues.length > 0) {
    console.error(
      `ADMIN HSTS CONFIGURATION IS INVALID (${HSTS_REFUSE_CODE}). Refusing to start.\n` +
        issues.map((issue) => `  - ${issue.code} (${issue.variable})`).join('\n'),
    );
    exit(1);
  }
}
