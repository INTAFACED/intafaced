/**
 * execution.sor fleet compose wiring — honest checks for durable EMS + operator cred pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Slice the svc-execution service out of compose text. */
export function matchExecutionComposeBlock(compose: string): string {
  return composeServiceBlock(compose, 'svc-execution');
}

export function executionComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return matchExecutionComposeBlock(compose);
}

export function executionEmsStoreComposeWired(): boolean {
  const block = executionComposeBlock();
  return (
    /EXECUTION_EMS_STORE_PATH:\s*\$\{EXECUTION_EMS_STORE_PATH:-\/data\/execution\/ems-journal\.jsonl\}/.test(block) &&
    /execution-ems-journal:\/data\/execution/.test(block)
  );
}

export function executionVenueOperatorCredComposeWired(): boolean {
  const block = executionComposeBlock();
  return (
    /VENUE_AGGREGATION_BINANCE_SPOT_API_KEY:/.test(block) &&
    /VENUE_AGGREGATION_BYBIT_SPOT_API_SECRET:/.test(block) &&
    /VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE:/.test(block)
  );
}

export function executionLetterBpsScheduleComposeWired(): boolean {
  const block = executionComposeBlock();
  return /EXECUTION_SOR_LETTER_BPS_SCHEDULE:\s*\$\{EXECUTION_SOR_LETTER_BPS_SCHEDULE:-\}/.test(block);
}
