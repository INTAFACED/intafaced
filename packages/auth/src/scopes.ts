/**
 * PERMISSION SCOPES (§4.1 api_keys, §9 Public API).
 *
 * A scope is `<module>:<action>`. Sessions and API keys both carry scopes;
 * nothing in the OS authorises on "is logged in" alone.
 *
 * `:write` never implies `:read` and `:read` never implies `:write` — implication
 * is spelled out in IMPLIED below, so an audit of what a key can do is a lookup,
 * not an inference.
 */

export const SCOPES = [
  // Identity
  'identity:read',
  'identity:write',

  // Ledger — note there is no `ledger:write`. Balances move through recipes
  // invoked by a module's own service credentials, never through a user token.
  'ledger:read',

  // Trade
  'trade:read',
  'trade:write',
  'trade:withdraw',

  // Pay
  'pay:read',
  'pay:write',
  'pay:refund',
  'pay:payout',
  // Opening a merchant account. Not an acquiring scope: it cannot move money.
  'pay:onboard',

  // P2P
  'p2p:read',
  'p2p:write',

  // Token
  'token:read',
  'token:stake',

  // Blueprint — `:write` is what runs an onboarding session or erases a
  // Blueprint. Reading someone else's is governed by `blueprints.visibility`
  // on top of this scope, never by the scope alone.
  'blueprint:read',
  'blueprint:write',

  // Bank
  'bank:read',
  'bank:write',
  'bank:card',

  // Launch / Market / Academy
  'launch:read',
  'launch:write',
  'market:read',
  'market:write',
  // Marketplace operator actions — vetting a vendor application. Separate from
  // `market:write`, which is what a user APPLIES with: an applicant who could
  // also decide is not an applicant. Same shape as `support:ops`, and for the
  // same reason a module-local ops scope beats `admin:write` here — halting a
  // marketplace and approving a vendor are different authorities.
  'market:ops',
  'academy:read',
  'academy:write',

  // Agents — an agent acting for a user needs this plus the module scopes it uses.
  'agents:read',
  'agents:execute',

  // Notify — in-app inbox only. `:write` is mark-read / mark-all-read on the
  // caller's own rows; there is no path that targets another user.
  'notify:read',
  'notify:write',
  'support:read',
  'support:write',
  'support:ops',

  // Tax export — read-only lot packs over the caller's own ledger books.
  'tax:read',
  // Tax settings — the caller's own cost-basis choices (matching method, lot
  // picks, a price they enter for a lot). Never a ledger write.
  'tax:write',

  // Campaigns (svc-campaigns). `:read` is the catalogue and the caller's own
  // participations; `:write` joins or subscribes the caller to a campaign. The
  // operator desk (create, transition, publish) is `campaigns:ops`, a
  // module-local ops scope like `market:ops`: running a promotion and halting a
  // module are different authorities.
  'campaigns:read',
  'campaigns:write',
  'campaigns:ops',

  // Ops business systems (CRM / team / revenue / projects). Non-custodial.
  'ops:read',
  'ops:write',

  // Protocol plane (read-only by definition: keys are the user's, not ours)
  'protocol:read',

  // Operator
  'admin:read',
  'admin:write',
  'admin:treasury',
  'admin:compliance',
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/**
 * Explicit implication. A listed scope grants only itself, except these two
 * operator scopes, which also grant `admin:read`. `bank:card`, `market:ops`,
 * `agents:execute`, and `support:ops` do not add a `:read` the caller left
 * off the list.
 */
const IMPLIED: Partial<Record<Scope, readonly Scope[]>> = {
  'admin:treasury': ['admin:read'],
  'admin:compliance': ['admin:read'],
};

/** Expand a scope list to everything it actually grants. */
export function expandScopes(granted: readonly string[]): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted) {
    if (!isScope(s)) continue;
    out.add(s);
    for (const implied of IMPLIED[s] ?? []) out.add(implied);
  }
  return out;
}

export function hasScope(granted: readonly string[], required: Scope): boolean {
  return expandScopes(granted).has(required);
}

