import { z } from 'zod';

/**
 * Wire types for the Session keys panel (D-portfolio-wallet-02), version 1: svc-protocol's `sessions.list`. Every key a
 * smart account granted, rebuilt from the account's own `SessionGranted`, `SessionRevoked`, `SessionEpochBumped` and
 * `SessionCallExecuted` logs and checked against its on-chain record at one block. The scope comes from the grant's log, so
 * anyone can read it from the chain without us. A key can never carry a transfer or approval selector: the account refuses
 * that at grant and at execution (SessionKeyLib.assertGrantable).
 */
export const PROTOCOL_SESSIONS_CONTRACT_VERSION = 1 as const;

/** `revoked` covers a key revoked by itself and every key ended by "Revoke all" (an epoch bump). */
export const SESSION_KEY_STATUSES = ['active', 'not_yet_valid', 'expired', 'revoked'] as const;
export type SessionKeyStatus = (typeof SESSION_KEY_STATUSES)[number];

export const protocolSessionsListInputSchema = z.object({ account: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
export const protocolSessionKeySchema = z.object({
  key: z.string(),
  targets: z.array(z.string()),
  selectors: z.array(z.string()),
  /** Cumulative cap on native value, in wei, and what was moved under it. Decimal strings. */
  spendLimitWei: z.string(),
  spentWei: z.string(),
  validAfter: z.number().int(),
  validUntil: z.number().int(),
  status: z.enum(SESSION_KEY_STATUSES),
  grantedBlock: z.string(),
  /** When the key last acted (ISO), or null if it never did inside the window read. */
  lastUsedAt: z.string().nullable(),
});
export const protocolSessionsListSchema = z.object({
  account: z.string(),
  chainId: z.number().int(),
  /** False when the account has no code yet: it has granted nothing (not the same as "could not ask"). */
  deployed: z.boolean(),
  /** The block every field was read at, its time, and the first block whose logs were read. */
  blockNumber: z.string(),
  blockTime: z.string(),
  logsFromBlock: z.string(),
  keys: z.array(protocolSessionKeySchema),
});
export type ProtocolSessionKey = z.infer<typeof protocolSessionKeySchema>;
export type ProtocolSessionsList = z.infer<typeof protocolSessionsListSchema>;

/** `buildSessionGrant`'s answer: the unsigned owner call, the scope's commitment and its expiry (unix seconds). */
export const protocolSessionGrantCallSchema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
  value: z.string(),
  summary: z.string(),
  specHash: z.string(),
  validUntil: z.number(),
});
