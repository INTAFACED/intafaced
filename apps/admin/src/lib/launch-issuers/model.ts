/**
 * The launch issuer lens (J-more-catalogue-14): svc-token's `launch.*` shapes as this console reads and sends them. Pure: no
 * service call here. svc-token is the authority for every rule; this file only refuses what it can never accept.
 */

/** svc-token's launch and issuer ids. */
export const LAUNCH_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const LAUNCH_ISSUER_STATES = ['applied', 'reviewing', 'onboarded', 'suspended'] as const;
export type LaunchIssuerState = (typeof LAUNCH_ISSUER_STATES)[number];
export const LAUNCH_STATUSES = [
  'draft',
  'announced',
  'snapshot',
  'open',
  'closed',
  'allocated',
  'distributing',
  'complete',
  'cancelled',
] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];
/** The statuses an operator can move a launch to from this console. Past closed needs a ledger recipe that is not wired. */
export const LAUNCH_MOVE_TARGETS = ['announced', 'snapshot', 'open', 'closed', 'cancelled'] as const;
export type LaunchMoveTarget = (typeof LAUNCH_MOVE_TARGETS)[number];
export const LAUNCH_TYPES = ['token_sale', 'whitelist_drop', 'primary_subscription'] as const;
export type LaunchType = (typeof LAUNCH_TYPES)[number];
export const ALLOCATION_METHODS = ['pro_rata', 'tickets', 'tiered'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
/** svc-token's issuance kinds (RC-more-catalogue-23). Each but `token` needs its own detail. */
export const ISSUANCE_KINDS = ['token', 'wrapped', 'synthetic', 'structured'] as const;
export type IssuanceKind = (typeof ISSUANCE_KINDS)[number];
export const ISSUANCE_KIND_LABEL: Readonly<Record<IssuanceKind, string>> = {
  token: 'Token',
  wrapped: 'Wrapped',
  synthetic: 'Synthetic',
  structured: 'Structured',
};
/** What each kind needs, as svc-token names the refusal when it is blank. */
const ISSUANCE_DETAIL = { wrapped: 'backing asset', synthetic: 'oracle', structured: 'leg terms' } as const;
export interface Issuance {
  kind: IssuanceKind;
  backingAsset: string | null;
  oracle: string | null;
  legTerms: string | null;
  flags: string[];
}
const FLAG = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

/** Issuer review, as svc-token allows it: one step at a time, and a suspended issuer goes back through review. */
export const ISSUER_NEXT: Record<LaunchIssuerState, readonly LaunchIssuerState[]> = {
  applied: ['reviewing'],
  reviewing: ['onboarded', 'applied'],
  onboarded: ['suspended'],
  suspended: ['reviewing'],
};

/** A decimal as svc-token stores and prints it: no sign, no leading or trailing zeros. */
const CANONICAL_AMOUNT = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/;
const SYMBOL = /^[A-Z0-9]{2,12}$/;
const ASSET = /^[A-Z0-9]{2,12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** svc-token's canonical launch payload (`launchEventPayload`), in its key order. */
export interface LaunchEventPayload {
  id: string;
  issuerId: string;
  type: LaunchType;
  projectName: string;
  symbol: string;
  periods: [string, string, string, string, string];
  method: AllocationMethod | null;
  perUserCap: string | null;
  ticketSize: string | null;
  tierWeights: null;
  price: string | null;
  paymentAsset: string | null;
  rateSource: string | null;
  /** Present only when the founders record an issuance kind: [kind, backing asset, oracle, leg terms, flags]. */
  issuance?: [IssuanceKind, string | null, string | null, string | null, string[]];
}

const PAYLOAD_KEYS = 'id,issuerId,type,projectName,symbol,periods,method,perUserCap,ticketSize,tierWeights,price,paymentAsset,rateSource';
const PAYLOAD_KEYS_ISSUANCE = `${PAYLOAD_KEYS},issuance`;

const detailOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= 300);

/** The issuance tuple read back strictly, as svc-token's `canonicalIssuance` would store it. */
function issuanceTupleHolds(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== 5) return false;
  const [kind, backing, oracle, legs, flags] = v as unknown[];
  if (typeof kind !== 'string' || !(ISSUANCE_KINDS as readonly string[]).includes(kind)) return false;
  if (!detailOrNull(backing) || !detailOrNull(oracle) || !detailOrNull(legs)) return false;
  const given = { wrapped: backing, synthetic: oracle, structured: legs } as const;
  for (const [k, value] of Object.entries(given)) if ((k === kind) !== (value !== null)) return false;
  return (
    Array.isArray(flags) &&
    flags.length <= 8 &&
    flags.every((f) => typeof f === 'string' && FLAG.test(f)) &&
    new Set(flags).size === flags.length
  );
}

const amountOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && CANONICAL_AMOUNT.test(v));

/** The payload text read back strictly, or null. Keys and their order are part of what the founders sign. */
export function readLaunchEventPayload(text: string): LaunchEventPayload | null {
  if (text.length > 4_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).join(',');
  if (keys !== PAYLOAD_KEYS && keys !== PAYLOAD_KEYS_ISSUANCE) return null;
  if (keys === PAYLOAD_KEYS_ISSUANCE && !issuanceTupleHolds(r.issuance)) return null;
  if (typeof r.id !== 'string' || !LAUNCH_ID.test(r.id) || typeof r.issuerId !== 'string' || !LAUNCH_ID.test(r.issuerId)) return null;
  if (typeof r.type !== 'string' || !(LAUNCH_TYPES as readonly string[]).includes(r.type)) return null;
  if (typeof r.projectName !== 'string' || r.projectName !== r.projectName.trim() || r.projectName.length < 1 || r.projectName.length > 120)
    return null;
  if (typeof r.symbol !== 'string' || !SYMBOL.test(r.symbol)) return null;
  if (!Array.isArray(r.periods) || r.periods.length !== 5 || !r.periods.every((p) => typeof p === 'string' && ISO.test(p))) return null;
  if (r.method !== null && !(typeof r.method === 'string' && (ALLOCATION_METHODS as readonly string[]).includes(r.method))) return null;
  if (!amountOrNull(r.perUserCap) || !amountOrNull(r.ticketSize) || !amountOrNull(r.price) || r.tierWeights !== null) return null;
  if (r.paymentAsset !== null && !(typeof r.paymentAsset === 'string' && ASSET.test(r.paymentAsset))) return null;
  if (
    r.rateSource !== null &&
    !(typeof r.rateSource === 'string' && r.rateSource === r.rateSource.trim() && r.rateSource.length >= 1 && r.rateSource.length <= 120)
  )
    return null;
  if (!draftRulesHold(r as unknown as LaunchEventPayload)) return null;
  if (JSON.stringify(r) !== text) return null;
  return r as unknown as LaunchEventPayload;
}

const isZero = (v: string | null) => v !== null && /^0(?:\.0*)?$/.test(v);

/** svc-token's cross-field rules for a launch, so a draft it would refuse never reaches the founders. Null when they hold. */
function draftRuleBroken(p: LaunchEventPayload): string | null {
  const [announce, snapshot, open, close, distribution] = p.periods.map((t) => Date.parse(t)) as [number, number, number, number, number];
  if (!(announce <= snapshot && snapshot <= open && open < close && close <= distribution))
    return 'The periods must run announce, snapshot, open, close, distribution in that order, and close after open.';
  if (isZero(p.perUserCap) || isZero(p.ticketSize) || isZero(p.price))
    return 'A cap, ticket size or price is more than zero, or left blank.';
  if ((p.price === null) !== (p.paymentAsset === null)) return 'A price needs the currency it is paid in, and a currency needs a price.';
  if (p.rateSource !== null && p.price === null) return 'A rate source needs a price.';
  return null;
}

function draftRulesHold(p: LaunchEventPayload): boolean {
  return draftRuleBroken(p) === null;
}

/** The new-launch form as typed. Times are the operator's `datetime-local` values read as UTC; a blank amount is unset. */
export interface LaunchDraftForm {
  id: string;
  issuerId: string;
  type: string;
  projectName: string;
  symbol: string;
  periods: [string, string, string, string, string];
  method: string;
  perUserCap: string;
  ticketSize: string;
  price: string;
  paymentAsset: string;
  rateSource: string;
  /** Blank: no issuance kind recorded. */
  issuanceKind?: string;
  backingAsset?: string;
  oracle?: string;
  legTerms?: string;
  /** Compliance flags, comma separated: labels, never limits. */
  flags?: string;
}

export const PERIOD_NAMES = ['Announce', 'Snapshot', 'Open', 'Close', 'Distribution'] as const;

