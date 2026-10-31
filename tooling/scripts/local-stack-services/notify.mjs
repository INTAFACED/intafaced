import path from 'node:path';

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE, CUSTOMER_ORIGIN }) => ({
  name: 'notify',
  env: () => ({
    ...c('svc-notify', PORTS.notify),
    DATABASE_URL: dbUrl('svc_notify', secrets),
    // Publishing a notice spends a four-eyes approval held by identity; without it every publish refuses.
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    MATCHING_URL: urlOf('matching'),
    // Notices for P2P merchants: notify asks p2p whether the reader is an active merchant.
    P2P_URL: urlOf('p2p'),
    // In-app inbox only. No email, push or SMS gateway exists locally, so those channels refuse honestly.
    NOTIFY_REQUIRED_CHANNELS: 'none',
    // Required, no default. LOCAL TEST values: attempts only matter for out-of-app delivery (none here);
    // the verification-code lifetime is the .env.example value.
    NOTIFY_MAX_DELIVERY_ATTEMPTS: '3',
    NOTIFY_VERIFY_TTL_MINUTES: '15',
    // LOCAL TEST only: how many price alerts one person may hold. Production has no value until the owner sets one,
    // and every create is refused (notify.alert_quota_unset) until then.
    NOTIFY_ALERT_MAX_ACTIVE_PRICE: '20',
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/notify.json: alert expiry, text length,
    // conditions, trigger log, repeat frequencies and the burst rule. Production stays blank and refuses.
    NOTIFY_ALERT_MAX_EXPIRY_DAYS: '30',
    NOTIFY_ALERT_TEXT_MAX_LENGTH: '200',
    NOTIFY_ALERT_MAX_CONDITIONS: '3',
    NOTIFY_ALERT_TRIGGER_LOG_DAYS: '7',
    NOTIFY_ALERT_FREQUENCIES: 'every_crossing',
    NOTIFY_ALERT_BURST_WINDOW_MINUTES: '10',
    NOTIFY_ALERT_BURST_MAX_TRIGGERS: '5',
    // LOCAL TEST only: the page of svc-trade's market list the alert marks read (trade's own cap). Unset, every live
    // quote refuses notify.markets_list_limit_unset and no alert can fire on the stack.
    NOTIFY_MARKETS_LIST_LIMIT: '500',
    // LOCAL TEST only: the inbox page size and the unread badge cap. Production has neither until the owner sets them,
    // and the inbox refuses (notify.list_limit_unset, notify.unread_cap_unset) until then.
    NOTIFY_INBOX_PAGE_SIZE: '20',
    NOTIFY_INBOX_UNREAD_CAP: '99',
    // Status subscriptions: the signing key for confirm and unsubscribe links, and LOCAL-TEST mail written to a file in
    // this stack's state folder (refused at boot unless APP_ENV is exactly dev or test). Production has no sender until
    // the owner configures the email gateway, and every confirmation waits with vendor.email.
    NOTIFY_STATUS_LINK_SECRET: secrets.notifyStatusLink,
    NOTIFY_STATUS_MAIL_TRANSPORT: 'local-outbox',
    NOTIFY_STATUS_MAIL_OUTBOX: path.join(STATE, 'status-mail-outbox.log'),
    // The customer site's address on this stack, where Edge serves the status badge: the founder console builds badge
    // snippets on it. The local outbox above writes app paths and does not read it.
    NOTIFY_PUBLIC_ORIGIN: CUSTOMER_ORIGIN,
  }),
});
