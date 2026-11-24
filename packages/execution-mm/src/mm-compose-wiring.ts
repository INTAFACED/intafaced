/**
 * execution.market-making fleet compose wiring — spread/skew owner env pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function executionComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-execution');
}

export function mmSpreadSkewBandsComposeWired(): boolean {
  const block = executionComposeBlock();
  return /EXECUTION_MM_SPREAD_SKEW_BANDS:\s*\$\{EXECUTION_MM_SPREAD_SKEW_BANDS:-\}/.test(block);
}
