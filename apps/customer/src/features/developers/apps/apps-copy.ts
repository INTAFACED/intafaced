import { defineCopy } from '../../../shared/i18n';

// Registered OAuth apps (/developers/apps) and the authorise page (/oauth/authorize). Names, addresses and scopes enter through
// parameters; nothing here is a sample or a default.
const en = {
  eyebrow: 'Developers',
  title: 'Registered apps',
  lead: 'Register an app that signs people in with their Intafaced account. Each person decides what the app may see; you never get their password.',
  signedOutTitle: 'Sign in to register an app',
  signedOutBody: 'Apps belong to your account.',
  signIn: 'Sign in',
  loading: 'Reading your apps',
  readFailed: 'Your apps could not be read.',
  lifetimesUnread: 'Whether apps can sign people in could not be read.',
  codeLabel: 'Code',
  retry: 'Try again',
  empty: 'You have not registered an app.',

  listHeading: 'Your apps',
  clientId: 'Client ID',
  redirects: 'Redirect addresses',
  scopes: 'Declared scopes',
  kindConfidential: 'Server app with a client secret',
  kindPublic: 'Public app, signs in with PKCE only',
  statusPending: 'Waiting for approval. Only your own account can authorise it.',
  statusApproved: 'Approved. Any account can authorise it.',
  statusSuspended: 'Suspended. No account can authorise it and its tokens are revoked.',
  secretRolledAt: 'Secret last changed {when}',
  rollSecret: 'Change client secret',
  rolling: 'Changing the secret',
  rollNote: 'The old secret stops working at once. If you lost it, change it here.',

  formHeading: 'Register an app',
  name: 'App name',
  description: 'What the app does',
  descriptionHint: 'People see this when they are asked to allow the app.',
  redirectsField: 'Redirect addresses',
  redirectsHint: 'One per line. Each must be an exact https address, with no wildcard and no # fragment.',
  scopesField: 'Scopes the app may ask for',
  scopesHint: 'One per line, written module:action, for example trade:read. A scope that needs an interactive session cannot be declared.',
  kindField: 'Type',
  submit: 'Register app',
  submitting: 'Registering',
  needName: 'Give the app a name of at least two characters.',
  needRedirect: 'Add at least one redirect address.',
  badRedirect: '{url} is not an exact https address.',
  needScope: 'Add at least one scope.',
  manyRedirects: 'An app can have at most {limit} redirect addresses.',

  secretTitle: 'Client secret for {name}',
  secretOnce: 'This is the only time the secret is shown. Copy it into your server settings now; it cannot be shown again.',
  secretPublic: '{name} is a public app and has no client secret.',
  secretDone: 'I have saved it',
  registered: '{name} was registered. It is waiting for approval.',
  replay: '{name} was already registered. A secret is shown only once, so none is shown now. Change the secret to get a new one.',

  refusedHeading: 'The service refused this',
  'oauth.redirect_url_invalid': 'A redirect address must be an exact https address.',
  'oauth.scope_not_delegable': 'A scope that needs an interactive session cannot be declared by an app.',
  'oauth.invalid_scope': 'A scope is not one the platform knows.',
  'oauth.scope_empty': 'At least one scope is required.',
  'oauth.idempotency_conflict': 'This app name was already registered with different details. Use another name or the same details.',
  'oauth.key_principal_refused': 'An API key cannot manage apps. Sign in with your account.',
  'oauth.account_not_active': 'This account cannot register apps right now.',
  'oauth.app_not_found': 'That app was not found.',
  'oauth.operator_denied': 'This needs an operator session.',
  'oauth.lifetime_unset': 'The owner has not published the lifetime that signing in with apps needs, so apps are switched off.',
  'oauth.app_not_approved': 'This app has not been approved for other accounts.',
  'oauth.redirect_uri_mismatch': 'The return address in this request is not one the app registered.',
  'oauth.invalid_request': 'The request was refused.',
  'oauth.invalid_client': 'The app could not be identified.',
  'oauth.invalid_grant': 'The request was refused.',
  'oauth.access_denied': 'The request was refused.',
  otherRefusal: 'The service refused this request.',

  consentEyebrow: 'Account',
  consentTitle: 'Allow {app} to use your account?',
  consentLead: '{app} asked to:',
  consentOwn: 'This is your own app, waiting for approval. Only you can allow it.',
  consentNote: 'You can stop an app at any time. It never sees your password and cannot do anything outside the list.',
  consentNoDescription: 'No description was written for this permission.',
  allow: 'Allow',
  deny: 'Deny',
  sending: 'Sending your answer',
  consentLoading: 'Checking the request',
  consentSignedOutTitle: 'Sign in to answer this request',
  consentSignedOutBody: 'An app is asking to use your account. Sign in first, then you will see exactly what it asked for.',
  consentFailed: 'This request cannot be answered.',
  consentNoRedirect: 'The service did not return a safe address to send you back to. Nothing was shared.',
  consentDone: 'Your answer was sent. You can close this page.',
  consentGoBack: 'Back to your account',

  problemTitle: 'This request is not valid',
  problemBody: 'Nothing was shared and you were not sent anywhere. The app that sent you here has to fix its request.',
  problem_missing_client_id: 'The request has no client_id.',
  problem_missing_redirect_uri: 'The request has no redirect_uri.',
  problem_missing_state: 'The request has no state value.',
  problem_missing_challenge: 'The request has no code_challenge. Every app must use PKCE.',
  problem_method_not_s256: 'The request must use code_challenge_method=S256.',
  problem_response_type_not_code: 'The request must use response_type=code.',
  problem_missing_scope: 'The request names no scope.',
  problem_malformed: 'The request has a malformed value.',

  scope_identity_read: 'See your account profile',
  scope_identity_write: 'Change your account settings',
  scope_ledger_read: 'See your balances and ledger history',
  scope_trade_read: 'See your orders, trades and positions',
  scope_trade_write: 'Place and cancel orders for you',
  scope_p2p_read: 'See your peer-to-peer orders',
  scope_p2p_write: 'Act on your peer-to-peer orders',
  scope_bank_read: 'See your bank accounts and transfers',
  scope_pay_read: 'See your payments',
  scope_token_read: 'See your token holdings',
} as const;

export const appsCopy = defineCopy('developers.apps', en);
export type AppsKey = keyof typeof en;
type ScopeKey = Extract<AppsKey, `scope_${string}`>;
type RefusalKey = Extract<AppsKey, `oauth.${string}`>;

/** The plain-words line of a scope, or null when none is written (the page then shows the scope name alone). */
export function scopeCopyKey(scope: string): ScopeKey | null {
  const key = `scope_${scope.replace(/[^a-z0-9]+/g, '_')}` as ScopeKey;
  return key in en ? key : null;
}

/** The line for a service `oauth.*` code, or null when none is written (the page then says it was refused and shows the code). */
export function refusalCopyKey(code: string | undefined): RefusalKey | null {
  return code !== undefined && code.startsWith('oauth.') && code in en ? (code as RefusalKey) : null;
}
