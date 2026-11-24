import 'server-only';

/**
 * The agent action log feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: it calls the owning services as the signed-in founder.
 */
export { customerReference, type CustomerReference } from './model';
export { refusalOf, resolveCustomer } from './server';
