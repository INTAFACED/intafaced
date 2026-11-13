/**
 * PROTECTED TESTS — the one list of test files that keep every protection the test-diff guard gives.
 *
 * Tests of money, custody, sign-in and permissions, and journey tests, keep every protection they have today. A test
 * anywhere else may be deleted or rewritten when what it guarded is still guarded (a type, a lint rule, another test or
 * a journey step) and the pull request names which; the CI review checks that name (REVIEW.md item 3).
 *
 * test-diff-guard.mjs reads this file from main's copy beside it (ci.yml copies the guard's imports from main), so a
 * pull request cannot shrink the list it is judged by. Any tool that deletes tests
 * refuses every path this names too.
 *
 * Wider than the money roots on purpose: a path is protected when any one of these says so, and a wrong "protected"
 * only asks for a Test-change line, as every test change did before.
 */
import { MONEY_PATH_ROOTS } from './money-skip-inventory.mjs';

/** Whole folders: the money roots, identity (sign-in, sessions, permissions), auth, and the smart-account custody service. */
export const PROTECTED_ROOTS = [...MONEY_PATH_ROOTS, 'services/svc-identity', 'packages/auth', 'services/svc-protocol'];

/** File shapes: money suites, database suites, and every browser journey or harness. */
const PROTECTED_FILE = /\.(?:money|db|pg)\.test\.[cm]?[jt]sx?$|\.pw\.mjs$/;

/**
 * Tests of sign-in, permissions, custody and money outside those folders carry no one suffix; their file or folder
 * names do (measured 13 Nov 2026: `AuthForm.test.tsx`, `operator-access.test.ts`, `custody-ops/model.test.ts`,
 * `roles.pin.test.ts`, `signin-methods.test.ts`, `features/pay/...`). A path segment is matched after camelCase is
 * split, so `SessionKeysPanel` reads as `session-keys-panel`.
 */
const PROTECTED_WORD =
  /(?:^|[/._-])(?:auth[a-z]*|sign-?(?:in|up|out)|log-?(?:in|out)|sessions?|permissions?|rbac|roles?|access|passkeys?|webauthn|mfa|2fa|t?otp|jwt|oauth|step-?up|freeze|frozen|custody|custodial|sanctions?|kyc|kyb|kill-?switch|recovery|money|ledger|wallets?|withdraw[a-z]*|deposits?|transfers?|pay|payments?|payouts?|balances?|escrow|settle[a-z]*)(?=$|[/._-])/;

const words = (path) => path.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Whether a test file at `path` (repository-relative, forward slashes) keeps every protection it has today. */
export function protectedTest(path) {
  const p = String(path ?? '');
  if (PROTECTED_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return true;
  if (PROTECTED_FILE.test(p)) return true;
  return PROTECTED_WORD.test(words(p));
}
