import { turnkeyAdapter } from '../src/embedded-wallet/turnkey.js';
import { softwarePasskey } from './software-passkey.js';

/**
 * The one-off live check of the owner's wallet provider (allowed by REVIEW.md, entry of 2026-11-24): the service's own adapter
 * makes ONE TEST wallet, bound to a TEST passkey made in software whose private key never leaves this process, so the
 * wallet can never sign. The sub-organisation is always named for the same TEST owner, so a second run finds the wallet
 * the first made instead of making another. Prints only the outcome and the wallet's public address; the key settings
 * are read from the environment and never printed.
 */
const OWNER_REF = 'TEST-live-check';

const passkey = softwarePasskey('localhost', 'http://localhost');
const maker = turnkeyAdapter({
  organizationId: process.env.TURNKEY_ORGANIZATION_ID,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
});
try {
  const wallet = await maker.createWallet({ ownerRef: OWNER_REF, passkey });
  console.log(`wallet provider: TEST wallet for ${wallet.ownerRef}, address ${wallet.address}, no seed phrase`);
} catch (err) {
  // The adapter's errors name the status or the step, never a key or the provider's body.
  console.error(`wallet provider: ${err instanceof Error ? `${err.name}: ${err.message}` : 'failed'}`);
  process.exit(1);
}
