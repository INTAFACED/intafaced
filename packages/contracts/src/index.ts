/**
 * @intafaced/contracts — shared zod schemas and tRPC routers.
 *
 * §15.2: "One service per task; cross-service needs = contracts/events PR first."
 * A change here is reviewed on its own, before either side implements it.
 */
export * from './trpc.js';
export * from './edge.js';
export * from './service-auth.js';
export * from './raw-body.js';
export * from './identity.js';
export * from './academy-cert-perks.js';
export * from './instruments.js';
export * from './blueprint.js';
export * from './example-router.js';
export * from './support.js';
export * from './ops-analytics.js';
export * from './ops-analytics-cube.js';
export * from './ops-analytics-consume.js';
export * from './ops-analytics-warehouse.js';
export * from './openapi-from-zod.js';
export * from './action-approval.js';
export * from './outreach-crm.js';
export * from './account-controls.js';
export * from './operation-identity-decisions.js';
export * from './operation-identity-client.js';
export * from './crm-workflows.js';
export * from './crm-notifications.js';
export * from './outreach-interests.js';
export * from './guest-notifications.js';
export * from './crm-privacy.js';
