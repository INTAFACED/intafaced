/**
 * execution.sor fleet compose wiring — honest checks for durable EMS + operator cred pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Slice the svc-execution service out of compose text.
 * JavaScript `\Z` matches the letter Z. End of input is `(?![\s\S])`.
 * `/m` makes `$` the end of a line, so it is not the end of the file.
 */
export function matchExecutionComposeBlock(compose: string): string {
  const match = compose.match(/^  svc-execution:\n(?:.*\n)*?(?=^  [a-z#]|(?![\s\S]))/m);
  if (!match) throw new Error('svc-execution service block missing from docker-compose.apps.yml');
  return match[0];
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
