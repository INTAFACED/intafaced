/**
 * The token governance feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * Browser code reaches it, so it exports only the pure model.
 */
export { GOVERNANCE_ROLES, MS, ROLE_USER, durationWords, type GovernanceRole, hoursToMs, msToHours } from './model';
