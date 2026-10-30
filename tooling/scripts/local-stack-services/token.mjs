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
    // Who may take part in a launch: the labelled TEST rule (basic verification, no barred region), so a launch journey
    // shows the requirements list instead of the unset refusal. Production leaves both blank and refuses.
    // LOCAL_STACK_TOKEN_LAUNCH_TIER=off or LOCAL_STACK_TOKEN_LAUNCH_REGIONS=off restarts the lane with that one value blank,
    // so its own typed refusal can be seen.
    ...(process.env.LOCAL_STACK_TOKEN_LAUNCH_TIER === 'off' ? {} : { TOKEN_LAUNCH_MIN_KYC_TIER: testValue('TOKEN_LAUNCH_MIN_KYC_TIER') }),
    ...(process.env.LOCAL_STACK_TOKEN_LAUNCH_REGIONS === 'off'
      ? {}
      : { TOKEN_LAUNCH_RESTRICTED_REGIONS: testValue('TOKEN_LAUNCH_RESTRICTED_REGIONS') }),
    // Who may vote: the labelled TEST rule. LOCAL_STACK_TOKEN_VOTE_RULE=off restarts the lane with it blank, so a journey
    // can show token.vote_rule_unset.
    ...(process.env.LOCAL_STACK_TOKEN_VOTE_RULE === 'off' ? {} : { TOKEN_VOTE_RULE: testValue('TOKEN_VOTE_RULE') }),
  }),
});
