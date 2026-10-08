const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

function customerOrigin(value) {
  if (!value?.trim()) throw new Error('MOBILE_CUSTOMER_ORIGIN is required; configure the deployed HTTPS customer site');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('MOBILE_CUSTOMER_ORIGIN must be an absolute HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MOBILE_CUSTOMER_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function stagedOrigin(mobileRoot) {
  const origin = customerOrigin(process.env.MOBILE_CUSTOMER_ORIGIN);
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(mobileRoot, 'www/native-stage.json'), 'utf8')); }
  catch { throw new Error('Run pnpm --filter mobile build with MOBILE_CUSTOMER_ORIGIN before Capacitor copy/sync; no verified staging receipt'); }
  const indexHash = createHash('sha256').update(readFileSync(join(mobileRoot, 'www/index.html'))).digest('hex');
  if (receipt.customerOrigin !== origin || receipt.indexSha256 !== indexHash || receipt.schemaVersion !== 1) {
    throw new Error('Native staging does not match this origin/assets; rerun pnpm --filter mobile build');
  }
  return origin;
}

module.exports = { customerOrigin, stagedOrigin };
