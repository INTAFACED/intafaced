import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { waitlistPlaceOutput, waveOutput } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `waitlist.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_WAITLIST_WAVES_LIST = defineProcedure({
  ...base,
  name: 'identity.waitlist.waves.list',
  kind: 'query',
  path: 'waitlist.waves.list',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    waveSize: z.number().int().positive().nullable(),
    nextWave: z.number().int().positive(),
    waiting: z.number().int().min(0),
    waves: z.array(waveOutput),
  }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_WAITLIST_WAVES_RELEASE = defineProcedure({
  ...base,
  name: 'identity.waitlist.waves.release',
  kind: 'mutation',
  path: 'waitlist.waves.release',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: {},
  input: z.object({
    waveNumber: z.number().int().positive(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: z.object({ wave: waveOutput, created: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { waveNumber: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The signed-in caller's own place (RC-campaigns-05's drop room, J-campaigns-20 #4): the entry whose email is this
 * account's confirmed email, or null when it never joined. An unconfirmed email refuses `waitlist.email_unverified`.
 */
export const IDENTITY_WAITLIST_MINE = defineProcedure({
  ...base,
  name: 'identity.waitlist.mine',
  kind: 'query',
  path: 'waitlist.mine',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: waitlistPlaceOutput.nullable(),
  samples: [{ verdict: 'accept' }],
});
