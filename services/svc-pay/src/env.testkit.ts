import { loadEnv } from '@intafaced/config';

/**
 * svc-pay's settings as its boot reads them (`loadEnv` over env.ts's schema), from a full test-stack set with one key
 * changed: `undefined` removes it. For tests of what a blank, missing or given setting becomes.
 */
export const PAY_TEST_ENV: Readonly<Record<string, string>> = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-pay',
  DATABASE_URL: 'postgres://127.0.0.1:1/pay_env_test',
  DATABASE_POOL_MAX: '4',
  EDGE_PRINCIPAL_SECRET: 'p'.repeat(48),
  INTERNAL_SERVICE_SECRET: 'i'.repeat(48),
  PAY_CRYPTO_WEBHOOK_SECRET: 'w'.repeat(48),
  PAY_CARD_SANDBOX_WEBHOOK_SECRET: 'c'.repeat(48),
  PAY_MIN_CONFIRMATIONS: '6',
  PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
  PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox',
  PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
  PAY_LINK_DEFAULT_TTL_DAYS: '30',
  PAY_LINK_MAX_TTL_DAYS: '365',
  PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25',
};

/**
 * env.ts parses `process.env` when it is imported, so it is imported once with the test set filled in for the keys this
 * process lacks, and those keys are taken out again after.
 */
async function loadSchema() {
  const added = Object.keys(PAY_TEST_ENV).filter((key) => process.env[key] === undefined);
  for (const key of added) process.env[key] = PAY_TEST_ENV[key];
  try {
    return (await import('./env.js')).schema;
  } finally {
    for (const key of added) delete process.env[key];
  }
}

const schema = await loadSchema();

export function payEnv(change: Record<string, string | undefined> = {}) {
  const source: Record<string, string> = { ...PAY_TEST_ENV };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  return loadEnv(schema, source);
}
