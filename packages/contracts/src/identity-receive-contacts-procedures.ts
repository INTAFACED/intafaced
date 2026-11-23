import { defineProcedure, NO_INPUT } from './procedure.js';
import { listOutput } from './identity-call-schemas.js';
import { z } from 'zod';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `receiveContacts.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** The caller's own addresses to be paid by, proved or waiting for their code, and the published cap. */
export const IDENTITY_RECEIVE_CONTACTS_LIST = defineProcedure({
  ...base,
  name: 'identity.receiveContacts.list',
  kind: 'query',
  path: 'receiveContacts.list',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: listOutput,
  samples: [{ verdict: 'accept' }],
});

/** Add an email or phone and send its code. The sender being off refuses before anything is stored. */
export const IDENTITY_RECEIVE_CONTACTS_ADD = defineProcedure({
  ...base,
  name: 'identity.receiveContacts.add',
  kind: 'mutation',
  path: 'receiveContacts.add',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ channel: z.enum(['email', 'phone']), target: z.string().max(320) }).strict(),
  output: listOutput,
  samples: [
    { verdict: 'accept', input: { channel: 'email', target: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Prove an address with the code sent to it. */
export const IDENTITY_RECEIVE_CONTACTS_VERIFY = defineProcedure({
  ...base,
  name: 'identity.receiveContacts.verify',
  kind: 'mutation',
  path: 'receiveContacts.verify',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ id: z.string().guid(), code: z.string().max(16) }).strict(),
  output: listOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111', code: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Stop receiving by an address. */
export const IDENTITY_RECEIVE_CONTACTS_REMOVE = defineProcedure({
  ...base,
  name: 'identity.receiveContacts.remove',
  kind: 'mutation',
  path: 'receiveContacts.remove',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ id: z.string().guid() }).strict(),
  output: listOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
