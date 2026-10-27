/**
 * VIP applications room (SP-fees-vip-04, J-cex-spot-10 #7): the shapes svc-trade's `admin.vipApplications.*` answers and
 * the checks the room makes before it sends anything. Plain data, safe in server and browser code. The hashes the
 * approvals are bound to live in vip-review-hash.ts (server only).
 */

export type VipStatus = 'pending' | 'approved' | 'approved_no_trial' | 'rejected';
export type VipDecision = 'approve' | 'reject';

export const VIP_STATUSES: readonly VipStatus[] = ['pending', 'approved', 'approved_no_trial', 'rejected'];

/** How many applications one read of the room asks svc-trade for (newest first). */
export const VIP_LIST_SHOWN = 200;

/** The trial the owner publishes in the fee schedule (`tierProgram.trial`), or none. */
export interface VipTrialRules {
  readonly tierId: string;
  readonly days: number;
}

export interface VipTrial {
  readonly key: string;
  readonly tierId: string;
  readonly days: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly grantedBy: string;
}

export interface VipEvent {
  readonly status: VipStatus;
  readonly actorId: string;
  readonly actorRole: 'applicant' | 'compliance';
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly at: string;
}

export interface VipApplication {
  readonly id: string;
  readonly userId: string;
  readonly status: VipStatus;
  readonly proof: { readonly fileName: string; readonly contentType: string; readonly byteLength: number; readonly sha256: string };
  readonly note: string | null;
  readonly createdAt: string;
  readonly events: readonly VipEvent[];
  readonly trial: VipTrial | null;
}

export interface VipList {
  readonly applications: readonly VipApplication[];
  readonly trialRules: VipTrialRules | null;
  readonly proofKeyed: boolean;
}

export interface VipReviewResult {
  readonly application: VipApplication;
  readonly trialRefusal: 'vip.trial_unset' | null;
}

export interface VipProofFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly bytesBase64: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isStatus = (v: unknown): v is VipStatus => VIP_STATUSES.includes(v as VipStatus);

function parseTrialRules(v: unknown): VipTrialRules | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !str(v.tierId) || typeof v.days !== 'number' || !Number.isInteger(v.days)) return undefined;
  return { tierId: v.tierId, days: v.days };
}

function parseTrial(v: unknown): VipTrial | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !str(v.key) || !str(v.tierId) || typeof v.days !== 'number' || !str(v.startsAt) || !str(v.endsAt) || !str(v.grantedBy))
    return undefined;
  return { key: v.key, tierId: v.tierId, days: v.days, startsAt: v.startsAt, endsAt: v.endsAt, grantedBy: v.grantedBy };
}

function parseEvent(v: unknown): VipEvent | undefined {
  if (!isObj(v) || !isStatus(v.status) || !str(v.actorId) || (v.actorRole !== 'applicant' && v.actorRole !== 'compliance'))
    return undefined;
  if (!strOrNull(v.approverId) || !strOrNull(v.reason) || !str(v.at)) return undefined;
  return { status: v.status, actorId: v.actorId, actorRole: v.actorRole, approverId: v.approverId, reason: v.reason, at: v.at };
}

export function parseVipApplication(v: unknown): VipApplication | null {
  if (!isObj(v) || !str(v.id) || !str(v.userId) || !isStatus(v.status) || !strOrNull(v.note) || !str(v.createdAt)) return null;
  const p = v.proof;
  if (!isObj(p) || !str(p.fileName) || !str(p.contentType) || typeof p.byteLength !== 'number' || !str(p.sha256)) return null;
  if (!Array.isArray(v.events)) return null;
  const events = v.events.map(parseEvent);
  if (events.some((e) => e === undefined)) return null;
  const trial = parseTrial(v.trial);
  if (trial === undefined) return null;
  return {
    id: v.id,
    userId: v.userId,
    status: v.status,
    proof: { fileName: p.fileName, contentType: p.contentType, byteLength: p.byteLength, sha256: p.sha256 },
    note: v.note,
    createdAt: v.createdAt,
    events: events as VipEvent[],
    trial,
  };
}

export function parseVipList(raw: unknown): VipList | null {
  if (!isObj(raw) || !Array.isArray(raw.applications) || typeof raw.proofKeyed !== 'boolean') return null;
  const trialRules = parseTrialRules(raw.trialRules);
  if (trialRules === undefined) return null;
  const applications = raw.applications.map(parseVipApplication);
  if (applications.some((a) => a === null)) return null;
  return { applications: applications as VipApplication[], trialRules, proofKeyed: raw.proofKeyed };
}

export function parseVipReviewResult(raw: unknown): VipReviewResult | null {
  if (!isObj(raw)) return null;
  const application = parseVipApplication(raw.application);
  if (!application || (raw.trialRefusal !== null && raw.trialRefusal !== 'vip.trial_unset')) return null;
  return { application, trialRefusal: raw.trialRefusal };
}

export function parseVipProof(raw: unknown): VipProofFile | null {
  if (!isObj(raw) || !str(raw.fileName) || !str(raw.contentType) || !str(raw.sha256) || !str(raw.bytesBase64)) return null;
  return { fileName: raw.fileName, contentType: raw.contentType, sha256: raw.sha256, bytesBase64: raw.bytesBase64 };
}

/** The reason every decision and proof opening carries into the audit and the approval: 12 to 500 characters. */
export function checkReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  return reason.length >= 12 && reason.length <= 500
    ? { ok: true, reason }
    : { ok: false, message: 'Write a reason of 12 to 500 characters: it goes into the audit and the approval.' };
}

/** What each status means, in words. */
export const VIP_STATUS_TEXT: Record<VipStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  approved_no_trial: 'Approved, no trial period set',
  rejected: 'Not approved',
};

/** What an approval would grant now, in words: the trial the owner publishes, or why none. */
export function trialText(rules: VipTrialRules | null): string {
  return rules
    ? `${rules.tierId} for ${rules.days} day${rules.days === 1 ? '' : 's'}`
    : 'No trial: the owner has not published one (tier and days), so an approval grants none and says vip.trial_unset.';
}
