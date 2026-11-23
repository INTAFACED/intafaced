/**
 * trade.greeks fleet compose wiring — QuantLib native path pass-through.
 * Empty default unlinks. Compose never invents a .node path.
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

export function quantLibNativeComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /INTAFACED_QUANTLIB_NATIVE:\s*\$\{INTAFACED_QUANTLIB_NATIVE:-\}/.test(block);
}

export function deltaHedgeOwnerEnvComposeWired(): boolean {
  const block = tradeComposeBlock();
  return (
    /TRADE_DELTA_HEDGE_TARGET:\s*\$\{TRADE_DELTA_HEDGE_TARGET:-\}/.test(block) &&
    /TRADE_DELTA_HEDGE_RANGE:\s*\$\{TRADE_DELTA_HEDGE_RANGE:-\}/.test(block) &&
    /TRADE_DELTA_HEDGE_INSTRUMENT:\s*\$\{TRADE_DELTA_HEDGE_INSTRUMENT:-\}/.test(block) &&
    !/TRADE_DELTA_HEDGE_TARGET:\s*\$\{TRADE_DELTA_HEDGE_TARGET:-0\}/.test(block) &&
    !/TRADE_DELTA_HEDGE_RANGE:\s*\$\{TRADE_DELTA_HEDGE_RANGE:-0\}/.test(block)
  );
}
