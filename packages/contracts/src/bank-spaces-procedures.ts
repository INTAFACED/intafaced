import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { assetIdSchema } from './asset-id.js';
import { potStateOutput } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `spaces.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Assets the user holds with no space yet — sourced from the ledger, not this table. */
export const BANK_SPACES_UNNAMED = defineProcedure({
  ...base,
  name: 'bank.spaces.unnamed',
  kind: 'query',
  path: 'spaces.unnamed',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(z.object({ assetId: assetIdSchema, balance: amountString })),
  samples: [{ verdict: 'accept' }],
});

/**
 * Make one of the caller's live pots their bills pot for its asset (BK-pots-03), or change its fallback. With the
 * fallback on, a standing order from the pot that finds too little first moves the shortfall from the main account;
 * off (the default), it is refused `ledger.insufficient_funds` like any other. Another bills pot of the asset gives
 * the role up.
 */
export const BANK_SPACES_SET_BILLS_POT = defineProcedure({
  ...base,
  name: 'bank.spaces.setBillsPot',
  kind: 'mutation',
  path: 'spaces.setBillsPot',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid(), fallback: z.boolean() }),
  output: z.object({ spaceId: z.string(), assetId: assetIdSchema, fallback: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111', fallback: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The pot stops paying the caller's bills; its money stays where it is (BK-pots-03). */
export const BANK_SPACES_CLEAR_BILLS_POT = defineProcedure({
  ...base,
  name: 'bank.spaces.clearBillsPot',
  kind: 'mutation',
  path: 'spaces.clearBillsPot',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: z.object({ spaceId: z.string(), billsPot: z.null() }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Lock one of the caller's pots until a later date, or keep it locked for longer (BK-pots-02). Debits from a locked
 * pot refuse `bank.space_locked`. An earlier date refuses `bank.space_change_invalid`: that is an early unlock.
 */
export const BANK_SPACES_SET_LOCK = defineProcedure({
  ...base,
  name: 'bank.spaces.setLock',
  kind: 'mutation',
  path: 'spaces.setLock',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid(), lockedUntil: z.string().datetime({ offset: true }) }),
  output: potStateOutput,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111', lockedUntil: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner confirms they want a locked pot opened before its date (BK-pots-02). It opens after the owner-set wait
 * (`BANK_SPACE_UNLOCK_WAIT_HOURS`, blank refuses `bank.space_unlock_rule_unset`); until then debits still refuse.
 * Asking again while one waits returns the same opening time.
 */
export const BANK_SPACES_REQUEST_UNLOCK = defineProcedure({
  ...base,
  name: 'bank.spaces.requestUnlock',
  kind: 'mutation',
  path: 'spaces.requestUnlock',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: potStateOutput,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Withdraw an early unlock still waiting; the pot stays locked to its date. None waiting changes nothing (BK-pots-02). */
export const BANK_SPACES_CANCEL_UNLOCK = defineProcedure({
  ...base,
  name: 'bank.spaces.cancelUnlock',
  kind: 'mutation',
  path: 'spaces.cancelUnlock',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: potStateOutput,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_SPACES_ARCHIVE = defineProcedure({
  ...base,
  name: 'bank.spaces.archive',
  kind: 'mutation',
  path: 'spaces.archive',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: z.object({ archived: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
