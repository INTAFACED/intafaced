/**
 * The support contact channels as svc-support returns them (`contactChannels`), and the form's pure rules. Hand-written strict
 * readers: a shape that is not exactly this makes the whole read invalid, so the desk never prints a guess.
 */

export const CONTACT_SETTINGS = ['email', 'phone', 'chatHours'] as const;
export type ContactSetting = (typeof CONTACT_SETTINGS)[number];

export const CONTACT_LABEL: Readonly<Record<ContactSetting, string>> = {
  email: 'Support email',
  phone: 'Support phone',
  chatHours: 'Chat hours',
};

export const CONTACT_HINT: Readonly<Record<ContactSetting, string>> = {
  email: 'One address, for example help@your-domain. It becomes the mail link on the help centre and the contact page.',
  phone: 'A number to dial, with digits and the usual separators. An extension is not part of it.',
  chatHours: 'Words a visitor reads, for example "Mon to Fri, 09:00 to 17:00 UTC".',
};

export const REASON_MAX = 500;

export interface ContactChannels {
  readonly email: string | null;
  readonly phone: string | null;
  readonly chatHours: string | null;
  readonly revision: number;
  readonly updatedAt: string | null;
}

export type ContactDrafts = Readonly<Record<ContactSetting, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const channel = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0);

export function readContactChannels(raw: unknown): ContactChannels | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'chatHours,email,phone,revision,updatedAt') return null;
  const { email, phone, chatHours, revision, updatedAt } = raw;
  if (!channel(email) || !channel(phone) || !channel(chatHours)) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  if (!(updatedAt === null || (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))))) return null;
  return { email, phone, chatHours, revision, updatedAt };
}

/** The form starts from what is stored; a channel that is not set starts empty. */
export function draftsFrom(current: ContactChannels): ContactDrafts {
  return { email: current.email ?? '', phone: current.phone ?? '', chatHours: current.chatHours ?? '' };
}

export type ContactChanges = Partial<Record<ContactSetting, string | null>>;

/**
 * What the form changes: a field left alone is left out, a field emptied that was set is cleared (`null`), and a field that
 * differs is set. `null` when nothing differs, so a save with no change is never sent.
 */
export function contactChanges(current: ContactChannels, drafts: ContactDrafts): ContactChanges | null {
  const out: ContactChanges = {};
  for (const setting of CONTACT_SETTINGS) {
    const draft = drafts[setting].trim();
    const stored = current[setting];
    if (draft === '') {
      if (stored !== null) out[setting] = null;
    } else if (draft !== stored) {
      out[setting] = draft;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

export type ContactGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export function contactGate(current: ContactChannels, drafts: ContactDrafts, reason: string, busy: boolean): ContactGate {
  if (busy) return { ok: false, why: 'Sending.' };
  if (contactChanges(current, drafts) === null) return { ok: false, why: 'Nothing has changed.' };
  const text = reason.trim();
  if (text === '') return { ok: false, why: 'Say why you are changing it.' };
  if (text.length > REASON_MAX) return { ok: false, why: `Keep the reason to ${REASON_MAX} characters.` };
  return { ok: true };
}

/** The request the BFF takes from the page. The revision is the one the page read. */
export interface ContactSetRequest {
  readonly changes: ContactChanges;
  readonly expectedRevision: number;
  readonly reason: string;
}

export function readContactSetRequest(raw: Record<string, unknown>): ContactSetRequest | null {
  const { changes, expectedRevision, reason } = raw;
  if (!isRecord(changes) || typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)
    return null;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > REASON_MAX) return null;
  const out: ContactChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!(CONTACT_SETTINGS as readonly string[]).includes(key)) return null;
    if (!(value === null || typeof value === 'string')) return null;
    out[key as ContactSetting] = value;
  }
  return Object.keys(out).length === 0 ? null : { changes: out, expectedRevision, reason: reason.trim() };
}
