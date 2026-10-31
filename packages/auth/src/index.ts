/**
 * @intafaced/auth — JWT verification, guards, permission scopes.
 *
 * §1: "Own service — sovereignty; no third-party auth dependency."
 *
 * Password hashing (argon2id), TOTP enrolment, and WebAuthn registration live
 * in svc-identity, which owns the credentials. This package holds only what
 * every OTHER service needs: how to verify a token and how to authorise a call.
 */
export * from './scopes.js';
export * from './tokens.js';
export * from './guards.js';
export * from './merchant-pay-scope-grant.js';
export * from './onboarding-scope.js';
export * from './staff-permissions.js';
