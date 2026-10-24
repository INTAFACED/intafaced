import type { Sql } from 'postgres';
import { parseKycDocKey } from './document-crypto.js';
import { KycDocumentError, KycDocumentStore, type KycDocumentVault } from './document-store.js';
import {
  bindProviderRefToDocument,
  documentReviews,
  type BindProviderRefInput,
  type BindProviderRefResult,
  type DocumentReview,
} from './provider-ref-bind.js';

export type KycVaultBoot = {
  kycDocs: KycDocumentVault;
  bindKycProviderRef: (input: BindProviderRefInput) => Promise<BindProviderRefResult>;
  /** The KYC record each listed document is attached to, read from identity's own records. */
  kycDocumentReviews: (userId: string, documentIds: readonly string[]) => Promise<Map<string, DocumentReview>>;
};

/** Residual id when IDENTITY_KYC_DOC_KEY is unset — procedures refuse closed, never invent a store. */
export const KYC_VAULT_UNWIRED = 'kyc_doc.unwired';

function keyMaterialPresent(keyMaterial: string | undefined): boolean {
  return Boolean(keyMaterial?.trim());
}

/**
 * Wire the §10 vault for createIdentityRouter when IDENTITY_KYC_DOC_KEY is set.
 *
 * - unset / blank → null (router named-refuses `[kyc_doc.unwired]`; never invent a key)
 * - set but not 32-byte base64/hex → named `kyc_doc.key_missing` (not a silent missing store)
 * - valid 32-byte key → vault + bind + the review each document is attached to
 *
 * Production index.ts:
 *   const vault = bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY);
 *   createIdentityRouter(auth, rank, { …, ...(vault ?? {}) })
 */
export function bootKycVault(sql: Sql, keyMaterial: string | undefined): KycVaultBoot | null {
  const parsed = parseKycDocKey(keyMaterial);
  if (keyMaterialPresent(keyMaterial) && !parsed) {
    throw new KycDocumentError('IDENTITY_KYC_DOC_KEY is set but is not a 32-byte key (base64 or hex)', 'kyc_doc.key_missing');
  }
  if (!parsed) return null;
  const kycDocs = new KycDocumentStore(sql, keyMaterial);
  return {
    kycDocs,
    bindKycProviderRef: (input) => bindProviderRefToDocument(sql, kycDocs, input),
    kycDocumentReviews: (userId, documentIds) => documentReviews(sql, userId, documentIds),
  };
}

/**
 * Router options fragment for production boot.
 * Key set → always includes kycDocs (or throws). Key unset → empty object (no silent store).
 */
export function kycRouterBootOptions(sql: Sql, keyMaterial: string | undefined): Partial<KycVaultBoot> {
  const vault = bootKycVault(sql, keyMaterial);
  if (!vault) return {};
  return {
    kycDocs: vault.kycDocs,
    bindKycProviderRef: vault.bindKycProviderRef,
    kycDocumentReviews: vault.kycDocumentReviews,
  };
}
