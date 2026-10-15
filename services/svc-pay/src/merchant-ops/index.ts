export { createFounderOpsRouter, createMerchantOpsRouter, type FounderOpsRouter, type MerchantOpsDeps, type MerchantOpsRouter } from './router.js';
export {
  MERCHANT_PERMISSIONS,
  TEAM_ROLES,
  assertPermission,
  requireMerchantPermission,
  resolveMerchantCaller,
  roleHasPermission,
  rolesWithPermission,
  type MerchantCaller,
  type MerchantPermission,
  type MerchantRole,
  type TeamRole,
} from './roles.js';
export { NOTIFICATION_KINDS, recordMerchantNotification, type NewNotification, type NotificationKind } from './notifications.js';
export { MerchantOpsError } from './errors.js';
