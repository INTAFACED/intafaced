import { defineProcedure, NO_INPUT } from './procedure.js';
import { officialChannelsAnswerSchema } from './support-official-channels.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `officialChannels.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

export const SUPPORT_OFFICIAL_CHANNELS = defineProcedure({
  ...base,
  name: 'support.officialChannels',
  kind: 'query',
  path: 'officialChannels',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: officialChannelsAnswerSchema,
  samples: [{ verdict: 'accept' }],
});
