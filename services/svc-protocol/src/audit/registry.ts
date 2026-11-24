/**
 * Protocol audit registry — internal packages and the empty external intake.
 *
 * `audited:true` is unreachable until Nitro commits a firm report and a matching
 * row in `external-claims.json`. Internal packages and compile hashes never flip
 * the flag. Do not invent an EntryPoint here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PROTOCOL_AUDIT_PRODUCTS } from '@intafaced/contracts/protocol-blockers';
import { evaluatePackage, INTERNAL_SMART_ACCOUNTS, type AuditRecord, type PackageClaim } from './pipeline.js';

/** Repo-relative intake. Empty `claims` is the shipped state. */
export const EXTERNAL_CLAIMS_PATH = 'services/svc-protocol/src/audit/external-claims.json';

const HASH = /^0x[0-9a-f]{64}$/;

const ExternalClaimSchema = z.object({
  id: z.string().min(1),
  packagePath: z.string().min(1),
  kind: z.literal('external'),
  signedBy: z.string().min(1),
  signedAt: z.string().min(1),
  expectedHash: z.string().regex(HASH),
  /** The Protocol products the report covers (the audit room's rows). Absent covers none. */
  products: z.array(z.enum(PROTOCOL_AUDIT_PRODUCTS)).optional(),
  /** The report's own scope, in words, and where it can be read. Absent shows the claim's id and no link. */
  scope: z.string().min(1).optional(),
  reportUrl: z.string().url().optional(),
});

const ExternalClaimsFileSchema = z.object({
  claims: z.array(ExternalClaimSchema),
});

function repoRootFromThisFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function asHash(value: string): `0x${string}` {
  if (!HASH.test(value)) {
    throw new Error(`invalid expectedHash ${value}`);
  }
  return value as `0x${string}`;
}

function loadPackageRecord(root: string, claim: PackageClaim): AuditRecord {
  const contents = readFileSync(join(root, claim.packagePath), 'utf8');
  return evaluatePackage(claim, contents);
}

export function loadInternalPackageRecords(root: string = repoRootFromThisFile()): AuditRecord[] {
  return [loadPackageRecord(root, INTERNAL_SMART_ACCOUNTS)];
}

export type ExternalClaim = z.infer<typeof ExternalClaimSchema>;

/** The owner-committed external claims, as written. Empty when the file is absent. */
export function loadExternalClaims(root: string = repoRootFromThisFile()): ExternalClaim[] {
  const claimsPath = join(root, EXTERNAL_CLAIMS_PATH);
  if (!existsSync(claimsPath)) return [];
  return ExternalClaimsFileSchema.parse(JSON.parse(readFileSync(claimsPath, 'utf8'))).claims;
}

/** One claim checked against its package file; null when the file cannot be read, so one bad row never hides the rest. */
export function evaluateExternalClaim(claim: ExternalClaim, root: string = repoRootFromThisFile()): AuditRecord | null {
  try {
    return loadPackageRecord(root, {
      id: claim.id,
      packagePath: claim.packagePath,
      kind: 'external',
      signedBy: claim.signedBy,
      signedAt: claim.signedAt,
      expectedHash: asHash(claim.expectedHash),
    });
  } catch {
    return null;
  }
}
