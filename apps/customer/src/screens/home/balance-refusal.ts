import { classifyRefusal, refusalCopy } from './deps';

/**
 * The words Home's balance shows when the bank refuses it. A support reference ("Ref SCR-1") is there to quote to
 * support; "Verify your identity first" is not a fault to quote but a step the person takes, and its button opens
 * Verification, so that one is drawn without a reference.
 */
export function balanceRefusal(code: string) {
  const copy = refusalCopy(code);
  return classifyRefusal(code) === 'verify' ? { ...copy, reference: undefined } : copy;
}
