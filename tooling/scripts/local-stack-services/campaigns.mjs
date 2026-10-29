export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  // The drop room (/campaigns/drops) reads api.query('campaigns','drops.room'): the season, each limited drop and the TGE
  // panel. DATABASE_URL is this stack's svc_campaigns role; campaigns is in SCHEMAS, so db:migrate runs before it listens.
  // CAMPAIGNS_TGE_SCHEDULE_JSON stays blank (owner value): every TGE claim refuses launch.schedule_unset, which is what
  // J-campaigns-20 #6 proves. Drops and seasons are made by the stack's two TEST founders (one creates, the other publishes).
  name: 'campaigns',
  env: () => ({
    ...c('svc-campaigns', PORTS.campaigns),
    DATABASE_URL: dbUrl('svc_campaigns', secrets),
    // LOCAL TEST only, the labelled value in tooling/profiles/test-owner-values/campaigns.json: the platform time zone the
    // campaign windows and calendar are read in. Production stays blank and every campaign activation and join refuses
    // campaigns.timezone_unset until the owner sets it. J-campaigns-01 makes its TEST campaigns through the founders.
    CAMPAIGNS_PLATFORM_TIME_ZONE: 'UTC',
    // The participant read for exclusions and region lists (CM-eligibility-rules-01, J-campaigns-01 #4-#5), signed with
    // the stack's shared service secret from c().
    IDENTITY_URL: urlOf('identity'),
    // The reward saga (J-campaigns-02): task rewards (rewardPay) and pot sweeps of earned fees (sweepFeesToRewards), signed
    // with the stack's shared service secret. Task progress reads trade.fill.settled from the stack's NATS (from c()).
    LEDGER_URL: urlOf('ledger'),
    // svc-trade's public market list names the market a fill's id points at, for a step on one market.
    TRADE_URL: urlOf('trade'),
    // LOCAL TEST only, labelled in tooling/profiles/test-owner-values/campaigns.json: the reconciler interval and the
    // rollback window a reward record shows. Production stays blank: no reconciler runs, and the window reads "not set".
    CAMPAIGNS_RECONCILE_AFTER_SECONDS: '5',
    CAMPAIGNS_ROLLBACK_WINDOW_SECONDS: '86400',
    // LOCAL TEST only, labelled in tooling/profiles/test-owner-values/campaigns.json: the rule tree limits (J-campaigns-16
    // #4). Production stays blank and every rule try, save and campaign rule refuses campaigns.rule_depth_unset.
    CAMPAIGNS_RULE_DEPTH_LIMIT: '4',
    CAMPAIGNS_RULE_SIZE_LIMIT: '20',
  }),
});
