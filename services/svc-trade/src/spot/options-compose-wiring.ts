/**
 * trade.options fleet compose wiring — P0-05 + D7 owner env pass-through.
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

export function optionsSettlementAssetLawComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:\s*\$\{TRADE_OPTIONS_SETTLEMENT_ASSET_LAW:-\}/.test(block);
}

export function optionsSettlementFixingComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_OPTIONS_SETTLEMENT_FIXING:\s*\$\{TRADE_OPTIONS_SETTLEMENT_FIXING:-\}/.test(block);
}

export function optionsJobsComposeWired(): boolean {
  const block = tradeComposeBlock();
  return (
    /TRADE_OPTIONS_JOBS_ENABLED:\s*\$\{TRADE_OPTIONS_JOBS_ENABLED:-false\}/.test(block) &&
    /TRADE_OPTIONS_JOBS_INTERVAL_MS:\s*\$\{TRADE_OPTIONS_JOBS_INTERVAL_MS:-15000\}/.test(block) &&
    !/TRADE_OPTIONS_JOBS_ENABLED:\s*\$\{TRADE_OPTIONS_JOBS_ENABLED:-true\}/.test(block)
  );
}

export function optionsOwnerEnvComposeGapsClosed(): boolean {
  return optionsSettlementAssetLawComposeWired() && optionsSettlementFixingComposeWired() && optionsJobsComposeWired();
}
