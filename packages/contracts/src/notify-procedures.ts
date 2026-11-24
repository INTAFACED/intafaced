import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-notify's calls that are mounted from records, one record per call. The service mounts each from here
 * (`mountRecord`), so its path, guard, input, output and named refusals are this file, not its router. The rest of
 * svc-notify's calls move here area by area, each with every caller, so no call has two ways at once.
 */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'notify:read', module: 'notify' } as const;
const WRITE = { caller: 'scope', scope: 'notify:write', module: 'notify' } as const;

const refuse = (codes: Readonly<Record<string, RefusalStatus>> = {}): Refusals => Object.freeze({ ...codes });

const NOTIFICATION = '33333333-3333-4333-8333-333333333333';

/** Every channel a notification may go out on; `inapp` is the inbox itself. */
export const NOTIFY_CHANNEL = z.enum(['inapp', 'email', 'push', 'sms']);
/** The channels that leave the app, each with an address the person registers. */
export const NOTIFY_OUT_OF_APP_CHANNEL = z.enum(['email', 'push', 'sms']);
const deliveryStatus = z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']);

const marked = z.object({ marked: z.number().int().nonnegative() });

export const NOTIFY_UNREAD_COUNT = defineProcedure({
  ...base,
  name: 'notify.unreadCount',
  kind: 'query',
  path: 'notify.unreadCount',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ count: z.number().int().nonnegative() }),
  samples: [{ verdict: 'accept' }],
});

export const NOTIFY_MARK_READ = defineProcedure({
  ...base,
  name: 'notify.markRead',
  kind: 'mutation',
  path: 'notify.markRead',
  access: WRITE,
  refusals: refuse(),
  input: z.object({ ids: z.array(z.string().guid()).min(1).max(100) }),
  output: marked,
  samples: [
    { verdict: 'accept', input: { ids: [NOTIFICATION] } },
    { verdict: 'refuse', input: { ids: [] } },
  ],
});

export const NOTIFY_MARK_ALL_READ = defineProcedure({
  ...base,
  name: 'notify.markAllRead',
  kind: 'mutation',
  path: 'notify.markAllRead',
  access: WRITE,
  refusals: refuse(),
  input: NO_INPUT,
  output: marked,
  samples: [{ verdict: 'accept' }],
});

/**
 * The push gateway's public application key a browser needs to create a device subscription. Public by design; null
 * with `notify.push_key_unset` until the owner configures push delivery, so the app never registers a device nothing
 * could reach.
 */
export const NOTIFY_PUSH_KEY = defineProcedure({
  ...base,
  name: 'notify.pushKey',
  kind: 'query',
  path: 'notify.pushKey',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.union([
    z.object({ publicKey: z.string(), unsetCode: z.null() }),
    z.object({ publicKey: z.null(), unsetCode: z.literal('notify.push_key_unset') }),
  ]),
  accept: {
    keyShape: {
      says: 'a set key is 16 to 256 URL-safe base64 characters',
      holds: (reply) => {
        const key = z.object({ publicKey: z.string().nullable() }).safeParse(reply);
        return key.success && (key.data.publicKey === null || /^[A-Za-z0-9_-]{16,256}$/.test(key.data.publicKey));
      },
    },
  },
  samples: [{ verdict: 'accept' }],
});

/**
 * Each channel's state: configured (credentials present), available (can send now) and the reason it cannot. `socket`
 * is the tracker id of an out-of-app channel's credential socket; null for `inapp`.
 */