/** The payload for a typed form, or the first thing wrong with it in plain words. svc-token checks the rest again. */
export function draftPayload(form: LaunchDraftForm): { ok: true; event: string } | { ok: false; message: string } {
  const blank = (v: string) => (v.trim() === '' ? null : v.trim());
  if (!LAUNCH_ID.test(form.id.trim())) return { ok: false, message: 'Launch id: 3 to 63 lowercase letters, digits or dashes.' };
  if (!LAUNCH_ID.test(form.issuerId.trim())) return { ok: false, message: 'Choose the issuer.' };
  if (!(LAUNCH_TYPES as readonly string[]).includes(form.type)) return { ok: false, message: 'Choose the launch type.' };
  const projectName = form.projectName.trim();
  if (projectName.length < 1 || projectName.length > 120) return { ok: false, message: 'Project name: 1 to 120 characters.' };
  const symbol = form.symbol.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) return { ok: false, message: 'Symbol: 2 to 12 capital letters or digits.' };
  const periods: string[] = [];
  for (const [i, value] of form.periods.entries()) {
    const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.trim()) ? new Date(`${value.trim()}:00.000Z`) : null;
    if (!when || Number.isNaN(when.getTime())) return { ok: false, message: `${PERIOD_NAMES[i]}: choose a date and time (UTC).` };
    periods.push(when.toISOString());
  }
  const method = blank(form.method);
  if (method !== null && !(ALLOCATION_METHODS as readonly string[]).includes(method))
    return { ok: false, message: 'Choose the allocation method.' };
  for (const [label, v] of [
    ['Cap per account', form.perUserCap],
    ['Ticket size', form.ticketSize],
    ['Price', form.price],
  ] as const) {
    const b = blank(v);
    if (b !== null && !CANONICAL_AMOUNT.test(b))
      return { ok: false, message: `${label}: a plain decimal such as 250 or 0.5, with no extra zeros.` };
  }
  const paymentAsset = blank(form.paymentAsset)?.toUpperCase() ?? null;
  if (paymentAsset !== null && !ASSET.test(paymentAsset)) return { ok: false, message: 'Currency: 2 to 12 capital letters or digits.' };
  const rateSource = blank(form.rateSource);
  if (rateSource !== null && rateSource.length > 120) return { ok: false, message: 'Rate source: at most 120 characters.' };
  const kind = blank(form.issuanceKind ?? '');
  let issuance: LaunchEventPayload['issuance'];
  if (kind !== null) {
    if (!(ISSUANCE_KINDS as readonly string[]).includes(kind)) return { ok: false, message: 'Choose the issuance kind.' };
    const detail = { wrapped: blank(form.backingAsset ?? ''), synthetic: blank(form.oracle ?? ''), structured: blank(form.legTerms ?? '') };
    if (kind !== 'token' && detail[kind as keyof typeof detail] === null)
      return { ok: false, message: `A ${kind} issuance needs its ${ISSUANCE_DETAIL[kind as keyof typeof ISSUANCE_DETAIL]}.` };
    for (const v of Object.values(detail))
      if (v !== null && v.length > 300) return { ok: false, message: 'Issuance details: at most 300 characters each.' };
    const flags = (form.flags ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    if (flags.length > 8 || flags.some((f) => !FLAG.test(f)) || new Set(flags).size !== flags.length)
      return { ok: false, message: 'Compliance flags: up to 8 distinct labels of 1 to 40 letters, digits, spaces or dashes.' };
    issuance = [
      kind as IssuanceKind,
      kind === 'wrapped' ? detail.wrapped : null,
      kind === 'synthetic' ? detail.synthetic : null,
      kind === 'structured' ? detail.structured : null,
      flags,
    ];
  }
  const payload: LaunchEventPayload = {
    id: form.id.trim(),
    issuerId: form.issuerId.trim(),
    type: form.type as LaunchType,
    projectName,
    symbol,
    periods: periods as LaunchEventPayload['periods'],
    method: method as AllocationMethod | null,
    perUserCap: blank(form.perUserCap),
    ticketSize: blank(form.ticketSize),
    tierWeights: null,
    price: blank(form.price),
    paymentAsset,
    rateSource,
    ...(issuance ? { issuance } : {}),
  };
  const broken = draftRuleBroken(payload);
  if (broken) return { ok: false, message: broken };
  return { ok: true, event: JSON.stringify(payload) };
}

/** svc-token `launch.events.create` input for an approved payload. */
export function createInputFor(payload: LaunchEventPayload) {
  const [announceAt, snapshotAt, openAt, closeAt, distributionAt] = payload.periods;
  return {
    id: payload.id,
    issuerId: payload.issuerId,
    type: payload.type,
    projectName: payload.projectName,
    symbol: payload.symbol,
    periods: { announceAt, snapshotAt, openAt, closeAt, distributionAt },
    allocation: { method: payload.method, perUserCap: payload.perUserCap, ticketSize: payload.ticketSize, tierWeights: null },
    terms: { price: payload.price, paymentAsset: payload.paymentAsset, rateSource: payload.rateSource },
    ...(payload.issuance
      ? {
          issuance: {
            kind: payload.issuance[0],
            backingAsset: payload.issuance[1],
            oracle: payload.issuance[2],
            legTerms: payload.issuance[3],
            flags: payload.issuance[4],
          },
        }
      : {}),
  };
}

export interface LaunchIssuer {
  id: string;
  name: string;
  state: LaunchIssuerState;
  revision: number;
}

