/**
 * The support staff roster and availability, as the console reads and sets it.
 *
 * svc-support keeps who is staff, their role and their availability (online, busy or offline). The roster here is exactly
 * what `staffList` returns. Automatic offline (a heartbeat window) is an owner value: when it is blank the console says so
 * and shows no "last seen" claim as a status. A person's availability is theirs to set; a lead can set anyone's.
 */

export const AVAILABILITIES = ['online', 'busy', 'offline'] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export interface StaffMemberView {
  readonly userId: string;
  readonly role: 'agent' | 'lead';
  readonly appointedBy: string;
  readonly appointedAt: string;
  readonly availability: Availability;
  readonly availabilitySetAt: string | null;
  readonly lastHeartbeatAt: string | null;
}

export interface StaffPolicyView {
  readonly automaticOffline: 'set' | 'not_set';
  readonly heartbeatWindowSeconds: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullableTime = (v: unknown): v is string | null => v === null || isTime(v);

/** One roster row, or null. A row that is not exactly this shape is never guessed at. */
export function readStaffMember(raw: unknown): StaffMemberView | null {
  if (!isRecord(raw)) return null;
  const { userId, role, appointedBy, appointedAt, availability, availabilitySetAt, lastHeartbeatAt } = raw;
  if (!isText(userId) || !isText(appointedBy) || !isTime(appointedAt)) return null;
  if (role !== 'agent' && role !== 'lead') return null;
  if (typeof availability !== 'string' || !AVAILABILITIES.includes(availability as Availability)) return null;
  if (!nullableTime(availabilitySetAt) || !nullableTime(lastHeartbeatAt)) return null;
  return { userId, role, appointedBy, appointedAt, availability: availability as Availability, availabilitySetAt, lastHeartbeatAt };
}

/** `staffList`: every row must read, or the whole answer is null (never a shorter roster). */
export function readStaffRoster(raw: unknown): StaffMemberView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StaffMemberView[] = [];
  for (const row of raw) {
    const member = readStaffMember(row);
    if (!member) return null;
    out.push(member);
  }
  return out;
}

export function readStaffPolicy(raw: unknown): StaffPolicyView | null {
  if (!isRecord(raw)) return null;
  const { automaticOffline, heartbeatWindowSeconds } = raw;
  if (automaticOffline !== 'set' && automaticOffline !== 'not_set') return null;
  if (
    heartbeatWindowSeconds !== null &&
    !(typeof heartbeatWindowSeconds === 'number' && Number.isInteger(heartbeatWindowSeconds) && heartbeatWindowSeconds > 0)
  )
    return null;
  if ((automaticOffline === 'set') !== (heartbeatWindowSeconds !== null)) return null;
  return { automaticOffline, heartbeatWindowSeconds };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REASON_MAX = 500;

export interface StaffAvailabilityRequest {
  readonly action: 'staff_availability';
  /** Whose availability. Absent means the signed-in person's own. */
  readonly userId?: string;
  readonly availability: Availability;
  readonly reason?: string;
}

/** Strict reader for the browser's request. Anything that is not exactly this shape is null and nothing is sent. */
export function readStaffAvailabilityRequest(raw: Record<string, unknown>): StaffAvailabilityRequest | null {
  if (typeof raw.availability !== 'string' || !AVAILABILITIES.includes(raw.availability as Availability)) return null;
  if (raw.userId !== undefined && !(typeof raw.userId === 'string' && UUID.test(raw.userId))) return null;
  if (raw.reason !== undefined && !(typeof raw.reason === 'string' && raw.reason.trim() !== '' && raw.reason.length <= REASON_MAX))
    return null;
  return {
    action: 'staff_availability',
    availability: raw.availability as Availability,
    ...(raw.userId === undefined ? {} : { userId: raw.userId as string }),
    ...(raw.reason === undefined ? {} : { reason: (raw.reason as string).trim() }),
  };
}

export type StaffGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Whether this person may set this member's availability from here. svc-support stays the judge; this says why a control is
 * off before the click. Setting the value someone already has changes nothing.
 */
export function availabilityGate(
  me: StaffMemberView | null,
  target: StaffMemberView,
  next: Availability,
  reason: string,
  busy: boolean,
): StaffGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (!me) return { ok: false, why: 'You are not on the support staff list, so you cannot set availability.' };
  if (target.userId !== me.userId && me.role !== 'lead') return { ok: false, why: 'Only a lead can set someone else’s availability.' };
  if (target.availability === next) return { ok: false, why: `Already ${next}.` };
  if (reason.length > REASON_MAX) return { ok: false, why: `The reason can be at most ${REASON_MAX} characters.` };
  return { ok: true };
}

/** "Last seen" is shown only as a time. It becomes a status (offline) only through the owner's window, which svc-support applies. */
export function heartbeatNote(policy: StaffPolicyView): string {
  return policy.automaticOffline === 'set' && policy.heartbeatWindowSeconds !== null
    ? `Someone with no sign of life for ${policy.heartbeatWindowSeconds} seconds is shown offline by svc-support.`
    : 'Automatic offline is not set: the owner has not chosen a window, so nobody is moved to offline for being quiet. People set their own status.';
}
