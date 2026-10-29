import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/token.json.`);
  return entry.value;
}

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'token',
  env: () => ({
    ...c('svc-token', PORTS.token),
    DATABASE_URL: dbUrl('svc_token', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    // Nothing mints, distributes or buys back in the background of a test stack.
    EMISSIONS_AUTO_TICK: 'false',
    YIELD_JOB_ENABLED: 'false',
    BUYBACK_JOB_ENABLED: 'false',
    // A TEST one-second epoch, so a journey can mint one TEST epoch through the job door on every run.
    EMISSIONS_EPOCH_MS: testValue('EMISSIONS_EPOCH_MS'),
    // Who may open a proposal, and how many: the labelled TEST values, so a governance journey meets the rule instead
    // of the unset refusal. Production leaves both blank and refuses with their typed codes.
    // LOCAL_STACK_TOKEN_PROPOSER_RULE=off restarts the lane with the rule blank, so a journey can show its refusal.
    ...(process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE === 'off' ? {} : { TOKEN_PROPOSER_RULE: testValue('TOKEN_PROPOSER_RULE') }),
    TOKEN_PROPOSAL_LIMIT: testValue('TOKEN_PROPOSAL_LIMIT'),
  }),
});
