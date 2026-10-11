/**
 * ops.admin mount vs tracker — operator console honest gaps.
 *
 * Kill-switch + ledger freeze + operator-tools BFF proxies on tip.
 * Fee/listing writes and Class X SSO/ACL remain residuals.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminBffSecretComposeWired } from './admin-compose-wiring.js';

export const OPS_ADMIN_TRACKER_ID = 'ops.admin' as const;

export const ADMIN_CONSOLE_PAGES = [
  'app/(console)/tools/page.tsx',
  'app/(console)/ledger/page.tsx',
  'app/(console)/launch/page.tsx',
  'app/(console)/jurisdiction/page.tsx',
] as const;

export const ADMIN_API_ROUTES = [
  'app/api/kill-switch/route.ts',
  'app/api/operator-tools/route.ts',
  'app/api/ledger-freeze/route.ts',
] as const;

export const ADMIN_DONE_BAR_TEST_FILES = [
  'lib/console-status.test.ts',
  'lib/operator-commands.test.ts',
  'app/api/operator-tools/route.test.ts',
  'lib/admin-compose-wiring.test.ts',
] as const;

export const OPS_ADMIN_HONEST_GAPS = ['gap.fee_listing_write_paths', 'gap.class_x_sso_acl'] as const;

const ADMIN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

export function adminConsolePagesPresent(): readonly string[] {
  return ADMIN_CONSOLE_PAGES.filter((rel) => existsSync(join(ADMIN_SRC, rel)));
}

export function adminApiRoutesPresent(): readonly string[] {
  return ADMIN_API_ROUTES.filter((rel) => existsSync(join(ADMIN_SRC, rel)));
}

export function adminBffGatePresent(): boolean {
  const src = readFileSync(join(ADMIN_SRC, 'lib/admin-bff-gate.ts'), 'utf8');
  return /adminBffGate/.test(src) && /authorizeAdminRequest/.test(src);
}

export function operatorToolsCatalogPresent(): boolean {
  const src = readFileSync(join(ADMIN_SRC, 'lib/operator-tools-catalog.ts'), 'utf8');
  return /OperatorTool/.test(src) && /never a local green success/.test(src);
}

export function adminDoneBarTestsPresent(): boolean {
  return ADMIN_DONE_BAR_TEST_FILES.every((rel) => existsSync(join(ADMIN_SRC, rel)));
}

export function opsAdminTrackerBackendDoneBarMet(): boolean {
  return (
    adminConsolePagesPresent().length === ADMIN_CONSOLE_PAGES.length &&
    adminApiRoutesPresent().length === ADMIN_API_ROUTES.length &&
    adminBffGatePresent() &&
    operatorToolsCatalogPresent() &&
    adminDoneBarTestsPresent() &&
    adminBffSecretComposeWired()
  );
}

export function opsAdminMountVsTrackerBoardCard(): {
  readonly tracker: typeof OPS_ADMIN_TRACKER_ID;
  readonly pages: number;
  readonly pagesPresent: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const present = adminConsolePagesPresent();
  return {
    tracker: OPS_ADMIN_TRACKER_ID,
    pages: ADMIN_CONSOLE_PAGES.length,
    pagesPresent: present.length,
    gaps: OPS_ADMIN_HONEST_GAPS.length,
    backendDoneBarMet: opsAdminTrackerBackendDoneBarMet(),
  };
}
