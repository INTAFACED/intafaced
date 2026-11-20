import { clobHonestySchema, type ClobHonesty } from '@intafaced/contracts/indexer-procedures';

/**
 * DevVenue ABI is a fixture. A non-dev INDEXER_VENUE_ADDRESS is our published
 * unaudited testnet venue (`kind: sovereign-venue`). That is not `audited:true`
 * and not INTACHAIN. Reserves are never invented here.
 */

export const INDEXER_CLOB_FIXTURE_NOT_LIVE = 'indexer.clob_fixture_not_live' as const;

/** Deterministic CREATE(addressIndex=5, nonce=0) for the disposable Anvil deploy. */
export const DEV_VENUE_ADDRESS = '0x0116686E2291dbd5e317F47faDBFb43B599786Ef';
export const ZERO_VENUE_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Published Base Sepolia SovereignVenue. Not INTACHAIN. audited:false. */
export const PUBLISHED_VENUE_ADDRESS = '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b';

export { clobHonestySchema, type ClobHonesty };

export function clobHonesty(venue?: string | null): ClobHonesty {
  const v = (venue ?? '').trim().toLowerCase();
  if (!v || v === ZERO_VENUE_ADDRESS.toLowerCase()) {
    return { live: false, kind: 'unset', reserves: false };
  }
  if (v === DEV_VENUE_ADDRESS.toLowerCase()) {
    return { live: false, kind: 'fixture', reserves: false };
  }
  if (v === PUBLISHED_VENUE_ADDRESS.toLowerCase()) {
    return { live: true, kind: 'sovereign-venue', reserves: false };
  }
  return { live: false, kind: 'unpublished', reserves: false };
}

/** Prod (or any door that claims a live CLOB) must not serve the fixture ABI as one. */
export function clobFixtureRefusesLiveClaim(opts: { readonly claimLiveClob: boolean; readonly venue?: string | null }): boolean {
  return opts.claimLiveClob && clobHonesty(opts.venue).kind === 'fixture';
}
