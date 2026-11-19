import 'server-only';

/**
 * The ops desk feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: its reads call svc-ops with the console's token.
 */
export { loadRead, loadReads } from './server';
export type { ReadOutcome, ReadSpec, Row } from './types';
