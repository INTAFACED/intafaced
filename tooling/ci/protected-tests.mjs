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
 * Wider than the money roots on purpose: a path is protected when any one of these says so, and a wrong "protected"
 * only asks for a Test-change line, as every test change did before.
 */
import { MONEY_PATH_ROOTS } from './money-skip-inventory.mjs';

/**
 * Whole folders: the money roots; identity (sign-in, sessions, permissions) and auth; the gateway (svc-edge: API keys,
 * principals, the country check, the kill switch); the services and packages that place orders or move value through
 * an outside venue or chain (svc-execution, svc-dex, svc-fix, svc-agents' allowances, the venue and execution packages,
 * money-math, exchange-contract); operator controls (svc-ops: freezes, dual control); the smart-account custody service;
 * and service-kit (service-to-service signing). (Failure it prevents: the CI review's FAIL on 37203eff3f found
 * `services/svc-edge/src/api-key-revoked.test.ts`, `geo-block.test.ts` and `execution-kill-p07.e2e.test.ts` unprotected.)
 */
export const PROTECTED_ROOTS = [
  ...MONEY_PATH_ROOTS,
  'services/svc-identity',
  'packages/auth',
  'services/svc-protocol',
  'services/svc-edge',
  'services/svc-execution',
  'services/svc-dex',
  'services/svc-fix',
  'services/svc-agents',
  'services/svc-ops',
  'packages/service-kit',
  'packages/money-math',
  'packages/exchange-contract',
];

/** Folder prefixes: every venue and execution package (`packages/venue-hyperliquid`, `packages/execution-mm`, …). */
const PROTECTED_PREFIXES = ['packages/venue-', 'packages/execution-'];

/** File shapes: money suites, database suites, and every browser journey or harness. */
const PROTECTED_FILE = /\.(?:money|db|pg)\.test\.[cm]?[jt]sx?$|\.pw\.mjs$/;

/**
 * Tests of sign-in, permissions, custody and money outside those folders carry no one suffix; their file or folder
 * names do (measured 13 Nov 2026: `AuthForm.test.tsx`, `operator-access.test.ts`, `custody-ops/model.test.ts`,
 * `roles.pin.test.ts`, `signin-methods.test.ts`, `features/pay/...`). A path segment is matched after camelCase is
 * split, so `SessionKeysPanel` reads as `session-keys-panel`.
 */
const PROTECTED_WORD =
  /(?:^|[/._-])(?:auth[a-z]*|sign-?(?:in|up|out)|log-?(?:in|out)|sessions?|permissions?|rbac|roles?|access|passkeys?|webauthn|mfa|2fa|t?otp|jwt|oauth|step-?up|freeze|frozen|custody|custodial|sanctions?|kyc|kyb|kill(?:-?switch)?|recovery|api-?keys?|principals?|dual-?control|geo(?:-?block)?|authority|signatures?|signers?|s2s|secrets?|money|ledger|wallets?|withdraw[a-z]*|deposits?|transfers?|pay|payments?|payouts?|balances?|escrow|settle[a-z]*)(?=$|[/._-])/;

const words = (path) => path.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Whether a test file at `path` (repository-relative, forward slashes) keeps every protection it has today. */
export function protectedTest(path) {
  const p = String(path ?? '');
  if (PROTECTED_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return true;
  if (PROTECTED_PREFIXES.some((r) => p.startsWith(r))) return true;
  if (PROTECTED_FILE.test(p)) return true;
  return PROTECTED_WORD.test(words(p));
}