/**
 * Scopes that must never be granted to a long-lived API key.
 *
 * Three membership tests, all closed:
 *
 *   1. Moves value OFF the platform (`trade:withdraw`, `admin:treasury`,
 *      `bank:card`). A leaked key must not be able to do that on its own (§9).
 *      These also require 2FA on the session (`SESSION_MFA_SCOPES`).
 *      Merchant refund and payout are D-145, not this list.
 *   2. Founder or operator desk authority (`admin:read`, `admin:write`,
 *      `admin:compliance`, `admin:treasury`, `support:ops`, `market:ops`).
 *      A founder session used to be able to copy `admin:write`, `admin:read`
 *      and `support:ops` onto an API key, and a session that held
 *      `admin:compliance` or `market:ops` could do the same. A long-lived key
 *      then bypasses the founder MFA and session model. Desk scopes stay on
 *      the interactive session. A procedure that needs a second factor calls
 *      `requireMfa` itself — being interactive-only is not the same as
 *      requiring 2FA.
 *   3. `pay:onboard` (#4897). It does not move money. It is interactive-only
 *      so it can never sit on an API key. Main's `requireScope` treated every
 *      member of this list as the 2FA gate, and a login token is issued with
 *      `mfa: false`, so it stays in `SESSION_MFA_SCOPES` too.
 *
 * `pay:refund` and `pay:payout` are not on this list (D-145). An ordinary
 * session never carries them. A key carries one only when `apiKeys.create`
 * asked for it under `auth.stepUpPay` (`assertDelegatableScopes` with
 * `payStepUp`). `pay:payout` on a key still pays only to a stored verified
 * destination (D-142). `pay:onboard` stays interactive-only.
 */
export const INTERACTIVE_ONLY_SCOPES: readonly Scope[] = [
  'trade:withdraw',
  'admin:treasury',
  'bank:card',
  'pay:onboard',
  'admin:read',
  'admin:write',
  'admin:compliance',
  'support:ops',
  'market:ops',
  'campaigns:ops',
];

/** Scopes `auth.stepUpPay` may add, and only those. */
export const PAY_STEP_UP_SCOPES = ['pay:refund', 'pay:payout'] as const;
export type PayStepUpScope = (typeof PAY_STEP_UP_SCOPES)[number];

/** Step-up access token lifetime. Ten minutes. Refresh does not reissue it. */
export const PAY_STEP_UP_ACCESS_TTL_SECONDS = 600;

/** Factor proof lifetime. Five minutes, the same window as STEPUP #4880. */
export const PAY_STEP_UP_FACTOR_TTL_SECONDS = 300;

export function isPayStepUpScope(scope: string): scope is PayStepUpScope {
  return (PAY_STEP_UP_SCOPES as readonly string[]).includes(scope);
}

/**
 * Interactive-only scopes that also require a second factor on the session.
 *
 * A subset of `INTERACTIVE_ONLY_SCOPES`. Founder desk scopes are interactive-only
 * (refused on an API key) and are not in this list. Whether a live founder
 * session receives one is `IDENTITY_FOUNDER_SESSION_SCOPES`, and only after MFA.
 * Procedures that need a second factor call `requireMfa` themselves.
 * `pay:onboard` is in this list because #4897 put it on the list `requireScope`
 * used as the 2FA gate.
 */
export const SESSION_MFA_SCOPES: readonly Scope[] = ['trade:withdraw', 'admin:treasury', 'bank:card', 'pay:onboard'];

/**
 * Scopes a person's own session may carry and nothing delegated ever does.
 *
 * Unlike `INTERACTIVE_ONLY_SCOPES`, a scope here may be issued by default
 * (that is `SESSION_SCOPES`' call). It is kept off API keys because what it
 * authorises spends the person's own money at the person's own instruction:
 * `agents:execute` runs a metered agent (OWNER 107, 29 Oct 2026: "Every
 * signed-in person may run agents from their own session, never from API keys
 * or delegated tokens"). `requireScope` refuses a key or sub-account token that
 * carries one.
 */
export const PERSON_ONLY_SCOPES: readonly Scope[] = ['agents:execute'];

/** True for a scope no API key may hold: interactive-only or person-only. The one test every key path uses. */
export function isKeyForbiddenScope(scope: string): boolean {
  return (INTERACTIVE_ONLY_SCOPES as readonly string[]).includes(scope) || (PERSON_ONLY_SCOPES as readonly string[]).includes(scope);
}

