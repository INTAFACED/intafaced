import { z } from 'zod';
import { defineProcedure, NO_INPUT, type ReplyCheck } from './procedure.js';
import {
  draftBirthDateReal,
  kycDocumentTypesInputSchema,
  kycDocumentTypesSchema,
  kycProfileDraftSchema,
  kycProfileSchema,
  kycProfileStartInputSchema,
  kycProfileSubmitInputSchema,
  kycProfileUploadInputSchema,
} from './identity-kyc-profile.js';

/**
 * svc-identity guided verification (`kyc.profile.*`, `kyc.documentTypes.read`), one record per call: the caller's own
 * draft, never another person's (no `userId` input). `kyc.profile.saveStep` is not a record yet: its `fields` input is
 * checked per step by the service, which answers `kyc.profile_invalid` naming the fields, and a portable schema of it
 * would refuse a malformed step before that answer.
 */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'identity:read' } as const;
const WRITE = { caller: 'scope', scope: 'identity:write' } as const;

const UNCONFIGURED = { 'kyc.profile_unconfigured': 'PRECONDITION_FAILED' } as const;
const DRAFT_HELD = {
  'kyc.profile_none': 'PRECONDITION_FAILED',
  'kyc.profile_version': 'CONFLICT',
} as const;

/** The date of birth in a draft a reply carries is a real calendar date, as identity sealed it. */
const BIRTH_SAYS = "the draft's date of birth, when entered, is a real calendar date from 1900 to today";
const replyHolds =
  <T>(schema: z.ZodType<T>, rule: (reply: T) => boolean) =>
  (reply: unknown): boolean => {
    const read = schema.safeParse(reply);
    return read.success && rule(read.data);
  };
const draftBirthDate: Readonly<Record<string, ReplyCheck>> = {
  birthDateReal: { says: BIRTH_SAYS, holds: replyHolds(kycProfileDraftSchema, draftBirthDateReal) },
};

export const IDENTITY_KYC_DOCUMENT_TYPES_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.documentTypes.read',
  kind: 'query',
  path: 'kyc.documentTypes.read',
  access: READ,
  refusals: UNCONFIGURED,
  input: kycDocumentTypesInputSchema,
  output: kycDocumentTypesSchema,
  samples: [
    { verdict: 'accept', input: { country: 'DE' } },
    { verdict: 'refuse', input: { country: 'de' } },
  ],
});

export const IDENTITY_KYC_PROFILE_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.profile.read',
  kind: 'query',
  path: 'kyc.profile.read',
  access: READ,
  refusals: UNCONFIGURED,
  input: NO_INPUT,
  output: kycProfileSchema,
  accept: { birthDateReal: { says: BIRTH_SAYS, holds: replyHolds(kycProfileSchema, (reply) => draftBirthDateReal(reply.draft)) } },
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_KYC_PROFILE_START = defineProcedure({
  ...base,
  name: 'identity.kyc.profile.start',
  kind: 'mutation',
  path: 'kyc.profile.start',
  access: WRITE,
  refusals: { ...UNCONFIGURED, 'kyc.profile_version': 'CONFLICT' },
  input: kycProfileStartInputSchema,
  output: kycProfileDraftSchema,
  accept: draftBirthDate,
  samples: [
    { verdict: 'accept', input: { tier: 'basic' } },
    { verdict: 'refuse', input: { tier: 'none' } },
  ],
});

export const IDENTITY_KYC_PROFILE_UPLOAD = defineProcedure({
  ...base,
  name: 'identity.kyc.profile.upload',
  kind: 'mutation',
  path: 'kyc.profile.upload',
  access: WRITE,
  refusals: {
    ...UNCONFIGURED,
    ...DRAFT_HELD,
    'kyc.profile_sent': 'CONFLICT',
    'kyc.profile_incomplete': 'BAD_REQUEST',
    'kyc.upload_caps_unset': 'PRECONDITION_FAILED',
    'kyc.upload_type': 'BAD_REQUEST',
    'kyc.upload_too_large': 'PAYLOAD_TOO_LARGE',
  },
  input: kycProfileUploadInputSchema,
  output: kycProfileDraftSchema,
  accept: draftBirthDate,
  samples: [
    { verdict: 'accept', input: { version: 1, contentType: 'image/png', bytesBase64: 'iVBORw0KGgo=' } },
    { verdict: 'refuse', input: { version: 0, contentType: 'image/png', bytesBase64: 'iVBORw0KGgo=' } },
  ],
});

export const IDENTITY_KYC_PROFILE_SUBMIT = defineProcedure({
  ...base,
  name: 'identity.kyc.profile.submit',
  kind: 'mutation',
  path: 'kyc.profile.submit',
  access: WRITE,
  refusals: {
    ...UNCONFIGURED,
    ...DRAFT_HELD,
    'kyc.profile_incomplete': 'BAD_REQUEST',
    'kyc.profile_request_open': 'CONFLICT',
  },
  input: kycProfileSubmitInputSchema,
  output: z.object({ recordId: z.string().uuid(), documentCheck: z.literal('not_connected') }),
  samples: [
    { verdict: 'accept', input: { version: 3 } },
    { verdict: 'refuse', input: { version: 0 } },
  ],
});

export const IDENTITY_KYC_PROFILE_PROCEDURES = [
  IDENTITY_KYC_DOCUMENT_TYPES_READ,
  IDENTITY_KYC_PROFILE_READ,
  IDENTITY_KYC_PROFILE_START,
  IDENTITY_KYC_PROFILE_UPLOAD,
  IDENTITY_KYC_PROFILE_SUBMIT,
] as const;