export interface LaunchEventRow {
  id: string;
  issuer: { id: string; name: string; state: LaunchIssuerState };
  type: LaunchType;
  projectName: string;
  symbol: string;
  periods: { announceAt: string; snapshotAt: string; openAt: string; closeAt: string; distributionAt: string };
  status: LaunchStatus;
  allocation: { method: AllocationMethod | null; perUserCap: string | null };
  terms: { price: string | null; paymentAsset: string | null };
  /** Null when no issuance kind is recorded. */
  issuance: Issuance | null;
  revision: number;
}

export interface LaunchMove {
  ordinal: number;
  from: string | null;
  to: string;
  actorId: string;
  approverId: string;
  cause: string | null;
  at: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const int = (v: unknown): v is number => Number.isInteger(v);

export function readIssuers(raw: unknown): LaunchIssuer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LaunchIssuer[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !str(r.id) || !str(r.name) || !int(r.revision)) return null;
    if (!str(r.state) || !(LAUNCH_ISSUER_STATES as readonly string[]).includes(r.state)) return null;
    out.push({ id: r.id, name: r.name, state: r.state as LaunchIssuerState, revision: r.revision });
  }
  return out;
}

export function readIssuer(raw: unknown): LaunchIssuer | null {
  return readIssuers([raw])?.[0] ?? null;
}

export function readEventRow(r: unknown): LaunchEventRow | null {
  if (!isRecord(r) || !str(r.id) || !str(r.projectName) || !str(r.symbol) || !int(r.revision)) return null;
  if (!str(r.status) || !(LAUNCH_STATUSES as readonly string[]).includes(r.status)) return null;
  if (!str(r.type) || !(LAUNCH_TYPES as readonly string[]).includes(r.type)) return null;
  const i = r.issuer;
  if (!isRecord(i) || !str(i.id) || !str(i.name) || !str(i.state) || !(LAUNCH_ISSUER_STATES as readonly string[]).includes(i.state))
    return null;
  const p = r.periods;
  if (!isRecord(p) || ![p.announceAt, p.snapshotAt, p.openAt, p.closeAt, p.distributionAt].every(str)) return null;
  const a = r.allocation;
  const t = r.terms;
  if (!isRecord(a) || !strOrNull(a.method) || !strOrNull(a.perUserCap) || !isRecord(t) || !strOrNull(t.price) || !strOrNull(t.paymentAsset))
    return null;
  const iss = r.issuance ?? null;
  if (
    iss !== null &&
    !(
      isRecord(iss) &&
      str(iss.kind) &&
      (ISSUANCE_KINDS as readonly string[]).includes(iss.kind) &&
      strOrNull(iss.backingAsset) &&
      strOrNull(iss.oracle) &&
      strOrNull(iss.legTerms) &&
      Array.isArray(iss.flags) &&
      iss.flags.every(str)
    )
  )
    return null;
  return {
    id: r.id,
    issuer: { id: i.id, name: i.name, state: i.state as LaunchIssuerState },
    type: r.type as LaunchType,
    projectName: r.projectName,
    symbol: r.symbol,
    periods: p as LaunchEventRow['periods'],
    status: r.status as LaunchStatus,
    allocation: { method: a.method as AllocationMethod | null, perUserCap: a.perUserCap },
    terms: { price: t.price, paymentAsset: t.paymentAsset },
    issuance:
      iss === null
        ? null
        : {
            kind: iss.kind as IssuanceKind,
            backingAsset: iss.backingAsset as string | null,
            oracle: iss.oracle as string | null,
            legTerms: iss.legTerms as string | null,
            flags: iss.flags as string[],
          },
    revision: r.revision,
  };
}

export function readEvents(raw: unknown): LaunchEventRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LaunchEventRow[] = [];
  for (const r of raw) {
    const row = readEventRow(r);
    if (!row) return null;
    out.push(row);
  }
  return out;
}

/** The trails of several issuers or launches, keyed by id, as svc-token `launch.admin.moves` answers. */
export function readTrails(raw: unknown): Record<string, LaunchMove[]> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, LaunchMove[]> = {};
  for (const [id, moves] of Object.entries(raw)) {
    const read = readMoves(moves);
    if (!read) return null;
    out[id] = read;
  }
  return out;
}

export function readMoves(raw: unknown): LaunchMove[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LaunchMove[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !int(r.ordinal) || !strOrNull(r.from) || !str(r.to) || !str(r.actorId) || !str(r.approverId)) return null;
    if (!strOrNull(r.cause) || !str(r.at)) return null;
    out.push({ ordinal: r.ordinal, from: r.from, to: r.to, actorId: r.actorId, approverId: r.approverId, cause: r.cause, at: r.at });
  }
  return out;
}
