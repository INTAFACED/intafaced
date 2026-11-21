/**
 * The restore feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * Browser code reaches it, so it exports only the pure model.
 */
export { RESTORE_NO, RESTORE_SERVICES, type RestoreServiceName } from './model';
