export default ({ c, secrets, dbUrl, urlOf, PORTS, CUSTOMER_ORIGIN }) => ({
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
    // journey whose agent sees or works a request puts it in the agent's group first (J-support-public-10 #2, #3, #4, #8, #10).
    SUPPORT_ALL_GROUPS_ROLES: 'lead',
    // LOCAL TEST only, labelled in the same file: what a customer reads of the desk's priority and type on their request.
    // Production stays blank and the customer reads neither (support.customer_properties_unset) until the owner chooses.
    SUPPORT_CUSTOMER_SEES: 'priority,type',
    // LOCAL TEST only, labelled in the same file: an in-memory file store and a scanner that blocks only the EICAR test
    // string, so a customer can attach a file in the running app (J-support-public-04 #3, #4). svc-support refuses both
    // unless APP_ENV is exactly dev or test; production stays blank and every attach refuses naming the missing piece.
    SUPPORT_ATTACHMENT_STORE: 'local-test-memory',
    SUPPORT_MALWARE_SCANNER: 'local-test-eicar',
    // Guest requests (SP-tickets-01): the mail goes through svc-notify's guest verification door on svc-support's own
    // secret, to notify's LOCAL TEST outbox, with links that open this stack's customer app. `LOCAL_STACK_SUPPORT_GUEST_MAIL=off`
    // leaves the door unwired, so a guest request waits with vendor.email (J-support-public-03 #3).
    ...(process.env.LOCAL_STACK_SUPPORT_GUEST_MAIL === 'off'
      ? {}
      : { NOTIFY_URL: urlOf('notify'), NOTIFY_SUPPORT_SERVICE_SECRET: secrets.notifySupportService }),
    SUPPORT_PUBLIC_ORIGIN: CUSTOMER_ORIGIN,
    SUPPORT_GUEST_ADDRESS_KEY: secrets.supportGuestAddress,
    // LOCAL TEST only, labelled in the same file: the guest link lifetime, the per-address limit and its window, and how
    // long a guest's address is kept. Production stays blank and every guest request refuses by name until the owner sets
    // them. `LOCAL_STACK_SUPPORT_GUEST_RATE=off` leaves the limit blank (J-support-public-03 #5), and
    // `LOCAL_STACK_SUPPORT_GUEST_LINK_TTL=1` makes links last one minute, so an expired one can be used (#7).
    SUPPORT_GUEST_LINK_TTL_MINUTES: /^[1-9][0-9]*$/.test(process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL ?? '')
      ? process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL
      : '30',
    ...(process.env.LOCAL_STACK_SUPPORT_GUEST_RATE === 'off'
      ? {}
      : { SUPPORT_GUEST_RATE_LIMIT: '3', SUPPORT_GUEST_RATE_WINDOW_SECONDS: '3600' }),
    SUPPORT_GUEST_RETENTION_DAYS: '30',
  }),
});
