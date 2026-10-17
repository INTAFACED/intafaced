/**
 * Copy residual sentences are operator text. One stderr line per code per process.
 * Spec ids stay in refusal-spec-log.ts. This line is the sentence only.
 */

const logged = new Set<string>();

export function logCopyResidual(code: string, residual: string): void {
  if (!residual || logged.has(code)) return;
  logged.add(code);
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'trade.copy.residual', code, residual })}\n`);
}

/** Tests only. Production keeps the once-per-process guard. */
export function resetCopyResidualLogForTests(): void {
  logged.clear();
}
