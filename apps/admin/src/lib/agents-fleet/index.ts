import 'server-only';

/**
 * The agent fleet feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: it calls the owning services as the signed-in founder.
 */
export { handlesFor, type FleetAnswer } from './server';
