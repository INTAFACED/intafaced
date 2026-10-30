export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'support',
  env: () => ({
    ...c('svc-support', PORTS.support),
    DATABASE_URL: dbUrl('svc_support', secrets),
    IDENTITY_URL: urlOf('identity'),
    // LOCAL TEST only, the labelled value in tooling/profiles/test-owner-values/support.json: how many comments a
    // requester may add to one request. Production stays blank and every requester comment refuses
    // (support.comment_cap_unset) until the owner sets it. `LOCAL_STACK_SUPPORT_COMMENT_CAP=off` on a start or restart
    // leaves it blank, so that refusal can be seen in the running app too (J-support-public-09 #5).
    ...(process.env.LOCAL_STACK_SUPPORT_COMMENT_CAP === 'off' ? {} : { SUPPORT_COMMENT_CAP: '50' }),
    // LOCAL TEST only, labelled in the same file: how many saved desk views one person, and the whole desk, may keep.
    // Production stays blank and every save refuses (support.view_cap_unset) until the owner sets them.
    SUPPORT_VIEW_PERSONAL_CAP: '20',
    SUPPORT_VIEW_SHARED_CAP: '20',
    // LOCAL TEST only, labelled in the same file: how many help-answer votes one account or browser may cast per window.
    // Production stays blank and every vote refuses (support.feedback_rate_limit_unset) until the owner sets both.
    SUPPORT_FEEDBACK_RATE_LIMIT: '5',
    SUPPORT_FEEDBACK_RATE_WINDOW_SECONDS: '3600',
    // LOCAL TEST only, labelled in the same file: how many live request forms and ticket fields the desk may keep.
    // Production stays blank and every definition refuses (support.form_cap_unset, support.field_cap_unset).
    SUPPORT_FORM_CAP: '50',
    SUPPORT_FIELD_CAP: '200',
    // LOCAL TEST only, labelled in the same file: the fewest characters a macro shortcode may have.
    // Production stays blank and every macro save refuses (support.shortcode_rule_unset) until the owner sets it.
    SUPPORT_MACRO_SHORTCODE_MIN: '2',
    // LOCAL TEST only, labelled in the same file: the desk group fraud reports go to (the journey makes it).
    // Production stays blank and every fraud report refuses (support.fraud_route_unset) until the owner names one.
    SUPPORT_FRAUD_GROUP: 'TEST Compliance',
    // LOCAL TEST only: leads see every group; an agent sees only its own groups' requests, as the desk scopes it. A
    // journey whose agent works a request puts it in the agent's group first (J-support-public-10 #8).
    SUPPORT_ALL_GROUPS_ROLES: 'lead',
    // LOCAL TEST only, labelled in the same file: what a customer reads of the desk's priority and type on their request.
    // Production stays blank and the customer reads neither (support.customer_properties_unset) until the owner chooses.
    SUPPORT_CUSTOMER_SEES: 'priority,type',
    // LOCAL TEST only, labelled in the same file: an in-memory file store and a scanner that blocks only the EICAR test
    // string, so a customer can attach a file in the running app (J-support-public-04 #3, #4). svc-support refuses both
    // unless APP_ENV is exactly dev or test; production stays blank and every attach refuses naming the missing piece.
    SUPPORT_ATTACHMENT_STORE: 'local-test-memory',
    SUPPORT_MALWARE_SCANNER: 'local-test-eicar',
  }),
});
