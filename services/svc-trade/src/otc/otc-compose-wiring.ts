/**
 * trade.otc fleet compose wiring — desk-law owner env pass-through honesty checks.
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

export function otcDeskLawComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_OTC_DESK_LAW:\s*\$\{TRADE_OTC_DESK_LAW:-\}/.test(block);
}
