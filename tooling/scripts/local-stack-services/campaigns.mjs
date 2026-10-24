export default ({ c, secrets, dbUrl, PORTS }) => ({
  // The drop room (/campaigns/drops) reads api.query('campaigns','drops.room'): the season, each limited drop and the TGE
  // panel. DATABASE_URL is this stack's svc_campaigns role; campaigns is in SCHEMAS, so db:migrate runs before it listens.
  // CAMPAIGNS_TGE_SCHEDULE_JSON stays blank (owner value): every TGE claim refuses launch.schedule_unset, which is what
  // J-campaigns-20 #6 proves. Drops and seasons are made by the stack's two TEST founders (one creates, the other publishes).
  name: 'campaigns',
  env: () => ({
    ...c('svc-campaigns', PORTS.campaigns),
    DATABASE_URL: dbUrl('svc_campaigns', secrets),
  }),
});
