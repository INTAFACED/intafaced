/**
 * trade.copy fleet compose wiring — fee-share + jurisdiction owner env pass-through.
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

export function copyFeeShareLawComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_COPY_FEE_SHARE_LAW:\s*\$\{TRADE_COPY_FEE_SHARE_LAW:-\}/.test(block);
}

export function copyJurisdictionLawComposeWired(): boolean {
  const block = tradeComposeBlock();
  return /TRADE_COPY_JURISDICTION_LAW:\s*\$\{TRADE_COPY_JURISDICTION_LAW:-\}/.test(block);
}

export function copyOwnerLawComposeGapsClosed(): boolean {
  return copyFeeShareLawComposeWired() && copyJurisdictionLawComposeWired();
}
