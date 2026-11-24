import { OPENSANCTIONS_API_KEY_ENV, createOpenSanctionsScreener } from '../src/screening/opensanctions-screener.js';

/**
 * The one-off live check of the owner's screening vendor (allowed by REVIEW.md, entry of 2026-11-24): the service's own
 * screener makes ONE match call against the four official lists, for a TEST name, and prints the answer's category
 * and factor. The key is read from the environment and never printed. An `unavailable` answer fails the run.
 */
const screen = createOpenSanctionsScreener({
  apiKey: process.env[OPENSANCTIONS_API_KEY_ENV] ?? '',
  resolveParty: async () => ({ schema: 'Person', names: ['TEST Live Check Person'] }),
  requestTimeoutMs: 15_000,
});
// The subject names no real party: the resolver above answers with the TEST name whatever it is given.
const answer = await screen({ kind: 'payout', partyRef: 'TEST-live-check', assetId: 'USDT', amount: '0' });
console.log(`screening vendor: ${answer.category} (${answer.factors.map((f) => f.code).join(', ')})`);
if (answer.category === 'unavailable') process.exit(1);
