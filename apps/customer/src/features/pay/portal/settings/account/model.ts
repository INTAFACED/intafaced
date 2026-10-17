import type { Member, MemberRole } from '../../schemas';
import type { Address, BusinessProfile, ProfileFields, SensitiveKey } from './schemas';
import { SENSITIVE_KEYS } from './schemas';

// ---- team ---------------------------------------------------------------------------------------------------

const ROLE_RANK: Record<MemberRole, number> = { owner: 0, admin: 1, finance: 2, developer: 3, viewer: 4 };

/** What a person is called in a list: the label the team gave them, else a plain word. A raw user id is never the label. */
export const memberName = (member: Pick<Member, 'label'>, fallback: string): string => member.label?.trim() || fallback;

/**
 * The owner first, always; everyone else by role (admin down to viewer), then by name. The order is the same on
 * every visit, so a row does not jump when a page is added.
 */
export function pinOwner(members: readonly Member[], fallbackName: string): Member[] {
  const owners = members.filter((m) => m.role === 'owner');
  const others = members
    .filter((m) => m.role !== 'owner')
    .sort(
      (a, b) =>
        ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
        memberName(a, fallbackName).localeCompare(memberName(b, fallbackName)) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  return [...owners, ...others];
}

export const memberKey = (m: Pick<Member, 'memberId' | 'userId'>) => m.memberId ?? `owner:${m.userId}`;

// ---- network ----------------------------------------------------------------------------------------------

/** The network pages belong to platform accounts only. The menu hides them for everyone else, and the pages say so if opened by address. */
export const isPlatformAccount = (mode: string | null | undefined): boolean => mode === 'payfac';

/** Basis points as a percent without float drift: 150 -> "1.50%". */
export function bpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  return `${whole}.${String(bps % 100).padStart(2, '0')}%`;
}

/** The fee a person types ("1.5") as whole basis points, or null if it is not a plain percent between 0 and 100. */
export function parsePercentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps >= 0 && bps <= 10_000 ? bps : null;
}

// ---- business profile ----------------------------------------------------------------------------------------

export type ProfileForm = {
  displayName: string;
  legalName: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  website: string;
  supportEmail: string;
  supportPhone: string;
  statementDescriptor: string;
  industry: string;
};
export type ProfileProblem = 'required' | 'country' | 'website' | 'email' | 'phone' | 'address' | 'long';
export type ProfileErrors = Partial<Record<keyof ProfileForm, ProfileProblem>>;

export const toForm = (profile: BusinessProfile): ProfileForm => ({
  displayName: profile.displayName ?? '',
  legalName: profile.legalName ?? '',
  line1: profile.address?.line1 ?? '',
  line2: profile.address?.line2 ?? '',
  city: profile.address?.city ?? '',
  region: profile.address?.region ?? '',
  postalCode: profile.address?.postalCode ?? '',
  country: profile.address?.country ?? '',
  website: profile.website ?? '',
  supportEmail: profile.supportEmail ?? '',
  supportPhone: profile.supportPhone ?? '',
  statementDescriptor: profile.statementDescriptor ?? '',
  industry: profile.industry ?? '',
});

const clean = (v: string) => v.trim();
const orNull = (v: string) => (clean(v) === '' ? null : clean(v));
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;

/** The address typed in the form, or null when every address box is empty. */
export function formAddress(form: ProfileForm): Address | null {
  if (ADDRESS_FIELDS.every((k) => clean(form[k]) === '')) return null;
  return {
    line1: clean(form.line1),
    line2: orNull(form.line2),
    city: clean(form.city),
    region: orNull(form.region),
    postalCode: clean(form.postalCode),
    country: clean(form.country).toUpperCase(),
  };
}

const sameAddress = (a: Address | null, b: Address | null) =>
  a === b || (a !== null && b !== null && ADDRESS_FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null)));

/** Only what changed, in the shape the service takes. An empty box clears the field (null); an untouched one is left out. */
export function profilePatch(profile: BusinessProfile, form: ProfileForm): Partial<ProfileFields> {
  const patch: Partial<ProfileFields> = {};
  const text = ['displayName', 'legalName', 'website', 'supportEmail', 'supportPhone', 'statementDescriptor', 'industry'] as const;
  for (const key of text) if (orNull(form[key]) !== (profile[key] ?? null)) patch[key] = orNull(form[key]);
  const address = formAddress(form);
  if (!sameAddress(address, profile.address)) patch.address = address;
  return patch;
}

/** Which of the changed fields INTAFACED reviews before they take effect. */
export const sensitiveChanges = (patch: Partial<ProfileFields>): SensitiveKey[] => SENSITIVE_KEYS.filter((k) => k in patch);

export function validateProfile(form: ProfileForm): ProfileErrors {
  const errors: ProfileErrors = {};
  for (const key of ['displayName', 'legalName', 'statementDescriptor', 'industry'] as const)
    if (clean(form[key]).length > 120) errors[key] = 'long';
  if (clean(form.website)) {
    try {
      const url = new URL(clean(form.website));
      if (url.protocol !== 'https:' || clean(form.website).includes('@')) errors.website = 'website';
    } catch {
      errors.website = 'website';
    }
  }
  if (clean(form.supportEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(form.supportEmail))) errors.supportEmail = 'email';
  if (clean(form.supportPhone) && !/^\+?[0-9][0-9 .-]{6,31}$/.test(clean(form.supportPhone))) errors.supportPhone = 'phone';
  const address = formAddress(form);
  if (address) {
    if (!address.line1) errors.line1 = 'address';
    if (!address.city) errors.city = 'address';
    if (!address.postalCode) errors.postalCode = 'address';
    if (!/^[A-Z]{2}$/.test(address.country)) errors.country = 'country';
  }
  return errors;
}

/** A change still waiting on someone: INTAFACED review, or a second approver on this team. */
export const isWaiting = (status: string) => status === 'pending' || status === 'pending_review';

// ---- network names ------------------------------------------------------------------------------------------

/** What a sub-merchant is called: its own display or legal name when the summary gave one, else "Sub-merchant" plus the start of its id. */
export const nodeName = (node: { id: string; displayName?: string | null; legalName?: string | null }, word: string): string =>
  node.displayName?.trim() || node.legalName?.trim() || `${word} ${node.id.slice(0, 8)}`;

/** "payment.refund" -> "Payment refund". The service owns the list of areas; this only makes one readable. */
export function areaWords(area: string): string {
  const words = area.replace(/[_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
