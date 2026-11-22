import { defineProcedure } from './procedure.js';
import { businessReceiptsZipSchema } from './bank-business-cards.js';
import { accountInput } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessCards.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Every receipt of the business in one ZIP file, base64 on the wire. */
export const BANK_BUSINESS_CARDS_RECEIPTS_ZIP = defineProcedure({
  ...base,
  name: 'bank.businessCards.receiptsZip',
  kind: 'query',
  path: 'businessCards.receiptsZip',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessReceiptsZipSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
