/**
 * Protocol audit registry — internal packages, empty external intake, live
 * suite fingerprints from committed `contracts/out`.
 *
 * `audited:true` is unreachable until Nitro commits a firm report and a matching
 * row in `external-claims.json`. Internal packages and compile hashes never flip
 * the flag. Do not invent an EntryPoint here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PROTOCOL_AUDIT_PRODUCTS } from '@intafaced/contracts/protocol-blockers';
import { evaluatePackage, INTERNAL_SMART_ACCOUNTS, type AuditRecord, type PackageClaim } from './pipeline.js';

export type SuiteFingerprint = {
  suite: string;
  sourceHash: `0x${string}`;
  sourceFiles: string[];
};

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

function artifactsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../contracts/out');
}

function asHash(value: string): `0x${string}` {
  if (!HASH.test(value)) {
    throw new Error(`invalid sourceHash ${value}`);
  }
  return value as `0x${string}`;
}

/**
 * One fingerprint per compile suite, from committed artefacts (same bytes
 * `artifacts.test.ts` re-derives). Request-path code must not import
 * `scripts/contract-sources.mjs` — that file sits outside tsc `rootDir`.
 */
export function computeSuiteFingerprints(outDir: string = artifactsDir()): SuiteFingerprint[] {
  const bySuite = new Map<string, { sourceHash: `0x${string}`; files: Set<string> }>();
  for (const name of readdirSync(outDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(outDir, name), 'utf8')) as {
      suite?: unknown;
      sourceHash?: unknown;
      sourceName?: unknown;
    };
    if (typeof raw.suite !== 'string' || typeof raw.sourceHash !== 'string') continue;
    const sourceHash = asHash(raw.sourceHash);
    const sourceName = typeof raw.sourceName === 'string' ? raw.sourceName : name;
    const existing = bySuite.get(raw.suite);
    if (!existing) {
      bySuite.set(raw.suite, { sourceHash, files: new Set([sourceName]) });
      continue;
    }
    if (existing.sourceHash !== sourceHash) {
      throw new Error(`suite ${raw.suite} has conflicting sourceHash in ${name}`);
    }
    existing.files.add(sourceName);
  }
  return [...bySuite.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([suite, row]) => ({
      suite,
      sourceHash: row.sourceHash,
      sourceFiles: [...row.files].sort(),
    }));
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

export function loadExternalPackageRecords(root: string = repoRootFromThisFile()): AuditRecord[] {
  return loadExternalClaims(root).map((claim) =>
    loadPackageRecord(root, {
      id: claim.id,
      packagePath: claim.packagePath,
      kind: 'external',
      signedBy: claim.signedBy,
      signedAt: claim.signedAt,
      expectedHash: asHash(claim.expectedHash),
    }),
  );
}

export type AuditRegistry = {
  packages: AuditRecord[];
  suites: SuiteFingerprint[];
  auditedCount: number;
  packageCount: number;
  suiteCount: number;
  anyAudited: boolean;
};

export function loadAuditRegistry(root: string = repoRootFromThisFile()): AuditRegistry {
  const packages = [...loadInternalPackageRecords(root), ...loadExternalPackageRecords(root)];
  const auditedCount = packages.filter((record) => record.audited).length;
  const suites = computeSuiteFingerprints();
  return {
    packages,
    suites,
    auditedCount,
    packageCount: packages.length,
    suiteCount: suites.length,
    anyAudited: auditedCount > 0,
  };
}
