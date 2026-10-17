import base from '../portal.playwright.config.mjs';
export default {
  ...base,
  testDir: '.',
  testMatch: 'settings-b.pw.mjs',
  timeout: 60_000,
  outputDir: '/tmp/intafaced-settings-b-browser-results',
  use: { ...base.use, viewport: { width: 1440, height: 1000 } },
};
