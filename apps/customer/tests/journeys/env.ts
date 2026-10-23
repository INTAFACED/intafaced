/**
 * The assembled stack a journey runs against. Every value comes from the environment the boot script
 * (`tooling/scripts/order-path-cx8-boot.mjs`) exports; a missing one fails the run, it is never defaulted here.
 */
function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`journey stack: ${name} is not set. Run through "pnpm journeys:trade" so the stack is booted first.`);
  return value;
}

export const stack = {
  trade: () => need('TRADE_HTTP_URL').replace(/\/$/, ''),
  ledger: () => need('LEDGER_HTTP_URL').replace(/\/$/, ''),
  pay: () => need('PAY_HTTP_URL').replace(/\/$/, ''),
  bank: () => need('BANK_HTTP_URL').replace(/\/$/, ''),
  tax: () => need('TAX_HTTP_URL').replace(/\/$/, ''),
  identity: () => need('IDENTITY_HTTP_URL').replace(/\/$/, ''),
  /** The file the rig's identity writes LOCAL-TEST confirm links to, read like an inbox. */
  mailOutbox: () => need('CX8_MAIL_OUTBOX'),
  edgeSecret: () => need('EDGE_PRINCIPAL_SECRET'),
  internalSecret: () => need('INTERNAL_SERVICE_SECRET'),
  region: () => process.env.TRADE_SMOKE_REGION?.trim() || 'DE',
  symbol: () => process.env.TRADE_SMOKE_SYMBOL?.trim() || 'BTC/USDT',
};