export const NOTIFY_CHANNELS = defineProcedure({
  ...base,
  name: 'notify.channels',
  kind: 'query',
  path: 'notify.channels',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(
    z.object({
      channel: NOTIFY_CHANNEL,
      configured: z.boolean(),
      available: z.boolean(),
      reason: z.string().nullable(),
      requires: z.array(z.string()),
      socket: z.string().nullable(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});

/** The caller's registered out-of-app addresses, one per channel. */
export const NOTIFY_TARGETS = defineProcedure({
  ...base,
  name: 'notify.targets',
  kind: 'query',
  path: 'notify.targets',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(
    z.object({ channel: NOTIFY_OUT_OF_APP_CHANNEL, address: z.string(), locale: z.string(), verifiedAt: z.string().nullable() }),
  ),
  accept: {
    atMostThree: {
      says: 'at most one target per out-of-app channel, so at most three',
      holds: (reply) => Array.isArray(reply) && reply.length <= 3,
    },
  },
  samples: [{ verdict: 'accept' }],
});

/**
 * Registers an address and sends it a confirmation code. The outcome is reported as it is: `refused` with
 * `channel.not_configured` means the owner has no credentials for the channel and the address stays unconfirmed.
 * The address checks are shallow on purpose: the confirmation code proves the address, the schema stops nonsense.
 */
export const NOTIFY_REGISTER_TARGET = defineProcedure({
  ...base,
  name: 'notify.registerTarget',
  kind: 'mutation',
  path: 'notify.registerTarget',
  access: WRITE,
  refusals: refuse({ 'notify.verify_ttl_unset': 'PRECONDITION_FAILED', 'notify.verify_code_pepper_unset': 'PRECONDITION_FAILED' }),
  input: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('email'), address: z.string().email().max(320), locale: z.string().max(16).optional() }),
    z.object({
      channel: z.literal('sms'),
      // E.164: a gateway handed a local-format number still sends it somewhere.
      address: z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number, e.g. +447700900000'),
      locale: z.string().max(16).optional(),
    }),
    // A device token's shape belongs to whoever issued it: bounded, never parsed.
    z.object({ channel: z.literal('push'), address: z.string().min(8).max(4096), locale: z.string().max(16).optional() }),
  ]),
  output: z.object({
    status: z.enum(['sent', 'refused', 'failed']),
    channel: NOTIFY_OUT_OF_APP_CHANNEL,
    code: z.string().nullable(),
    expiresAt: z.string(),
  }),
  accept: {
    codeOnlyWhenRefused: {
      says: 'a refused registration names its refusal code; a sent or failed one names none',
      holds: (reply) => {
        const row = z.object({ status: z.string(), code: z.string().min(1).nullable() }).safeParse(reply);
        return row.success && (row.data.status === 'refused' ? row.data.code !== null : row.data.code === null);
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { channel: 'sms', address: '+447700900000' } },
    { verdict: 'refuse', input: { channel: 'sms', address: '07700900000' } },
  ],
});

/**
 * Confirms an address. Wrong, expired and already-spent codes are one answer (`verified: false`, `code: null`); a rate
 * limit is a named code in `code`.
 */
export const NOTIFY_VERIFY_TARGET = defineProcedure({
  ...base,
  name: 'notify.verifyTarget',
  kind: 'mutation',
  path: 'notify.verifyTarget',
  access: WRITE,
  refusals: refuse({ 'notify.verify_code_pepper_unset': 'PRECONDITION_FAILED' }),
  input: z.object({ channel: NOTIFY_OUT_OF_APP_CHANNEL, code: z.string().regex(/^\d{6}$/) }),
  output: z.object({
    verified: z.boolean(),
    /** Set when the call was refused (rate limit). Null on success and on a wrong code. */
    code: z.string().nullable(),
  }),
  accept: {
    noCodeWhenVerified: {
      says: 'a verified address carries no refusal code, and a code is never empty',
      holds: (reply) => {
        const row = z.object({ verified: z.boolean(), code: z.string().min(1).nullable() }).safeParse(reply);
        return row.success && (!row.data.verified || row.data.code === null);
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { channel: 'email', code: '123456' } },
    { verdict: 'refuse', input: { channel: 'email', code: '12345' } },
  ],
});

export const NOTIFY_REMOVE_TARGET = defineProcedure({
  ...base,
  name: 'notify.removeTarget',
  kind: 'mutation',
  path: 'notify.removeTarget',
  access: WRITE,
  refusals: refuse(),
  input: z.object({ channel: NOTIFY_OUT_OF_APP_CHANNEL }),
  output: z.object({ removed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { channel: 'push' } },
    { verdict: 'refuse', input: { channel: 'inapp' } },
  ],
});

/**
 * What happened to one of the caller's notifications, per channel. An id the caller does not own returns an empty list,
 * never an error, so a stranger cannot learn which notification ids exist. `attemptedAt` set means a send was tried;
 * `acceptedAt` set means a transport accepted it. A refusal is a code, never a sentence.
 */
export const NOTIFY_DELIVERIES = defineProcedure({
  ...base,
  name: 'notify.deliveries',
  kind: 'query',
  path: 'notify.deliveries',
  access: READ,
  refusals: refuse(),
  input: z.object({ notificationId: z.string().guid() }),
  output: z.array(
    z.object({
      channel: NOTIFY_CHANNEL,
      status: deliveryStatus,
      attempts: z.number().int().nonnegative(),
      attemptedAt: z.string().nullable(),
      acceptedAt: z.string().nullable(),
      refusalCode: z.string().nullable(),
    }),
  ),
  accept: { atMostEight: { says: 'at most eight delivery rows', holds: (reply) => Array.isArray(reply) && reply.length <= 8 } },
  samples: [
    { verdict: 'accept', input: { notificationId: NOTIFICATION } },
    { verdict: 'refuse', input: { notificationId: 'not-an-id' } },
  ],
});

export const NOTIFY_PROCEDURES = [
  NOTIFY_UNREAD_COUNT,
  NOTIFY_MARK_READ,
  NOTIFY_MARK_ALL_READ,
  NOTIFY_PUSH_KEY,
  NOTIFY_CHANNELS,
  NOTIFY_TARGETS,
  NOTIFY_REGISTER_TARGET,
  NOTIFY_VERIFY_TARGET,
  NOTIFY_REMOVE_TARGET,
  NOTIFY_DELIVERIES,
] as const;
