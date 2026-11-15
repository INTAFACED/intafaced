/**
 * PROTECTED TESTS — the one list of test files that keep every protection the test-diff guard gives.
 *
 * Tests of money, custody, sign-in and permissions, and journey tests, keep every protection they have today. A test
 * anywhere else may be deleted or rewritten when what it guarded is still guarded (a type, a lint rule, another test or
 * a journey step) and the pull request names which; the CI review checks that name (REVIEW.md item 3).
 *
 * test-diff-guard.mjs reads this file from main (ci.yml runs the guard from a worktree of main), so a
 * pull request cannot shrink the list it is judged by. Any tool that deletes tests
 * refuses every path this names too.
 *
 * Wide on purpose: a wrong "protected" only asks for a Test-change line, as every test change did before.
 */

/**
 * Protected unless free: every test is protected except in the customer app and the design kit, where most tests
 * check a screen's layout or copy. The operator console (`apps/admin`) stays protected whole: its tests hold approvals,
 * dual control, holds and staff gates. (Failure it prevents: a list of protected folders and words missed real tests twice; the CI review's
 * FAILs on 37203eff3f and 1b78912898 found svc-edge's API-key and country tests, the edge-trust suites of svc-quant,
 * svc-indexer and svc-mining-pool, and svc-mining-pool's PPLNS payout maths unprotected.) Services, packages other
 * than these, tooling and CI tests stay protected whatever their names.
 */
export const FREE_ROOTS = ['apps/customer', 'packages/ui', 'packages/i18n'];

/** File shapes: money suites, database suites, and every browser journey or harness. */
const PROTECTED_FILE = /\.(?:money|db|pg)\.test\.[cm]?[jt]sx?$|\.pw\.mjs$/;

/**
 * Tests of sign-in, permissions, custody and money inside the free folders carry no one suffix; their file or folder
 * names do (measured 13 Nov 2026: `AuthForm.test.tsx`, `operator-access.test.ts`, `custody-ops/model.test.ts`,
 * `roles.pin.test.ts`, `signin-methods.test.ts`, `features/pay/...`). A path segment is matched after camelCase is
 * split, so `SessionKeysPanel` reads as `session-keys-panel`.
 */
const PROTECTED_WORD =
  /(?:^|[/._-])(?:auth[a-z]*|sign-?(?:in|up|out)|log-?(?:in|out)|sessions?|permissions?|rbac|roles?|access|passkeys?|webauthn|mfa|2fa|t?otp|jwt|oauth|step-?up|freeze|frozen|custody|custodial|sanctions?|kyc|kyb|kill(?:-?switch)?|recovery|api-?keys?|principals?|dual-?control|geo(?:-?block)?|authority|signatures?|signers?|s2s|secrets?|money|ledger|wallets?|withdraw[a-z]*|deposits?|transfers?|pay|payments?|payouts?|balances?|escrow|settle[a-z]*|trust|identity|fees?|rewards?|owed|bank[a-z]*|limits?|caps?|prices?|orders?|passwords?|verif[a-z]*|approv[a-z]*|holds?|guards?|gates?|api|contracts?|csrf|cookies?|tokens?)(?=$|[/._-])/;

const words = (path) => path.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Whether a test file at `path` (repository-relative, forward slashes) keeps every protection it has today. */
export function protectedTest(path) {
  const p = String(path ?? '');
  if (!FREE_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return true;
  if (PROTECTED_FILE.test(p)) return true;
  return PROTECTED_WORD.test(words(p));
}
