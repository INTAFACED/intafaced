export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'notify',
  env: () => ({
    ...c('svc-notify', PORTS.notify),
    DATABASE_URL: dbUrl('svc_notify', secrets),
    // Publishing a notice spends a four-eyes approval held by identity; without it every publish refuses.
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    MATCHING_URL: urlOf('matching'),
    // In-app inbox only. No email, push or SMS gateway exists locally, so those channels refuse honestly.
    NOTIFY_REQUIRED_CHANNELS: 'none',
    // Required, no default. LOCAL TEST values: attempts only matter for out-of-app delivery (none here);
    // the verification-code lifetime is the .env.example value.
    NOTIFY_MAX_DELIVERY_ATTEMPTS: '3',
    NOTIFY_VERIFY_TTL_MINUTES: '15',
    // LOCAL TEST only: how many price alerts one person may hold. Production has no value until the owner sets one,
    // and every create is refused (notify.alert_quota_unset) until then.
    NOTIFY_ALERT_MAX_ACTIVE_PRICE: '20',
    // LOCAL TEST only: the inbox page size and the unread badge cap. Production has neither until the owner sets them,
    // and the inbox refuses (notify.list_limit_unset, notify.unread_cap_unset) until then.
    NOTIFY_INBOX_PAGE_SIZE: '20',
    NOTIFY_INBOX_UNREAD_CAP: '99',
  }),
});