export function assertKeyScopesAllowed(scopes: readonly string[]): void {
  const forbidden = scopes.filter(isKeyForbiddenScope);
  if (forbidden.length > 0) {
    throw new Error(`Scopes ${forbidden.join(', ')} cannot be granted to an API key — they require an interactive session (§9)`);
  }
}

// ── What a session is issued ─────────────────────────────────────────────────

/**
 * THE SCOPES A NORMAL INTERACTIVE SESSION CARRIES.
 *
 * This list is the platform's answer to "what may a logged-in account do", and
 * it lives here rather than inside svc-identity so the services enforcing the
 * scopes and the service issuing them read from one file.
 *
 * ── The rule, stated once ───────────────────────────────────────────────────
 *
 * A scope answers "is this account entitled to this class of action, at all".
 * The JURISDICTION_MATRIX answers "may this caller do it here, today, at this
 * verification tier". Different questions, different answers, checked at
 * different times:
 *
 *   - A scope is minted into a token that outlives the request that made it.
 *     Making issuance region-dependent would bind a token to the region it was
 *     issued in, and a user who travelled would lose access until it rotated.
 *   - The matrix is evaluated per request against `ctx.region` — resolved by the
 *     edge, never by the caller — and `principal.tier`. Both can change between
 *     a token being issued and being used.
 *
 * So: issue the scope, and let the matrix rule on tier and region.
 *
 * The alternative — withholding `bank:write` until a user is verified — sounds
 * safer and is worse. It is not a real constraint, because every bank procedure
 * is matrix-gated at tier `full` whatever scopes the caller holds. What it does
 * change is the refusal: "you lack a scope" instead of "you need verification
 * tier full", which is a dead end the UI cannot turn into an action.
 *
 * ── What that rule does NOT license ─────────────────────────────────────────
 *
 * Everything absent from this list is absent for a stated reason, in
 * WITHHELD_FROM_SESSION below. The compiler enforces that the two together
 * cover SCOPES exactly, so a new scope cannot reach a token — or fail to —
 * without someone deciding, in writing, who gets it.
 */
