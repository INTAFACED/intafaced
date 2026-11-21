/**
 * trade.futures fleet compose wiring — owner ladder/funding/leverage pass-through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function tradeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-trade');
}

export function futuresLadderComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_FUTURES_LADDER_POLICY:\s*\$\{TRADE_FUTURES_LADDER_POLICY:-\}/.test(block);
}

export function futuresFundingComposeWired(): boolean {
  const block = tradeComposeBlock();
  return (
    /TRADE_FUTURES_FUNDING_MAX_ABS_RATE:\s*\$\{TRADE_FUTURES_FUNDING_MAX_ABS_RATE:-\}/.test(block) &&
    /TRADE_FUTURES_FUNDING_INTERVAL_MS:\s*\$\{TRADE_FUTURES_FUNDING_INTERVAL_MS:-\}/.test(block)
  );
}

export function futuresLeverageComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_FUTURES_MAX_LEVERAGE:\s*\$\{TRADE_FUTURES_MAX_LEVERAGE:-\}/.test(block);
}

export function futuresSettlementFixingComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_FUTURES_SETTLEMENT_FIXING:\s*\$\{TRADE_FUTURES_SETTLEMENT_FIXING:-\}/.test(block);
}

export function futuresOwnerComposeGapsClosed(): boolean {
  return (
    futuresLadderComposeWired() && futuresFundingComposeWired() && futuresLeverageComposeWired() && futuresSettlementFixingComposeWired()
  );
}
