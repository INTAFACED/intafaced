export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'support',
  env: () => ({
    ...c('svc-support', PORTS.support),
    DATABASE_URL: dbUrl('svc_support', secrets),
    IDENTITY_URL: urlOf('identity'),
    // LOCAL TEST only, the labelled value in tooling/profiles/test-owner-values/support.json: how many comments a
    // requester may add to one request. Production stays blank and every requester comment refuses
    // (support.comment_cap_unset) until the owner sets it.
    SUPPORT_COMMENT_CAP: '50',
    // LOCAL TEST only, labelled in the same file: how many help-answer votes one account or browser may cast per window.
    // Production stays blank and every vote refuses (support.feedback_rate_limit_unset) until the owner sets both.
    SUPPORT_FEEDBACK_RATE_LIMIT: '5',
    SUPPORT_FEEDBACK_RATE_WINDOW_SECONDS: '3600',
  }),
});
