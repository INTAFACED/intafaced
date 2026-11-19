import 'server-only';

/**
 * The ledger feature's entry: another console feature imports the ledger only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first. This entry is for
 * server code: the treasury transport reads the console's token.
 */
export { treasuryTransport } from './reconciliation-server';
