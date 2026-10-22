import { changeHashesEqual, founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { merchantDescriptorProblem } from '@intafaced/contracts';
import { cleanMerchantName } from '../merchant-names.js';
import { PortalError } from './errors.js';

/**
 * Business-profile fields.
 *
 * Sensitive fields (legal name, address, statement descriptor, industry) are
 * applied by the submitting owner or admin only while KYB is `none` or
 * `rejected`. While KYB is `pending` a sensitive edit is refused
 * (`pay.profile_kyb_pending`); immediate fields in that request still apply.
 * Once KYB is approved, sensitive fields wait for INTAFACED compliance. A
 * merchant second approver is an optional extra step after that, default off,
 * and does not apply the identity. Immediate fields apply on submit, including
 * while a sensitive change is waiting, and are still logged.
 */

export const SENSITIVE_KEYS = ['legalName', 'address', 'statementDescriptor', 'industry'] as const;
export const IMMEDIATE_KEYS = ['displayName', 'website', 'supportEmail', 'supportPhone'] as const;
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];
export type ImmediateKey = (typeof IMMEDIATE_KEYS)[number];

export interface MerchantAddress {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
}

export interface ProfileFields {
  displayName: string | null;
  legalName: string | null;
  address: MerchantAddress | null;
  website: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  statementDescriptor: string | null;
  industry: string | null;
}

export type ProfilePatch = {
  [K in keyof ProfileFields]?: ProfileFields[K];
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

function invalid(_field: string): never {
  throw new PortalError('pay.profile_field_invalid', 'bad_request');
}

/**
 * M-plat-org-09: the statement descriptor follows the shared contracts rule
 * (`merchantDescriptorProblem`), so the screen and the server refuse the same
 * values. Null or an empty string (what the portal sends to clear the field)
 * clears it. Any other value must pass the rule exactly, without trimming;
 * a failure refuses `pay.profile_descriptor_invalid` and nothing is written.
 */
function cleanStatementDescriptor(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (merchantDescriptorProblem(value) !== null) throw new PortalError('pay.profile_descriptor_invalid', 'bad_request');
  return value;
}

function cleanText(value: string, field: string): string {
  const cleaned = cleanMerchantName(value);
  if (!cleaned) invalid(field);
  return cleaned;
}

function cleanWebsite(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200 || CONTROL.test(trimmed) || trimmed.includes('@')) invalid('website');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    invalid('website');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalid('website');
  return trimmed;
}

function cleanEmail(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 3 ||
    trimmed.length > 200 ||
    CONTROL.test(trimmed) ||
    /\s/.test(trimmed) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  ) {
    invalid('supportEmail');
  }
  return trimmed;
}

function cleanPhone(value: string): string {
  const trimmed = value.trim();
  if (!/^\+?[0-9][0-9 .\-]{6,31}$/.test(trimmed)) invalid('supportPhone');
  return trimmed;
}

function cleanAddress(value: MerchantAddress): MerchantAddress {
  const line1 = cleanText(value.line1, 'address');
  const city = cleanText(value.city, 'address');
  const postalCode = cleanText(value.postalCode, 'address');
  const line2 = value.line2 === null ? null : cleanText(value.line2, 'address');
  const region = value.region === null ? null : cleanText(value.region, 'address');
  if (!/^[A-Z]{2}$/.test(value.country)) invalid('address');
  return { line1, line2, city, region, postalCode, country: value.country };
}

function assign<K extends keyof ProfileFields>(patch: ProfilePatch, key: K, value: ProfileFields[K] | undefined): void {
  if (value !== undefined) patch[key] = value;
}

/** Normalize a submit body. Omitted keys are left out. Null clears. Invalid text refuses. */
export function parseProfilePatch(input: {
  displayName?: string | null;
  legalName?: string | null;
  address?: MerchantAddress | null;
  website?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  statementDescriptor?: string | null;
  industry?: string | null;
}): { immediate: Partial<Pick<ProfileFields, ImmediateKey>>; sensitive: Partial<Pick<ProfileFields, SensitiveKey>> } {
  const immediate: Partial<Pick<ProfileFields, ImmediateKey>> = {};
  const sensitive: Partial<Pick<ProfileFields, SensitiveKey>> = {};
  if (input.displayName !== undefined)
    immediate.displayName = input.displayName === null ? null : cleanText(input.displayName, 'displayName');
  if (input.website !== undefined) immediate.website = input.website === null ? null : cleanWebsite(input.website);
  if (input.supportEmail !== undefined) immediate.supportEmail = input.supportEmail === null ? null : cleanEmail(input.supportEmail);
  if (input.supportPhone !== undefined) immediate.supportPhone = input.supportPhone === null ? null : cleanPhone(input.supportPhone);
  if (input.legalName !== undefined) sensitive.legalName = input.legalName === null ? null : cleanText(input.legalName, 'legalName');
  if (input.address !== undefined) sensitive.address = input.address === null ? null : cleanAddress(input.address);
  if (input.statementDescriptor !== undefined) {
    sensitive.statementDescriptor = cleanStatementDescriptor(input.statementDescriptor);
  }
  if (input.industry !== undefined) sensitive.industry = input.industry === null ? null : cleanText(input.industry, 'industry');
  if (Object.keys(immediate).length === 0 && Object.keys(sensitive).length === 0) {
    throw new PortalError('pay.profile_change_empty', 'bad_request');
  }
  return { immediate, sensitive };
}

export function sensitiveKeysOf(sensitive: Partial<Pick<ProfileFields, SensitiveKey>>): SensitiveKey[] {
  return SENSITIVE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(sensitive, key));
}

/** The hash compliance must send. Bound to the proposal and the version they were shown. */
export function profileChangeHash(sensitive: Partial<Pick<ProfileFields, SensitiveKey>>, expectedVersion: string): string {
  return founderChangeHash({ kind: 'merchant_business_profile', proposed: sensitive }, expectedVersion);
}

export function hashesMatch(stored: string, presented: string): boolean {
  return changeHashesEqual(stored, presented);
}

export function applyPatch(current: ProfileFields, patch: ProfilePatch): ProfileFields {
  const next = { ...current };
  for (const key of [...IMMEDIATE_KEYS, ...SENSITIVE_KEYS]) {
    assign(next, key, patch[key]);
  }
  return next;
}
