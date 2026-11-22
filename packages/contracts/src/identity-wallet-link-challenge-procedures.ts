import { defineProcedure } from './procedure.js';
import { walletChallengeInput, walletChallengeOutput } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `walletLinkChallenge.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** The message a wallet signs to be linked: single use, for this account and this wallet only. */
export const IDENTITY_WALLET_LINK_CHALLENGE = defineProcedure({
  ...base,
  name: 'identity.walletLinkChallenge',
  kind: 'mutation',
  path: 'walletLinkChallenge',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: walletChallengeInput,
  output: walletChallengeOutput,
  samples: [
    { verdict: 'accept', input: { address: 'USDC', chainId: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
