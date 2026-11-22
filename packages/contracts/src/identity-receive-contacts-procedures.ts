import { defineProcedure, NO_INPUT } from './procedure.js';
import { listOutput } from './identity-call-schemas.js';

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
