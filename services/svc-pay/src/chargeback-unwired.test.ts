import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Q-pay — chargeback post-or-refuse.
 *
 * HTTP must post via ledger-client (`chargeback-ledger.ts`) or return a named
 * refuse. It must not claim `posted` without a tx id. Won, shortfall, and
 * recovery are posted from that file. bank-payout stays absent. No Hyperswitch.
 * No `pay:*` grants.
 */

const here = dirname(fileURLToPath(import.meta.url));
// PayService is payment-service.ts plus its area files in payment-service/.
const paySrc = [
  readFileSync(join(here, 'payment-service.ts'), 'utf8'),
  ...readdirSync(join(here, 'payment-service'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => readFileSync(join(here, 'payment-service', f), 'utf8')),
].join('\n');
const routerSrc = readFileSync(join(here, 'router.ts'), 'utf8');
const socketSrc = readFileSync(join(here, 'fraud/chargeback-ledger-socket.ts'), 'utf8');
const ledgerSrc = readFileSync(join(here, 'chargeback-ledger.ts'), 'utf8');
const restSrc = readFileSync(join(here, 'public-rest.ts'), 'utf8');
const bankSrc = readFileSync(join(here, 'rails/bank-payout.ts'), 'utf8');
const grantSrc = readFileSync(join(here, 'merchant-pay-grant-path.ts'), 'utf8');
const pkg = readFileSync(join(here, '../package.json'), 'utf8');

describe('chargeback ledger wire — post-or-refuse (Q-pay)', () => {
  it('production recipe calls live in chargeback-ledger.ts', () => {
    expect(ledgerSrc).toMatch(/recipes\.chargebackOpen/);
    expect(ledgerSrc).toMatch(/recipes\.chargebackWon/);
    expect(ledgerSrc).toMatch(/recipes\.chargebackShortfall\b/);
    expect(ledgerSrc).toMatch(/recipes\.chargebackShortfallRecovered/);
    expect(paySrc).toMatch(/postDisputeOpening/);
    expect(paySrc).toMatch(/postDisputeWon/);
    expect(paySrc).toMatch(/postDisputeShortfall/);
    expect(paySrc).not.toMatch(/recipes\.chargeback/);
  });

  it('router dispute doors exist; never hardcode ledgerWire posted', () => {
    expect(routerSrc).toMatch(/openDispute|contestDispute|getDispute/);
    expect(routerSrc).toMatch(/openChargeback/);
    expect(routerSrc).toMatch(/socket\.pay-chargeback-ledger-wire|ledgerSocket/);
    expect(routerSrc).not.toMatch(/ledgerWire:\s*['"]posted['"]/);
    expect(routerSrc).not.toMatch(/recipes\.chargeback/);
  });

  it('named socket still refuses fixture and uncovered covers', () => {
    expect(socketSrc).toMatch(/socket\.pay-chargeback-ledger-wire/);
    expect(socketSrc).toMatch(/pay\.chargeback_ledger_unwired/);
    expect(socketSrc).toMatch(/pay\.chargeback_uncovered/);
    expect(socketSrc).toMatch(/refuseChargebackLedgerPost/);
    expect(socketSrc).toMatch(/refuseChargebackUncovered/);
  });

  it('HTTP webhook dispute.opened calls the post-or-refuse helper', () => {
    expect(paySrc).toMatch(/case 'dispute\.opened'/);
    expect(paySrc).toMatch(/postChargebackOpenOrRefuse/);
  });

  it('merchant REST has no reverse-money dispute door', () => {
    expect(restSrc).not.toMatch(/\/dispute|chargeback/i);
  });

  it('bank-payout door stays absent and refuses', () => {
    expect(bankSrc).toMatch(/readonly id = 'bank-payout'/);
    expect(bankSrc).toMatch(/readonly mode = 'absent'/);
    expect(bankSrc).toMatch(/bank\.not_configured/);
  });

  it('does not adopt Hyperswitch or invent pay:* grants', () => {
    expect(pkg).not.toMatch(/hyperswitch/i);
    expect(grantSrc).toMatch(/Never invents a grantor/);
    expect(paySrc).toMatch(/Does not invent `pay:\*` scopes/);
  });
});