const SESSION_SCOPE_LIST = [
  'identity:read',
  'identity:write',
  'ledger:read',
  'trade:read',
  'trade:write',
  'p2p:read',
  'p2p:write',
  'token:read',
  'token:stake',
  'academy:read',
  // Non-custodial, `minTier: 'none'`, and now backed by a service that mounts a
  // router. `academy:write` is what TAKES A SEAT in a lobby, and a lobby nobody
  // may sit in is not a lobby — withholding it would ship svc-academy
  // unreachable, which is the outage-with-a-comment this table exists to stop.
  //
  // What it deliberately does NOT decide is who may HOST. That is §4.1's
  // `rank_thresholds.perks.lobbyHostRights`, read from svc-identity at
  // `createRoom` (services/svc-academy/src/host-rights.ts). Had hosting ridden
  // on this scope, issuing it here would have handed room creation to every
  // account on the platform in the same commit — and §XIII's model is
  // ambassadors and operators running rooms, not anyone with a login.
  'academy:write',
  'agents:read',
  // Non-custodial, `minTier: 'none'`. §22 makes this the easy case: the
  // platform never holds a Blueprint, so there is nothing to verify anyone
  // against. `:write` runs an onboarding session or ERASES a Blueprint — both
  // act only on the caller's own row, and gating erasure behind a KYC file
  // would be exactly the wrong way round.
  'blueprint:read',
  'blueprint:write',
  // Custodial, Fiat Plane, `minTier: 'full'`, and blocked outright in US. The
  // scope says a user account may operate a bank space at all; the matrix says
  // not until tier `full`, and not from there. Both are issued so the refusal a
  // user actually meets is the one that tells them what to do about it.
  // `bank:card` is deliberately NOT here — see below.
  'bank:read',
  'bank:write',
  // Non-custodial in-app inbox. Self-only mark-read; minTier none.
  'notify:read',
  'notify:write',
  // Support desk (ops.support Stage-1) — non-custodial tickets.
  'support:read',
  'support:write',
  // Lot export. Non-custodial view over the caller's own books; minTier none.
  // Issued with the service that mounts it — a scope for a router nobody can
  // call is the outage this table exists to stop.
  'tax:read',
  // The caller's own cost-basis choices for that view: which matching method,
  // which lot a sale used, a price they enter for a lot with no cost. Writes
  // only svc-tax's own settings rows for the caller, moves no value and posts
  // nothing to the ledger, so `minTier: 'none'` like the read.
  'tax:write',
  // CRM / team directory / warehouse revenue / projects (ops.business-systems).
  // Non-custodial, minTier none. Issued with svc-ops — a scope for a router
  // nobody can call is the outage this table exists to stop. Payroll is not a
  // scope; inventPayroll refuses by name.
  'ops:read',
  'ops:write',
  // Campaigns catalogue and the caller's own participations. Non-custodial and
  // `minTier: 'none'`: joining a campaign moves no value (a reward pays later
  // through the ledger's reward recipe, under the campaigns service's own
  // grant). Issued with the service that mounts it, svc-campaigns.
  'campaigns:read',
  'campaigns:write',
  // UNSTUBBED. These read 'svc-market not built' until this commit, and the
  // reason given there was the right one: "a scope for a router that cannot be
  // called is noise in every token in the platform; these get issued by the PR
  // that ships the service." This is that PR — `services/svc-market` mounts
  // /trpc and svc-edge routes `/api/market` to it.
  //
  // `market:write` is what APPLIES to be a vendor, and an application nobody may
  // submit is not an application — withholding it would ship svc-market
  // unreachable, the outage-with-a-comment this table exists to stop.
  //
  // Issued even though `market` is `custodial: true`, for the reason `bank:read`
  // and `bank:write` are: the module is OPEN_BASIC in the JURISDICTION_MATRIX, so
  // an unverified caller is refused at tier `basic` whatever scopes they hold —
  // and the refusal they meet then names the step they can take, instead of a
  // dead end the UI cannot turn into an action. Vendor lifecycle Stage 1 takes
  // custody of nothing in any case; that is `market.commerce`.
  //
  // What this deliberately does NOT hand out is the authority to DECIDE an
  // application. That is `market:ops`, withheld below.
  'market:read',
  'market:write',
  // Read-only by construction, on a plane that has no write scope to hold:
  // svc-protocol's own suite asserts `SCOPES` contains no `protocol:write`.
  // Non-custodial and `minTier: 'none'`, so §22 says permissionless — and a
  // scope issued to nobody left the smart-account claim flow unreachable.
  'protocol:read',
  // `satisfies`, not a plain `as const`. The comment on WITHHELD_SCOPE_REASONS
  // credits the compiler with enforcing that every scope is either issued to a
  // session or withheld with a written reason — but nothing constrained the
  // members of THIS list to be real scopes, so a typo was caught only
  // indirectly, by the mistyped scope going missing from the withheld side.
  // This makes the guarantee the one the comment claims.
] as const satisfies readonly Scope[];

export type SessionScope = (typeof SESSION_SCOPE_LIST)[number];

export const SESSION_SCOPES: readonly SessionScope[] = SESSION_SCOPE_LIST;

/**
 * Operator scopes a live founder session may receive, and only these.
 *
 * The lead publishes the subset in `IDENTITY_FOUNDER_SESSION_SCOPES`. Blank
 * grants nothing. `admin:treasury`, `trade:withdraw`, `bank:card` and every
 * `pay:` scope are absent on purpose: they move money or spend a card, and a
 * founder session must not grow them from this list. `academy:read`,
 * `agents:read`, `bank:read` and `token:read` are already in `SESSION_SCOPES`.
 *
 * Granted only to a live founder on an interactive MFA session that is not an
 * API key and not a sub-account. Re-read the config on every refresh.
 * `assertDelegatableScopes` refuses every name here, so a founder cannot copy
 * one onto a key.
 */
export const FOUNDER_SESSION_SCOPE_ALLOWLIST = [
  'admin:read',
  'admin:write',
  'admin:compliance',
  'market:ops',
  'support:ops',
  'campaigns:ops',
] as const satisfies readonly Scope[];

/** Same set. Kept so the key-delegation refusal has one name. */
export const FOUNDER_DESK_SCOPES = FOUNDER_SESSION_SCOPE_ALLOWLIST;

