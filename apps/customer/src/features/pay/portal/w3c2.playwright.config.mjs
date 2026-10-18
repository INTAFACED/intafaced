import base from './portal.playwright.config.mjs';
export default {
  ...base,
  testMatch: 'w3c2.pw.mjs',
  timeout: 60_000,
  outputDir: '/tmp/intafaced-w3c2-browser-results',
  use: { ...base.use, viewport: { width: 1440, height: 1000 } },
};
