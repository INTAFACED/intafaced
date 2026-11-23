import 'server-only';

/**
 * The accounts feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: the treasury holder is read with the console's token.
 */
export { treasuryHolder } from './holds-server';