export const FOUNDER_SCOPE_INVALID = 'identity.founder_scope_invalid' as const;

export class FounderScopeInvalidError extends Error {
  readonly code = FOUNDER_SCOPE_INVALID;
  constructor(name: string) {
    super(`${FOUNDER_SCOPE_INVALID}: ${name || '(blank)'}`);
    this.name = 'FounderScopeInvalidError';
  }
}

/**
 * Parse the founder-session scope config. Blank or unset grants nothing.
 * A name outside the allowlist, an unknown scope, a blank segment or a
 * duplicate refuses. Boot calls this so a bad value never starts the process.
 */
export function parseFounderSessionScopes(raw: string | undefined | null): readonly Scope[] {
  if (raw === undefined || raw === null) return [];
  const text = raw.trim();
  if (text === '') return [];
  const out: Scope[] = [];
  for (const part of text.split(',')) {
    const name = part.trim();
    if (name === '' || !(FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(name) || out.includes(name as Scope)) {
      throw new FounderScopeInvalidError(name);
    }
    out.push(name as Scope);
  }
  return out;
}

/** What env stores: the parsed grant and the exact config string that was hashed. */
export function founderSessionScopesFromEnv(raw: string | undefined | null): {
  readonly scopes: readonly Scope[];
  readonly configValue: string;
} {
  const configValue = (raw ?? '').trim();
  return { scopes: parseFounderSessionScopes(configValue), configValue };
}

export function scopesForFounderSession(
  base: readonly Scope[],
  opts: {
    readonly founder: boolean;
    readonly mfa: boolean;
    readonly apiKey?: boolean;
    readonly subAccount?: boolean;
    /** Absent or empty grants nothing. Names outside the allowlist are dropped. */
    readonly configured?: readonly Scope[];
  },
): Scope[] {
  const out = [...base];
  if (!opts.founder || !opts.mfa || opts.apiKey === true || opts.subAccount === true) return out;
  for (const scope of opts.configured ?? []) {
    if (!(FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(scope)) continue;
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/**
 * Every scope a session does NOT get, and why.
 *
 * The type is the point. `Exclude<Scope, SessionScope>` means adding a scope to
 * SCOPES without either issuing it or writing down why it is withheld does not
 * compile. A scope nobody can be issued is an outage with a comment; a scope
 * quietly issued to everybody is a custody hole. This table is how neither
 * happens by accident.
 */
export const WITHHELD_FROM_SESSION: Readonly<Record<Exclude<Scope, SessionScope>, string>> = {
  // Step-up only, so an XSS-stolen access token cannot drain an account.
  // `auth.stepUp` adds it for five minutes against a fresh TOTP code (§9).
  'trade:withdraw': 'Issued only by auth.stepUp, against a second factor',

  // Merchant surface, not user surface. A user's own money entering and leaving
  // the book runs on `trade:withdraw` / `trade:read` / `ledger:read` — see the
  // user-money router in svc-pay. `pay:*` is acquiring: third-party card money
  // moving through a merchant we onboarded. Granted by merchant onboarding, not
  // by holding an account.
  //
  // Grant mechanism (D26-P0-08 → P1-P10): `issueMerchantPayScopes`.
  // Published 2026-10-17: the owner of one KYB-approved merchant receives
  // pay:read and pay:write for that merchant. These four stay off ordinary
  // sessions. Layer B (`pay.kyb_required`) is a separate money gate.
  'pay:read': 'Merchant acquiring surface — granted by merchant onboarding',
  'pay:write': 'Merchant acquiring surface — granted by merchant onboarding',
  'pay:refund': 'Merchant acquiring surface — refunds another party’s payment; issued only by auth.stepUpPay',
  'pay:payout': 'Merchant acquiring surface — issued only by auth.stepUpPay step-up, for at most ten minutes',
  'pay:onboard': 'Opens one root merchant account. Interactive only, so it can never sit on an API key. Not issued on an ordinary session.',

  // §18 card issuance. In INTERACTIVE_ONLY_SCOPES: it authorises spend from a
  // funded card, so it needs a 2FA session and must never sit on a long-lived
  // key. `bank:read` and `bank:write` are issued; this one is not.
  'bank:card': 'Card spend authority — interactive-only step-up surface (§9, §18)',

  // Running an agent spends real money: svc-agents meters model cost and
  // settles it against the user's balance. The owner decided issuance (OWNER 107);
  // it stays withheld until svc-agents bounds every run, in the PR that issues it.
  'agents:execute':
    'Metered spend. Owner decision 29 Oct 2026 (OWNER 107): every person may run agents from their own session; issued by the PR in which svc-agents bounds each run (agent cap, own limits, balance, published rate). Never on a key (PERSON_ONLY_SCOPES).',

  // No service exists yet (§12 Phase 5). A scope for a router that cannot be
  // called is noise in every token in the platform; these get issued by the PR
  // that ships the service.
  'launch:read': 'svc-launch not built',
  'launch:write': 'svc-launch not built',

  // Support operator actions (assign/resolve). Users get support:read/write on
  // session; ops is staff-only.
  'support:ops': 'Operator scope — support desk staff actions',

  // Marketplace operator actions (vetting a vendor application). Users get
  // market:read/write on session; deciding is staff-only. An applicant who could
  // also approve their own application is not an applicant, and svc-market has no
  // criterion to decide with — a human supplies the decision (§8 "mine alone").
  'market:ops': 'Operator scope — vetting a vendor application is a human decision',

  // Campaign operator actions (create, transition, publish). Users get
  // campaigns:read/write on session; running a promotion is staff-only, and a
  // publish that moves value also needs a second person.
  'campaigns:ops': 'Operator scope — running a campaign is a staff action',

  // Operator scopes. Not in SESSION_SCOPES. The allowlist in
  // FOUNDER_SESSION_SCOPE_ALLOWLIST is added only when the lead configures it,
  // and only onto a live founder's interactive MFA session, by
  // `scopesForFounderSession`. `admin:treasury` is not on that list.
  'admin:read': 'Operator scope',
  'admin:write': 'Operator scope',
  'admin:treasury': 'Operator scope, and interactive-only (§9)',
  'admin:compliance': 'Operator scope — approving your own KYC is self-verification',
};

/**
 * Scopes a principal may delegate to something acting on its behalf.
 *
 * An API key is a delegation, and a delegation cannot create authority the
 * delegator never had. Without this check, `apiKeys.create` took an arbitrary
 * scope array from the request and stored it verbatim: any logged-in account
 * could mint a key bearing `admin:compliance`, approve its own KYC record to
 * `institutional`, and unlock every custodial module in the platform.
 *
 * `assertKeyScopesAllowed` is the interactive-only check: value leaving the
 * platform, and every founder/operator desk scope. A session that holds
 * `admin:compliance` still cannot copy it onto a key.
 *
 * Unknown strings are refused rather than skipped. A key requesting `bank:admin`
 * has either a bug or an intent behind it, and storing it silently leaves an
 * audit trail claiming the key holds a scope no guard will ever recognise.
 */
export function assertDelegatableScopes(
  requested: readonly string[],
  grantorScopes: readonly string[],
  options?: { readonly payStepUp?: boolean },
): void {
  const unknown = requested.filter((s) => !isScope(s));
  if (unknown.length > 0) {
    throw new Error(`Unknown scopes: ${unknown.join(', ')}`);
  }

  // Checked first: a long-lived credential may never carry these even from a
  // session that legitimately holds them, and that message is the clearer one.
  assertKeyScopesAllowed(requested);

  // D-145. Owner grants never imply these. A key gets one only when this call
  // says the creator asked for it under step-up, and the granting token holds it.
  const stepUp = requested.filter((s) => isPayStepUpScope(s));
  if (stepUp.length > 0 && options?.payStepUp !== true) {
    throw new Error(`Scopes ${stepUp.join(', ')} can be granted to an API key only when explicitly requested under step-up`);
  }

  const held = expandScopes(grantorScopes);
  const notHeld = requested.filter((s) => !held.has(s as Scope));
  if (notHeld.length > 0) {
    throw new Error(`Cannot grant scopes the granting session does not hold: ${notHeld.join(', ')}`);
  }
  const desk = requested.filter((s) => (FOUNDER_DESK_SCOPES as readonly string[]).includes(s));
  if (desk.length > 0) {
    throw new Error(`Founder desk scopes stay on the interactive founder session: ${desk.join(', ')}`);
  }
}
