#!/usr/bin/env node
// Build-time public configuration only. No customer API origin is injected:
// the deployed browser always uses the customer site's /api and /ws paths.
import { moneyMode } from './test-banner.mjs';

let money;
try {
  money = moneyMode(process.env);
} catch (error) {
  console.error(`customer deployment: ${error.message}`);
  process.exit(1);
}
const team = process.env.VITE_TEAM_URL?.trim();
if (team) {
  try {
    const url = new URL(team);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('must use HTTPS without credentials, query, or fragment');
    }
  } catch (error) {
    console.error(`customer deployment: VITE_TEAM_URL ${error.message}`);
    process.exit(1);
  }
}
console.log(
  `customer deployment: same-origin API/WS; team desk ${team ? 'configured' : 'unavailable (VITE_TEAM_URL absent)'}; ` +
    (money === 'real' ? 'real money, no TEST banner' : 'test money, TEST banner on'),
);
