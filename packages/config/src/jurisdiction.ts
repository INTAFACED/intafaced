import { MODULES, type ModuleId, type Plane } from './modules.js';
import { isExplicitDevOrTest } from './app-env.js';
import {
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_REFUSE_FIXTURE,
  SCREENING_REFUSE_UNCONFIGURED,
  SCREENING_REVIEWED_EMPTY,
  ScreeningMoneyPostureError,
  envScreeningList,
  evaluateScreeningMoneyPosture,
  screeningMoneyGrade,
  type BlockAuthority,
  type ScreenedRegion,
  type ScreeningDeclaration,
  type ScreeningList,
  type ScreeningMoneyGrade,
} from './screening.js';

/**
 * JURISDICTION_MATRIX (§3, §9, §22).
 *
 * The single place geo rules live. Every module checks the matrix; launch
 * markets are a toggle, not a refactor.
 *
 * §22 THE SOVEREIGNTY LAW — encoded in `checkAccess`:
 *   custody === false  → permissionless. No KYC gate. The platform never holds
 *                        the asset, so there is nothing to verify.
 *   custody === true   → tiered verification per this matrix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATOR NOTE — the seed entries below are a STRUCTURE, not legal advice.
 * Every `status` and `minTier` value must be signed off by counsel for the
 * relevant jurisdiction before that market is switched on. `reviewedBy` and
 * `reviewedAt` are required on any rule that ships to prod; `assertReviewed()`
 * is called by the DoD gate for launch markets.
 *
 * THE SANCTIONS BLOCKLIST IS EMPTY, ON PURPOSE, AND STILL NEEDS COUNSEL.
 * No list ships configured. What changed is that the empty state is no longer
 * invisible: every decision reports whether a list was consulted
 * (`AccessDecision.screening`), and `assertScreeningConfigured()` refuses to let
 * a production-like process boot without one. See `screening.ts` for the shape
 * counsel's answer goes into — supplying it is a config change, not an
 * engineering project.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS BUSINESS CONFIGURATION. IT IS NOT THE SANCTIONS AUTHORITY.
 *
 * Everything in `JURISDICTION_MATRIX` — `status`, `minTier`, `limitMultiplier`,
 * and `blocked` — is business configuration: which markets we open, at what
 * tier, with what limits. It is edited by ordinary contributors in ordinary PRs
 * for licensing, commercial and product reasons.
 *
 * The sanctions screening list is a DIFFERENT authority with a DIFFERENT owner
 * (counsel, per DIRECTION §8) and it lives in `screening.ts`, supplied as
 * configuration at deploy time.
 *
 * They used to be able to satisfy each other. A `blocked: true` entry here was
 * folded into a `ScreeningList` and merged with the counsel-supplied one, so
 * ONE region blocked for a commercial reason flipped `assertScreeningConfigured`
 * from "refuse to start" to "satisfied" while the sanctions list was still empty
 * and nobody in counsel had supplied anything. Two authorities sharing one
 * literal, and the weaker one silently vouching for the stronger.
 *
 * They are separated now, and the separation runs both ways:
 *
 *   · A `blocked: true` entry here STILL REFUSES THE REGION. Nothing about the
 *     existing refusal is weakened — see `businessBlockFor` and `checkAccess`.
 *   · It CANNOT satisfy the screening guard. Only `screening.ts` can.
 *   · Every refusal records WHICH authority refused (`AccessDecision.blockedBy`),
 *     so a legal control and a commercial one are never read as the same thing.
 *
 * Where the two cannot be told apart — a `blocked: true` entry whose reason
 * nobody wrote down — the ambiguous case refuses in both directions: the region
 * stays blocked, and the boot guard stays unsatisfied.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const KYC_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type KycTier = (typeof KYC_TIERS)[number];

const TIER_ORDER: Readonly<Record<KycTier, number>> = { none: 0, basic: 1, full: 2, institutional: 3 };

export function tierSatisfies(held: KycTier, required: KycTier): boolean {
  return TIER_ORDER[held] >= TIER_ORDER[required];
}

export type RuleStatus =
  /** Module available to anyone meeting `minTier`. */
  | 'open'
  /** Available but with reduced limits / extra checks. */
  | 'restricted'
  /** Not offered in this region. */
  | 'blocked';

