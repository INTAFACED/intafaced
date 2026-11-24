// One environment through the TypeScript svc-bank' `env.ts`, in a fresh process (it reads `process.env` once, on
// import): prints the parsed environment as JSON, or the refusal's message. Run by `record-door.mjs`.

import { existsSync } from 'node:fs';

if (!existsSync(new URL('../../../services/svc-bank/src/env.ts', import.meta.url))) {
  console.error('env-probe: services/svc-bank no longer exists (the Rust crate replaced it); nothing to probe.');
  process.exit(2);
}

const vars = JSON.parse(process.env.BANK_ENV_PROBE ?? '{}');
for (const k of Object.keys(process.env)) if (k !== 'PATH' && k !== 'TZ') delete process.env[k];
Object.assign(process.env, vars);
try {
  const { env } = await import('../../../services/svc-bank/src/env.ts');
  // `/ready` as `index.ts` builds it from this environment (`bankHttpReady`, the card issuer's and the ramp's
  // programmes, the convert port's URL check), recorded beside the environment for `src/ready.rs`.
  const { bankHttpReady } = await import('../../../services/svc-bank/src/ready.ts');
  const { cardIssuerFor, cardProgrammeOutput } = await import('../../../services/svc-bank/src/cards/issuer.ts');
  const { rampProgrammeFor } = await import('../../../services/svc-bank/src/ramps/rails.ts');
  const { usableTradeConvertUrl } = await import('../../../services/svc-bank/src/auto-invest/trade-convert-port.ts');
  const ready = bankHttpReady({
    scheduledTransfers: env.SCHEDULED_TRANSFERS_ENABLED,
    interestAccrual: env.INTEREST_ACCRUAL_ENABLED,
    loanAccrual: env.LOAN_ACCRUAL_ENABLED,
    loanRiskSweep: env.LOAN_RISK_SWEEP_ENABLED,
    autoInvest: env.AUTO_INVEST_ENABLED,
    loans: env.BANK_LOANS_ENABLED,
    cards: env.BANK_CARDS_ENABLED,
    autoInvestConvertWired: usableTradeConvertUrl(env.TRADE_URL),
    cardProgramme: cardProgrammeOutput(
      cardIssuerFor(env.BANK_CARD_ISSUER, { APP_ENV: env.APP_ENV, NODE_ENV: process.env.NODE_ENV }).programme,
    ),
    rampProgramme: rampProgrammeFor(env.BANK_RAMP_MODE),
  });
  process.stdout.write(JSON.stringify({ ok: env, ready }));
} catch (err) {
  process.stdout.write(JSON.stringify({ refused: err instanceof Error ? err.message : String(err) }));
}
