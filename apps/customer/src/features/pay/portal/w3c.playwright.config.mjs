import base from './portal.playwright.config.mjs';
export default { ...base, testMatch: 'w3c.pw.mjs', outputDir: '/tmp/intafaced-w3c-browser-results' };
