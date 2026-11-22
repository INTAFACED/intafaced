import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  navigatorAskInputSchema,
  navigatorAskResultSchema,
  navigatorOnchainAccountInputSchema,
  navigatorOnchainBindingReadSchema,
  navigatorOnchainBindingSchema,
  navigatorOnchainSignerInputSchema,
  navigatorOnchainSignerSchema,
  navigatorOrdersInputSchema,
  navigatorOrdersSchema,
  navigatorTradingSchema,
} from './agents-onchain.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `navigator.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/**
 * One ask to the Navigator, before anything runs. An ask to move money out is refused by name. An ask that names a
 * trade (swap, buy, sell, trade or order, as a whole word) is the Navigator's to place inside the cap the person
 * signed for its session key: inside the cap it is sent once, with no approval asked, and tagged as placed by the
 * assistant; above the cap, or with no live key, it is refused by name before anything is signed. No engine is called
 * and nothing is charged for it. Any other ask stores nothing and goes on to the ordinary run.
 */
export const AGENTS_NAVIGATOR_ASK = defineProcedure({
  ...base,
  name: 'agents.navigator.ask',
  kind: 'mutation',
  path: 'navigator.ask',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: navigatorAskInputSchema,
  output: navigatorAskResultSchema,
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111', requestId: 'USDC', text: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The Navigator's signer on this chain: a public address on the test network; mainnet and blank refuse by name. */
export const AGENTS_NAVIGATOR_ONCHAIN_SIGNER = defineProcedure({
  ...base,
  name: 'agents.navigator.onchain.signer',
  kind: 'query',
  path: 'navigator.onchain.signer',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: navigatorOnchainSignerInputSchema,
  output: navigatorOnchainSignerSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_NAVIGATOR_ONCHAIN_BINDING = defineProcedure({
  ...base,
  name: 'agents.navigator.onchain.binding',
  kind: 'query',
  path: 'navigator.onchain.binding',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: navigatorOnchainAccountInputSchema,
  output: navigatorOnchainBindingReadSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 1, account: '0x1111111111111111111111111111111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Marks the binding revoking, once. The chain says when it is revoked, after the person signs the revoke. */
export const AGENTS_NAVIGATOR_ONCHAIN_REVOKE = defineProcedure({
  ...base,
  name: 'agents.navigator.onchain.revoke',
  kind: 'mutation',
  path: 'navigator.onchain.revoke',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: navigatorOnchainAccountInputSchema,
  output: navigatorOnchainBindingSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 1, account: '0x1111111111111111111111111111111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The person's live Navigator key: the cap they signed, read from the chain, and what its orders hold. Null with none. */
export const AGENTS_NAVIGATOR_TRADING = defineProcedure({
  ...base,
  name: 'agents.navigator.trading',
  kind: 'query',
  path: 'navigator.trading',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: navigatorTradingSchema,
  samples: [{ verdict: 'accept' }],
});

/** The orders the Navigator placed in the session, newest first: the person's own only. */
export const AGENTS_NAVIGATOR_ORDERS = defineProcedure({
  ...base,
  name: 'agents.navigator.orders',
  kind: 'query',
  path: 'navigator.orders',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: navigatorOrdersInputSchema,
  output: navigatorOrdersSchema,
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
