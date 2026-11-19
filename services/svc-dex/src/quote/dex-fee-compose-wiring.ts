/**
 * socket.dex-fee-source fleet compose wiring — CLOB fee + settlement owner env pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function dexComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-dex');
}

export function dexClobFeeBpsComposeWired(): boolean {
  const block = dexComposeBlock();
  return /DEX_CLOB_FEE_BPS:\s*\$\{DEX_CLOB_FEE_BPS:-\}/.test(block);
}

export function dexClobSettlementCostComposeWired(): boolean {
  const block = dexComposeBlock();
  return /DEX_CLOB_SETTLEMENT_COST:\s*'\$\{DEX_CLOB_SETTLEMENT_COST:-\}'/.test(block);
}

export function dexInternalBookFeeBpsComposeWired(): boolean {
  const block = dexComposeBlock();
  const emptyPassThrough = /DEX_INTERNAL_BOOK_FEE_BPS:\s*\$\{DEX_INTERNAL_BOOK_FEE_BPS:-\}/.test(block);
  const invented20 = block.includes('DEX_INTERNAL_BOOK_FEE_BPS: ${DEX_INTERNAL_BOOK_FEE_BPS:-' + '20}');
  return emptyPassThrough && !invented20;
}

export function dexFeeOwnerEnvComposeGapsClosed(): boolean {
  return dexClobFeeBpsComposeWired() && dexClobSettlementCostComposeWired() && dexInternalBookFeeBpsComposeWired();
}
