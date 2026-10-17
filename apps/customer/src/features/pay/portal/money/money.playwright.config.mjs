import base from '../portal.playwright.config.mjs';

// The money pages' own browser run: destinations, sending an approved payout, one set of payout counts, tiers and fee rates.
export default {
  ...base,
  testMatch: 'money.pw.mjs',
  outputDir: process.env.PORTAL_PW_OUT ?? '/tmp/intafaced-money-browser-results',
  webServer: { ...base.webServer, cwd: new URL('../../../../../../..', import.meta.url).pathname },
};