export interface JurisdictionRule {
  readonly status: RuleStatus;
  readonly minTier: KycTier;
  /** Multiplier applied to standard limits (1 = standard). */
  readonly limitMultiplier?: number;
  readonly notes?: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

/** ISO-3166 alpha-2, or `*` for the default rule. */
export type RegionCode = string;

export interface JurisdictionEntry {
  readonly region: RegionCode;
  /**
   * Region is not served at all — overrides every module rule.
   *
   * THIS IS A BUSINESS DECISION, NOT A SANCTIONS ONE. Set it for a licence we
   * do not hold, a market we have not opened, a commercial choice, a
   * placeholder. It refuses the region completely and always has.
   *
   * WHAT IT DELIBERATELY DOES NOT DO is count as sanctions screening. It cannot
   * satisfy `assertScreeningConfigured()`, and adding an entry here will not
   * make a production boot stop complaining that no screening list exists. That
   * is not an oversight — it is the point. This array is edited in ordinary PRs
   * by ordinary contributors, and one commercially-blocked region used to be
   * enough to tell the whole platform that counsel had supplied a sanctions
   * list when counsel had supplied nothing.
   *
   * ANYTHING SANCTIONS-DRIVEN GOES IN `INTAFACED_SANCTIONS_REGIONS`
   * (screening.ts). Not merely preferred — required, because that is the list
   * with a named owner, provenance on every decision, and a boot guard behind
   * it. It also moves at the speed of a deploy rather than a release.
   */
  readonly blocked?: boolean;
  readonly reason?: string;
  /** Per-module overrides; anything unlisted falls back to `defaults`. */
  readonly modules?: Partial<Record<ModuleId, JurisdictionRule>>;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

const OPEN_BASIC: JurisdictionRule = { status: 'open', minTier: 'basic' };
const OPEN_FULL: JurisdictionRule = { status: 'open', minTier: 'full' };
const BLOCKED: JurisdictionRule = { status: 'blocked', minTier: 'institutional' };

/**
 * Default rule set — applied to any region without an explicit entry.
 * Deliberately conservative: custodial money movement needs `basic`, leveraged
 * and issuance products need `full`.
 */
export const DEFAULT_MODULE_RULES: Readonly<Record<ModuleId, JurisdictionRule>> = {
  // The edge gates nothing itself. Applying a tier here would block the
  // anonymous requests that `auth.register` and `auth.login` depend on, and
  // would put a jurisdiction check in front of every module rather than in the
  // module that owns the rule.
  // No tier: the platform never holds the asset, so there is nothing to
  // verify anyone against (§503, §585). The jurisdiction STATUS still applies —
  // a sanctioned region is a legal constraint, not a custody one.
  dex: { status: 'open', minTier: 'none' },
  edge: { status: 'open', minTier: 'none' },
  identity: { status: 'open', minTier: 'none' },
  ledger: OPEN_BASIC,
  token: OPEN_BASIC,
  matching: { status: 'open', minTier: 'none' },
  trade: OPEN_BASIC,
  // Operator tenancy mechanism. No user custody; minTier none. Internal venue stays refused in product code.
  execution: { status: 'open', minTier: 'none' },
  // Public market data. There is no user, no account and no asset behind a
  // depth frame, so there is nobody for a tier to be about — the same reasoning
  // that leaves `matching` at `none`. The jurisdiction STATUS still applies: a
  // blocked region is a legal constraint on serving the region at all, which is
  // a separate question from custody.
  ws: { status: 'open', minTier: 'none' },
  pay: OPEN_FULL,
  p2p: OPEN_BASIC,
  blueprint: { status: 'open', minTier: 'none' },
  bank: OPEN_FULL,
  launch: OPEN_FULL,
  academy: { status: 'open', minTier: 'none' },
  market: OPEN_BASIC,
  'mining-pool': OPEN_BASIC,
  agents: { status: 'open', minTier: 'none' },
  'core-ops': { status: 'open', minTier: 'none' },
  support: { status: 'open', minTier: 'none' },
  // Reporting view over the caller's own books. No custody; minTier none.
  // Mapped regions come from owner TAX_JURISDICTION_MAP_JSON, not this matrix.
  tax: { status: 'open', minTier: 'none' },
  // Paper sandbox, no custody. Sanctioned regions still refuse via screening.
  quant: { status: 'open', minTier: 'none' },
  // Inbox only — no custody, no money movement. minTier none so a user can
  // always read their own notifications regardless of verification tier.
  notify: { status: 'open', minTier: 'none' },
  // Protocol Plane — no custody, therefore no tier. Kept explicit so a future
  // edit that raises these trips the custody-scan review.
  chain: { status: 'open', minTier: 'none' },
  indexer: { status: 'open', minTier: 'none' },
  bridge: OPEN_FULL,
  protocol: { status: 'open', minTier: 'none' },
};

/**
 * Seed matrix. Add a market by adding an entry — no code changes anywhere else.
 * Entries here carry no `reviewedBy` yet: `assertReviewed()` will refuse to let
 * them into a prod launch-market list until counsel signs them.
 */
export const JURISDICTION_MATRIX: readonly JurisdictionEntry[] = [
  { region: '*' },

  // Illustrative structure only — populate per counsel before enabling.
  {
    region: 'GB',
    modules: {
      trade: {
        status: 'restricted',
        minTier: 'full',
        limitMultiplier: 1,
        notes: 'Leveraged products restricted for retail — confirm scope with counsel.',
      },
    },
  },
  {
    region: 'US',
    modules: {
      trade: { status: 'restricted', minTier: 'full', notes: 'State-by-state licensing analysis required before enabling.' },
      launch: BLOCKED,
      bank: BLOCKED,
    },
  },
];

const BY_REGION = new Map(JURISDICTION_MATRIX.map((e) => [e.region.toUpperCase(), e]));

// ── The two authorities, wired separately ───────────────────────────────────
//
// BUSINESS BLOCKS (below) — `blocked: true` in the matrix. Commercial and
// licensing decisions, edited here in ordinary PRs. They refuse regions.
//
// SCREENING (screening.ts) — counsel-supplied sanctions content, supplied as
// configuration. It refuses regions too, and it is the ONLY thing that can
// satisfy the boot guard.
//
// `checkAccess` consults both in the same place, so the two sources cannot
// start disagreeing about whether a region is served; what it never does is let
// one stand in for the other.
//
// And every decision reports WHETHER A SCREENING LIST WAS CONSULTED. Before
// that existed, "screened and clear" and "screened nothing, because there was
// nothing to screen against" produced identical decisions, so nothing
// downstream — no log, no test, no dashboard — could tell them apart, and the
// empty state read as a green tick.

/** Provenance label for a refusal that came from this file rather than counsel. */
export const BUSINESS_BLOCK_SOURCE = 'JURISDICTION_MATRIX';

/**
 * A region the BUSINESS refuses to serve. Deliberately not a `ScreenedRegion`.
 *
 * Two types rather than one flag on a shared type, because a shared type is
 * what let a matrix entry be counted as counsel's work. These cannot be
 * assigned into each other's collections, so re-merging them is a change
 * somebody has to write on purpose and defend in review — not a one-line
 * `filter().map()` that nobody reads again.
 */
export interface BusinessBlock {
  readonly region: RegionCode;
  /** Optional, exactly as on the entry — see `checkAccess` for the fallbacks. */
  readonly reason?: string;
  readonly source: string;
  /** Always `'business'`. Never `'screening'`. */
  readonly authority: 'business';
}

/**
 * The business blocks in a set of matrix entries.
 *
 * Takes the entries rather than reading the module constant so the rule can be
 * tested against a matrix that actually contains a `blocked: true` entry. The
 * shipped matrix contains none, and a rule about the blocked case that can only
 * be exercised when somebody adds one is a rule with no test.
 */
export function businessBlocksFrom(entries: readonly JurisdictionEntry[]): readonly BusinessBlock[] {
  return entries
    .filter((e) => e.blocked === true)
    .map((e) => ({ region: e.region.toUpperCase(), reason: e.reason, source: BUSINESS_BLOCK_SOURCE, authority: 'business' as const }));
}

/**
 * The business blocks the shipped matrix actually declares. Currently none.
 *
 * EXPORTED, AND THAT IS THE SEAM. Every function below that consults business
 * blocks takes them as a defaulted parameter defaulting to this — because the
 * shipped matrix has ZERO `blocked: true` entries, and a rule that can only be
 * exercised once somebody adds one is a rule no test can hold to account.
 *
 * The specific failure this prevents: a test named "a business block leaves the
 * boot guard refusing" that stages no business block. It passes. It passed
 * before the fix too, against the exact code that let a commercial block satisfy
 * a sanctions guard, because the guard had nothing to be satisfied by. A
 * compliance test that cannot fail is not evidence, and this is a compliance
 * control — so the blocked case gets a way in.
 */
export const SHIPPED_BUSINESS_BLOCKS: readonly BusinessBlock[] = businessBlocksFrom(JURISDICTION_MATRIX);

let businessLookupCache: { blocks: readonly BusinessBlock[]; byRegion: ReadonlyMap<string, BusinessBlock> } | null = null;

/** Trimmed upper-case region. Blank stays blank; it is not a region code. */
function canonicalRegion(region: RegionCode): string {
  return region.trim().toUpperCase();
}

/** Blank and the `XX` sentinel are not region codes. Callers must not look them up. */
function isUnresolvedRegionCode(code: string): boolean {
  return code === '' || code === UNRESOLVED_REGION;
}

/**
 * The business block for a region, if the business refuses it outright.
 *
 * `business` is the injection seam — pass a staged set to exercise the blocked
 * case. Production callers pass nothing and get the shipped matrix. Cached on
 * the array's identity, the same way `screenedRegion` caches on the list's, so
 * repeated production lookups stay a single map build.
 */
export function businessBlockFor(
  region: RegionCode,
  business: readonly BusinessBlock[] = SHIPPED_BUSINESS_BLOCKS,
): BusinessBlock | undefined {
  const code = canonicalRegion(region);
  if (isUnresolvedRegionCode(code)) return undefined;
  if (!businessLookupCache || businessLookupCache.blocks !== business) {
    businessLookupCache = { blocks: business, byRegion: new Map(business.map((b) => [b.region, b])) };
  }
  return businessLookupCache.byRegion.get(code);
}

/**
 * Regions this file refuses for commercial or licensing reasons.
 *
 * Surfaced separately from `screeningStatus().blockedRegions` on purpose: an
 * operator counting "regions we block" must be able to see which of them are a
 * legal control and which are a business choice, because only one of those is
 * counsel's to change.
 */
export function businessBlockedRegions(business: readonly BusinessBlock[] = SHIPPED_BUSINESS_BLOCKS): readonly RegionCode[] {
  return business.map((b) => b.region);
}

/**
 * The screening list this process is actually using.
 *
 * A pass-through to the env-supplied list, and that is the fix: this function
 * used to merge `blocked: true` matrix entries in, which is how business
 * configuration came to satisfy a sanctions guard. Kept as a named seam because
 * it is where a second SCREENING-authority source (a file, a fetched list)
 * would legitimately be folded in — a business source never would be.
 *
 * Nothing was weakened by removing the fold: `checkAccess` and `isRegionBlocked`
 * have always consulted the matrix's own `blocked` flag directly and still do,
 * so the merged copy contributed no refusal that is not still made.
 */
export function activeScreeningList(env: Record<string, string | undefined> = process.env): ScreeningList {
  return envScreeningList(env);
}

let lookupCache: { list: ScreeningList; byRegion: ReadonlyMap<string, ScreenedRegion> } | null = null;

function screenedRegion(list: ScreeningList, region: RegionCode): ScreenedRegion | undefined {
  const code = canonicalRegion(region);
  if (isUnresolvedRegionCode(code)) return undefined;
  if (!lookupCache || lookupCache.list !== list) {
    lookupCache = { list, byRegion: new Map(list.regions.map((r) => [r.region, r])) };
  }
  return lookupCache.byRegion.get(code);
}

/**
 * Carried on EVERY `AccessDecision`, allowed ones included.
 *
 * `listConfigured: false` with `blockedRegionCount: 0` is the state this whole
 * change exists to surface: nothing was screened. A log line, an API response
 * or an operator dashboard can now render "0 regions blocked — list not
 * configured" instead of a reassuring tick, because the decision itself says so.
 * A compliance control whose status nobody can see is not a control.
 */
export interface ScreeningProvenance {
  /** Was a real blocklist consulted at all? `false` means nothing was screened. */
  readonly listConfigured: boolean;
  /**
   * Which of the three screening states this decision was made under.
   *
   * Needed alongside `listConfigured` because `true` with a count of zero is now
   * reachable and means something specific: `reviewed-empty`, a recorded
   * decision that no region is screened out. A reader with only the boolean and
   * the count cannot tell that from a list that happens to be short.
   */
  readonly declaration: ScreeningDeclaration;
  readonly blockedRegionCount: number;
  /** Where the list came from — governance record, env var name, or `unconfigured`. */
  readonly source: string;
  /** Counsel vs fixture vs unset. Fixtures are configured and still not clean. */
  readonly moneyGrade: ScreeningMoneyGrade;
  /** True only when counsel-grade. Never true for unset or placeholder/test lists. */
  readonly readsAsScreenedClean: boolean;
}

function provenanceOf(list: ScreeningList): ScreeningProvenance {
  const moneyGrade = screeningMoneyGrade(list);
  return {
    listConfigured: list.configured,
    declaration: list.declaration,
    blockedRegionCount: list.regions.length,
    source: list.source,
    moneyGrade,
    readsAsScreenedClean: moneyGrade === 'counsel',
  };
}

/**
 * Platform sentinel for "caller region was never resolved".
 *
 * svc-edge stamps `DEFAULT_REGION` (default `XX`) onto every principal until
 * per-request geo resolution exists (§13 `socket.geo-region-resolution`). `XX`
 * is not an ISO country we serve; it is the honest "unknown" marker.
 *
 * Historically every decision treated `XX` like any other code with no matrix
 * entry — fall through to `DEFAULT_MODULE_RULES`, which is open for every
 * module. Protocol boot still asserts that path under the fail-closed flag
 * OFF (`allowed.permissionless`). What was missing: the decision object never
 * said the region was unresolved, so logs/UI could not tell "we know you are
 * in GB" from "we never looked".
 */
export const UNRESOLVED_REGION = 'XX';

/**
 * Process-wide fail-closed switch for an unresolved region.
 *
 * Default OFF so protocol/indexer sovereignty boot (`region: 'XX'` →
 * `allowed.permissionless`) keeps working. When ON, `checkAccess` returns
 * `denied.region_unknown` for the unresolved sentinel. Mechanism only — does
 * not invent geo-IP, and does not populate sanctions content (Class X).
 *
 * Accepted truthy forms (case-insensitive): `1`, `true`, `yes`, `on`.
 */
export const REGION_FAIL_CLOSED_ENV = 'INTAFACED_REGION_FAIL_CLOSED';

/**
 * Process-wide fail-closed switch when the screening list is `unset`.
 *
 * Unset or blank refuses. `checkAccess` returns `denied.screening_unconfigured`
 * rather than `allowed` with `listConfigured: false`. A blank list is not
 * screened-clean. Explicit `1`, `true`, `yes`, and `on` also fail closed.
 * Only explicit `0`, `false`, `no`, and `off` keep the honesty-only path.
 * Unrecognised values refuse. Mechanism seal (D26-P1-O1); does **not** invent sanctions
 * list content (Class X / Nitro counsel).
 */
export const SCREENING_FAIL_CLOSED_ENV = 'INTAFACED_SCREENING_FAIL_CLOSED';

/** True when `region` is a real code: not blank, and not the unresolved sentinel. */
export function isRegionResolved(region: RegionCode): boolean {
  return !isUnresolvedRegionCode(canonicalRegion(region));
}

/**
 * Read the fail-closed switch from an env map (defaults to `process.env`).
 * Explicit `AccessQuery.regionFailClosed` always wins over this.
 */
export function regionFailClosedFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[REGION_FAIL_CLOSED_ENV]?.trim().toLowerCase() ?? '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** True when the env holds an explicit off value (`0`, `false`, `no`, `off`). Unset or unknown is NOT off. */
export function screeningFailClosedIsExplicitlyOff(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[SCREENING_FAIL_CLOSED_ENV]?.trim().toLowerCase() ?? '';
  return raw === '0' || raw === 'false' || raw === 'no' || raw === 'off';
}

/**
 * Read the screening-list fail-closed switch from an env map.
 * Explicit `AccessQuery.screeningFailClosed` always wins over this.
 *
 * An explicit off is a LOCAL-TEST stand-in. It is honoured only when raw
 * `APP_ENV` is exactly `dev` or `test`. Missing, blank and unknown names are
 * production-like: `off` is ignored and screening stays fail-closed.
 */
export function screeningFailClosedFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  if (!screeningFailClosedIsExplicitlyOff(env)) return true;
  return !isExplicitDevOrTest(env.APP_ENV);
}

export interface AccessQuery {
  readonly module: ModuleId;
  readonly region: RegionCode;
  readonly plane: Plane;
  readonly kycTier: KycTier;
  /**
   * Screen against this list instead of the process-wide one.
   *
   * For tests and for any caller that resolves its own governed list. Omitted
   * — which is every production call site — means `activeScreeningList()`.
   */
  readonly screening?: ScreeningList;
  /**
   * Use these business blocks instead of the shipped matrix's.
   *
   * The counterpart seam to `screening`, and it exists for the same reason that
   * one does — with one difference that matters. `screening` could always be
   * pointed at a populated list, so the screened-region branches of this
   * function were genuinely exercised. The business branches were not: the
   * shipped matrix declares ZERO `blocked: true` entries, so
   * `businessBlockFor` returned `undefined` in every test that has ever run,
   * and `blockedBy: 'business'`, the business half of the region check, and the
   * §24 Lane A ordering for a commercially-blocked region were all unreachable.
   * Tests over them would have passed against code that did not implement them.
   *
   * Omitted — every production call site — means the shipped matrix.
   */
  readonly business?: readonly BusinessBlock[];
  /**
   * When true, refuse if `region` is the unresolved sentinel (`XX`).
   *
   * Omitted → `regionFailClosedFromEnv()`. Default env is OFF so existing boot
   * invariants (protocol/indexer sovereignty with `region: 'XX'`) keep passing.
   * Pass `true` in tests, or set `INTAFACED_REGION_FAIL_CLOSED`, when a surface
   * must not serve under an unknown jurisdiction.
   */
  readonly regionFailClosed?: boolean;
  /**
   * When true, refuse if the screening list is `unset` (nobody supplied content).
   *
   * Omitted → `screeningFailClosedFromEnv()`. Unset env refuses hosted access.
   * Pass `false`, or set `INTAFACED_SCREENING_FAIL_CLOSED` to an explicit off
   * value (`0`, `false`, `no`, `off`), for the honesty-only path (`allowed`
   * with `listConfigured: false`). Does not invent list content — Class X stays
   * outside this mechanism.
   */
  readonly screeningFailClosed?: boolean;
}

export interface AccessDecision {
  readonly allowed: boolean;
  /** Machine-readable outcome for logs, metrics, and UI copy keys. */
  readonly code:
    | 'allowed'
    | 'allowed.permissionless'
    | 'denied.region_blocked'
    | 'denied.region_unknown'
    | 'denied.screening_unconfigured'
    | 'denied.screening_fixture'
    | 'denied.module_blocked'
    | 'denied.kyc_required'
    | 'denied.plane_unsupported';
  readonly requiredTier?: KycTier;
  readonly status: RuleStatus;
  readonly limitMultiplier: number;
  readonly reason: string;
  /**
   * Whether a real sanctions/region list backed this decision.
   *
   * Present on allowed decisions too, and that is the point: `allowed` alone
   * cannot distinguish "we screened you and you are fine" from "we screened
   * nobody". This field can.
   */
  readonly screening: ScreeningProvenance;
  /**
   * Was the caller's jurisdiction actually resolved?
   *
   * Present on EVERY decision, allowed ones included — same honesty pattern as
   * `screening.listConfigured`. `false` means the platform is operating on the
   * unresolved sentinel (`XX`, typically stamped by svc-edge when no geo
   * resolution exists). That is NOT the same as "region cleared screening",
   * and until this field existed the two were indistinguishable on the wire.
   *
   * Does not invent geo-IP: it only reports whether the code we were given is
   * the sentinel for "never resolved".
   */
  readonly regionResolved: boolean;
  /**
   * WHICH AUTHORITY refused the region, on a `denied.region_blocked`.
   *
   * `'screening'` is a legal control that counsel owns. `'business'` is a
   * commercial or licensing choice that a contributor can change in a PR. They
   * produce the same refusal and they are not the same fact, and an auditor who
   * cannot tell them apart cannot tell whether a refusal that disappeared was a
   * market opening or a sanctions control being tuned away.
   *
   * Absent on every other outcome — including allowed ones, where nothing
   * refused anything.
   */
  readonly blockedBy?: BlockAuthority;
}

/**
 * The effective rule for a module in a region — the per-region override if one
 * exists, otherwise the default.
 *
 * Exported because any surface that wants the *rule* (status + minTier) rather
 * than a yes/no decision would otherwise recompose
 * `entry.modules?.[m] ?? DEFAULT_MODULE_RULES[m]` itself, duplicating this
 * lookup outside the file that owns it. That duplicate is what drifts.
 *
 * Blank and `XX` are not matrix keys. They do not fall through to
 * `DEFAULT_MODULE_RULES` — that open default is what made an unresolved
 * region look like a cleared one. `checkAccess` applies the default only
 * when fail-closed is off, after it has already recorded the region unresolved.
 */
export function ruleFor(module: ModuleId, region: RegionCode): JurisdictionRule {
  const code = canonicalRegion(region);
  if (isUnresolvedRegionCode(code)) return BLOCKED;
  const entry = BY_REGION.get(code);
  return entry?.modules?.[module] ?? DEFAULT_MODULE_RULES[module];
}

/**
 * Is this region blocked outright, whatever the module?
 *
 * Consults the configured screening list as well as the matrix — a caller that
 * only read the matrix would answer `false` for a region the operator blocked
 * by configuration, which is the same silent disagreement `checkAccess` is
 * being fixed to avoid.
 *
 * Note what a `false` here does NOT mean: it does not mean screened-and-clear.
 * Use `screeningStatus()` if you need to know whether anything was screened.
 *
 * `business` is the seam, for the same reason `screening` is one: the shipped
 * matrix has no `blocked: true` entry, so the business half of this OR has
 * never once returned `true` under test.
 */
export function isRegionBlocked(
  region: RegionCode,
  screening: ScreeningList = activeScreeningList(),
  business: readonly BusinessBlock[] = SHIPPED_BUSINESS_BLOCKS,
): boolean {
  if (businessBlockFor(region, business) !== undefined) return true;
  return screenedRegion(screening, region) !== undefined;
}

/**
 * Regions whose matrix entry lacks counsel sign-off.
 *
 * These cannot become launch markets — `assertReviewed` refuses them. Surfacing
 * the list is what lets the admin console show the gap rather than an operator
 * discovering it at launch.
 */
export function unreviewedRegions(): RegionCode[] {
  return JURISDICTION_MATRIX.filter((e) => !e.reviewedBy || !e.reviewedAt).map((e) => e.region);
}

/**
 * The one function every module calls before serving a user.
 *
 * §22: zero-KYC follows custody. If the module cannot take custody on the
 * requested plane, access is permissionless and this returns immediately —
 * we never gate what we do not hold.
 *
 * Region honesty: every decision carries `regionResolved`. The unresolved
 * sentinel (`XX`) is distinguishable from a real code even when the outcome is
 * still `allowed` (fail-closed OFF, the default). Flip
 * `INTAFACED_REGION_FAIL_CLOSED` (or pass `regionFailClosed: true`) to refuse
 * with `denied.region_unknown` instead of falling open on defaults.
 *
 * Screening list honesty: every decision carries `screening.listConfigured`.
 * Unset `INTAFACED_SCREENING_FAIL_CLOSED` refuses with
 * `denied.screening_unconfigured` when the list is `unset`, or
 * `denied.screening_fixture` when the list is a placeholder/test fixture.
 * Pass `screeningFailClosed: false` (or set the env explicitly off) for the
 * honesty-only path. Counsel-grade `reviewed-empty` and `listed` do not refuse
 * here. A blank list is not screened-clean.
 */
export function checkAccess(q: AccessQuery): AccessDecision {
  const mod = MODULES[q.module];
  const screening = q.screening ?? activeScreeningList();
  const provenance = provenanceOf(screening);
  const regionResolved = isRegionResolved(q.region);
  const failClosed = q.regionFailClosed ?? regionFailClosedFromEnv();
  const screeningFailClosed = q.screeningFailClosed ?? screeningFailClosedFromEnv();

  if (!mod.planes.includes(q.plane)) {
    return {
      allowed: false,
      code: 'denied.plane_unsupported',
      status: 'blocked',
      limitMultiplier: 0,
      reason: `${q.module} does not operate on the ${q.plane} plane`,
      screening: provenance,
      regionResolved,
    };
  }

  // Screening-list fail-closed (D26-P1-O1 mechanism seal). Unset env refuses
  // before region/permissionless so a blank list cannot ride as allowed with
  // listConfigured:false. Explicit off keeps that honesty path. Does not invent
  // Class X list content — operators set INTAFACED_SANCTIONS_REGIONS (counsel)
  // or attributed `none`.
  if (screeningFailClosed && provenance.moneyGrade === 'unconfigured') {
    return {
      allowed: false,
      code: SCREENING_REFUSE_UNCONFIGURED,
      status: 'blocked',
      limitMultiplier: 0,
      reason:
        `Sanctions screening list is unset — nothing was consulted. ` +
        `Hosted access refuses under ${SCREENING_FAIL_CLOSED_ENV}. ` +
        `Counsel/Nitro must supply ${SANCTIONS_REGIONS_ENV} (or attributed ` +
        `"${SCREENING_REVIEWED_EMPTY}"); agents must not invent list content.`,
      screening: provenance,
      regionResolved,
    };
  }

  if (screeningFailClosed && provenance.moneyGrade === 'fixture') {
    return {
      allowed: false,
      code: SCREENING_REFUSE_FIXTURE,
      status: 'blocked',
      limitMultiplier: 0,
      reason:
        `Sanctions screening list is a placeholder/test fixture — not counsel. ` +
        `Must not be read as screened clean. Hosted access refuses under ${SCREENING_FAIL_CLOSED_ENV}. ` +
        `Replace fixture provenance with a governance record; agents must not invent country codes.`,
      screening: provenance,
      regionResolved,
    };
  }

  // Unresolved-region fail-closed. Default OFF: protocol boot and every
  // existing call site keep the historical "XX falls through to defaults"
  // behaviour, but the decision now *says* the region was unresolved. When ON,
  // refuse before screening/permissionless so an unknown jurisdiction cannot
  // ride the open defaults. Not Class X content — mechanism only.
  if (!regionResolved && failClosed) {
    return {
      allowed: false,
      code: 'denied.region_unknown',
      status: 'blocked',
      limitMultiplier: 0,
      reason:
        `Caller region is unresolved (${UNRESOLVED_REGION}). ` +
        `Hosted access refuses under ${REGION_FAIL_CLOSED_ENV}. ` +
        `Set a real DEFAULT_REGION or close §13 socket.geo-region-resolution; ` +
        `do not treat ${UNRESOLVED_REGION} as a restrictive jurisdiction — it is not.`,
      screening: provenance,
      regionResolved,
    };
  }

  // Fail-closed already returned above. Fail-open keeps the historical default
  // for an unresolved region so `XX` is not turned into a restrictive rule.
  const rule = regionResolved ? ruleFor(q.module, q.region) : DEFAULT_MODULE_RULES[q.module];

  // A region is refused if the BUSINESS blocks it outright OR the SCREENING list
  // names it. Two authorities, one question — "do we serve this region" — so
  // both are read in the same place; a second `blocked` check somewhere else is
  // how two sources start disagreeing.
  //
  // What the decision keeps separate is WHO refused. Screening wins the
  // attribution when both name the region: the legal control is the more
  // consequential fact, and it is the one that must not look removable by
  // editing the matrix.
  const screened = screenedRegion(screening, q.region);
  const businessBlock = businessBlockFor(q.region, q.business ?? SHIPPED_BUSINESS_BLOCKS);
  const regionBlocked = businessBlock !== undefined || screened !== undefined;
  const blockedBy: BlockAuthority | undefined = screened ? 'screening' : businessBlock ? 'business' : undefined;
  const regionBlockReason = screened?.reason ?? businessBlock?.reason;

  // ── Sovereignty law ──────────────────────────────────────────────────────
  // Protocol plane + non-custodial module = there is nothing to KYC.
  // Region blocks still apply at the hosted front end (sanctions screening,
  // §24 Lane A) but the protocol itself is permissionless infrastructure.
  //
  // ORDER IS LOAD-BEARING: the region check runs BEFORE the permissionless
  // return, so sanctions screening survives a short-circuit that the KYC gate
  // does not. That ordering is what makes "zero-KYC but still sanctions
  // screened" a true statement rather than a slogan. Do not lift the
  // permissionless return above it.
  const permissionless = q.plane === 'protocol' && !mod.custodial;
  if (permissionless) {
    if (regionBlocked) {
      return {
        allowed: false,
        code: 'denied.region_blocked',
        status: 'blocked',
        limitMultiplier: 0,
        reason: regionBlockReason ?? `Hosted access unavailable in ${q.region}`,
        screening: provenance,
        regionResolved,
        blockedBy,
      };
    }
    return {
      allowed: true,
      code: 'allowed.permissionless',
      status: 'open',
      limitMultiplier: rule.limitMultiplier ?? 1,
      reason: 'Non-custodial: no identity requirement (§22)',
      screening: provenance,
      regionResolved,
    };
  }

  // ── Fiat plane / custodial path ──────────────────────────────────────────
  if (regionBlocked) {
    return {
      allowed: false,
      code: 'denied.region_blocked',
      status: 'blocked',
      limitMultiplier: 0,
      reason: regionBlockReason ?? `Not served in ${q.region}`,
      screening: provenance,
      regionResolved,
      blockedBy,
    };
  }

  if (rule.status === 'blocked') {
    return {
      allowed: false,
      code: 'denied.module_blocked',
      status: 'blocked',
      limitMultiplier: 0,
      reason: rule.notes ?? `${q.module} is not offered in ${q.region}`,
      screening: provenance,
      regionResolved,
    };
  }

  if (!tierSatisfies(q.kycTier, rule.minTier)) {
    return {
      allowed: false,
      code: 'denied.kyc_required',
      requiredTier: rule.minTier,
      status: rule.status,
      limitMultiplier: 0,
      reason: `Verification tier "${rule.minTier}" required for ${q.module} in ${q.region}`,
      screening: provenance,
      regionResolved,
    };
  }

  return {
    allowed: true,
    code: 'allowed',
    status: rule.status,
    limitMultiplier: rule.limitMultiplier ?? 1,
    reason: rule.notes ?? 'Permitted',
    screening: provenance,
    regionResolved,
  };
}

export class UnreviewedJurisdictionError extends Error {
  constructor(readonly regions: readonly string[]) {
    super(
      `Launch markets missing counsel review in JURISDICTION_MATRIX: ${regions.join(', ')}. ` +
        `Add reviewedBy + reviewedAt before enabling these markets.`,
    );
    this.name = 'UnreviewedJurisdictionError';
  }
}

/**
 * Called by the DoD gate before a market goes live. A region cannot be a launch
 * market until its matrix entry carries a reviewer and a date.
 */
export function assertReviewed(launchMarkets: readonly RegionCode[]): void {
  const unreviewed = launchMarkets.filter((r) => {
    const entry = BY_REGION.get(r.toUpperCase());
    return !entry?.reviewedBy || !entry?.reviewedAt;
  });
  if (unreviewed.length > 0) throw new UnreviewedJurisdictionError(unreviewed);
}

export function regionsWithEntries(): RegionCode[] {
  return JURISDICTION_MATRIX.map((e) => e.region).filter((r) => r !== '*');
}

// ── The screening control, made visible and made mandatory ──────────────────

export interface ScreeningStatus {
  /** `false` = nothing was screened. Not "clear". Never render this as a tick. */
  readonly configured: boolean;
  /**
   * Which of the three states. Read this, not just `configured` — `configured`
   * is `true` for a real list AND for a recorded "deliberately empty", and those
   * are different things to show an operator.
   */
  readonly declaration: ScreeningDeclaration;
  /** Regions the SCREENING authority refuses. Counsel's list, and only that. */
  readonly blockedRegions: readonly RegionCode[];
  /**
   * Regions the BUSINESS refuses (`blocked: true` in the matrix).
   *
   * Reported separately and never added to `blockedRegions`. A dashboard that
   * summed them would be showing a total that a contributor can move in an
   * ordinary PR while presenting it as sanctions coverage — the same conflation
   * that let a commercial block satisfy the boot guard, moved to the screen.
   */
  readonly businessBlockedRegions: readonly RegionCode[];
  readonly source: string;
  /** Counsel vs fixture vs unset — fixtures must not render as a clean tick. */
  readonly moneyGrade: ScreeningMoneyGrade;
  readonly readsAsScreenedClean: boolean;
  /** One line an operator can read in a log or on a dashboard. */
  readonly summary: string;
}

/**
 * The state of the screening control, for logs, `/ready` payloads, and the
 * admin console.
 *
 * Exists because "how many regions are we blocking" and "are we blocking
 * anything on purpose" are different questions, and the answer to both used to
 * be an indistinguishable zero.
 *
 * `business` is a parameter so the rule can be tested against a matrix that
 * actually has a `blocked: true` entry in it; production callers pass neither.
 */
export function screeningStatus(
  screening: ScreeningList = activeScreeningList(),
  business: readonly BusinessBlock[] = SHIPPED_BUSINESS_BLOCKS,
): ScreeningStatus {
  const blockedRegions = screening.regions.map((r) => r.region);
  const businessBlockedRegions = business.map((b) => b.region);

  // Named separately in the unconfigured summary, because "we block 2 regions"
  // is exactly what somebody reads as "screening is doing something".
  const businessNote =
    businessBlockedRegions.length === 0
      ? ''
      : ` (${businessBlockedRegions.length} region(s) [${businessBlockedRegions.join(', ')}] are blocked by ` +
        `${BUSINESS_BLOCK_SOURCE} for commercial/licensing reasons — that is business configuration, not screening.)`;

  const moneyGrade = screeningMoneyGrade(screening);
  const summary =
    moneyGrade === 'fixture'
      ? `sanctions screening: FIXTURE / TEST LIST — not counsel. Must not be read as screened clean. Source ${screening.source}.` +
        businessNote
      : screening.declaration === 'listed'
        ? `sanctions screening: ${blockedRegions.length} region(s) blocked [${blockedRegions.join(', ')}] from ${screening.source}` +
          businessNote
        : screening.declaration === 'reviewed-empty'
          ? `sanctions screening: REVIEWED, DELIBERATELY EMPTY — 0 regions screened out, on the authority of ` +
            `${screening.source}. This is a recorded decision, not an unset default.` +
            businessNote
          : `sanctions screening: NOT CONFIGURED — 0 regions blocked because no list was consulted. ` +
            `This is not "everywhere is clear"; nothing has been screened. Supply ${SANCTIONS_REGIONS_ENV}.` +
            businessNote;

  return {
    configured: screening.configured,
    declaration: screening.declaration,
    blockedRegions,
    businessBlockedRegions,
    source: screening.source,
    moneyGrade,
    readsAsScreenedClean: moneyGrade === 'counsel',
    summary,
  };
}

export class UnscreenedJurisdictionError extends Error {
  readonly code = SCREENING_REFUSE_UNCONFIGURED;
  constructor(
    readonly appEnv: string,
    readonly businessBlockedRegions: readonly RegionCode[] = [],
  ) {
    super(
      `SANCTIONS SCREENING IS NOT CONFIGURED (§24 Lane A) and APP_ENV=${appEnv} (${SCREENING_REFUSE_UNCONFIGURED}). Refusing to start.\n\n` +
        `The screening MECHANISM works; it has no list to screen against, so every region resolves to ` +
        `allowed and no call site, log line or dashboard can tell that apart from a region that was ` +
        `checked and cleared. Serving traffic in that state means telling users they were screened when ` +
        `they were not.\n\n` +
        (businessBlockedRegions.length === 0
          ? ''
          : `NOTE — ${BUSINESS_BLOCK_SOURCE} does block ${businessBlockedRegions.length} region(s) ` +
            `[${businessBlockedRegions.join(', ')}], and those refusals are live. They do NOT satisfy this ` +
            `guard and they are not meant to: a matrix entry is business configuration edited in ordinary ` +
            `PRs — a licence we lack, a market we have not opened, a placeholder — and letting one vouch ` +
            `for a sanctions list would mean a commercial decision could arm a legal control nobody had ` +
            `supplied. Sanctions content has a different owner and comes in below.\n\n`) +
        `THERE ARE EXACTLY TWO WAYS TO SATISFY THIS, and both are a deliberate, attributable act:\n\n` +
        `  1. Supply the list:\n` +
        `       ${SANCTIONS_REGIONS_ENV}="AA:reason,BB:reason"   (ISO-3166 alpha-2, comma separated)\n` +
        `       ${SANCTIONS_SOURCE_ENV}="<governance record>"\n\n` +
        `  2. Record that it was reviewed and is deliberately empty:\n` +
        `       ${SANCTIONS_REGIONS_ENV}="${SCREENING_REVIEWED_EMPTY}"\n` +
        `       ${SANCTIONS_SOURCE_ENV}="<governance record>"      (REQUIRED for this one)\n\n` +
        `     Option 2 is a real answer, not a bypass — "we looked, and no region is screened out" is a ` +
        `legitimate conclusion and the platform must be able to record it. It demands attribution ` +
        `precisely because it has no content: without a named record it would be indistinguishable from ` +
        `somebody silencing this message.\n\n` +
        `WHAT GOES IN THE LIST IS A COMPLIANCE DECISION, NOT AN ENGINEERING ONE. It needs counsel for ` +
        `the jurisdictions served. Do not guess it: too few entries is a sanctions breach, too many is ` +
        `unlawful discrimination. And do not answer it by adding \`blocked: true\` to the matrix — that ` +
        `is the wrong authority and will not clear this. See packages/config/src/screening.ts.\n\n` +
        `Development and test are deliberately unaffected — APP_ENV=dev boots unconfigured and logs the ` +
        `gap instead.`,
    );
    this.name = 'UnscreenedJurisdictionError';
  }
}

/**
 * Named production environments where an unconfigured blocklist is a boot failure.
 *
 * `staging` is included on purpose: it is a production-like posture that can be
 * reachable by real users, and an environment that lets the empty state through
 * is where the empty state gets normalised before it reaches prod. `dev` and
 * `test` stay frictionless — nobody should need a sanctions list to run a unit
 * test or open the app locally. This list is descriptive, not exhaustive:
 * every raw APP_ENV other than exactly `dev` or `test` is enforced, including
 * absent, blank and unknown names.
 */
export const SCREENING_ENFORCED_ENVS = ['staging', 'prod'] as const;

/**
 * Called at boot by any service that serves the hosted front end.
 *
 * Modelled on svc-protocol's §22 sovereignty assertion: a property the platform
 * claims is checked at startup rather than assumed, and the process refuses to
 * run rather than quietly mislead users about it.
 *
 * SATISFIABLE ONLY BY THE SCREENING AUTHORITY. It gates on the screening list's
 * own `declaration`, and the only thing that can produce a declaration other
 * than `unset` is `parseScreeningList` reading `INTAFACED_SANCTIONS_REGIONS`.
 * The business matrix is not an input to this decision at all — it is read below
 * solely so the refusal message can name blocks that exist and say why they do
 * not count. That is the fix: this used to gate on a merged list, and one
 * `blocked: true` matrix entry cleared it.
 *
 * FAIL CLOSED. `unset` is the only state that throws, and it is also the state
 * every ambiguous input resolves to — an absent variable, a blank one, one
 * holding only commas, and a matrix block whose authority cannot be established.
 * Nothing here treats "we could not tell" as "supplied".
 *
 * Returns the status so the caller can log it — in dev, where this does not
 * throw, the log line IS the control's visibility.
 *
 * `business` IS AN INJECTION SEAM AND IT IS NOT DECORATION. The claim this
 * function makes — "a commercial block cannot satisfy a sanctions guard" — is
 * a claim about what happens WHEN A COMMERCIAL BLOCK EXISTS, and the shipped
 * matrix declares none. Without a way to stage one, a test named "a business
 * block leaves the prod boot guard refusing" calls this with zero business
 * blocks: it asserts that an empty matrix does not satisfy the guard, which is
 * true of the buggy code too. It passes either way, and a compliance test that
 * cannot fail is worth less than no test, because it is read as evidence.
 *
 * Production callers pass one argument. The second exists so the blocked case
 * is reachable at the guard, and so re-merging the two authorities makes a test
 * go red instead of going unnoticed.
 */
export function assertScreeningConfigured(
  env: Record<string, string | undefined> = process.env,
  business: readonly BusinessBlock[] = SHIPPED_BUSINESS_BLOCKS,
): ScreeningStatus {
  const list = activeScreeningList(env);
  const status = screeningStatus(list, business);
  const appEnv = env.APP_ENV ?? 'unset';
  const enforced = !isExplicitDevOrTest(env.APP_ENV);
  if (enforced && list.declaration === 'unset') {
    throw new UnscreenedJurisdictionError(appEnv, status.businessBlockedRegions);
  }
  // The money-posture evaluator names prod/staging. Every non-local raw
  // environment must use that strict posture; preserve its original name in
  // the error below so an unset or misspelled APP_ENV remains visible.
  const posture = evaluateScreeningMoneyPosture(list, enforced ? 'prod' : appEnv);
  if (!posture.allowed) {
    throw new ScreeningMoneyPostureError(appEnv, posture.code, posture.grade);
  }
  return status;
}
