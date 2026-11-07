/**
 * The audit room's per-product rows (D-developer-compliance-02). Each Protocol product shows the external audit the owner
 * recorded for it, or none. A row fills only from an owner-committed external claim in `external-claims.json` that names
 * the product AND whose package hash matches (`evaluatePackage` sets `audited`). Tests, internal packages and compile
 * hashes never fill a row: they are listed as internal checks, "Our own tests, not an audit".
 */
import { PROTOCOL_AUDIT_PRODUCTS, type ProtocolAuditProducts } from '@intafaced/contracts/protocol-blockers';
import type { AuditRecord } from './pipeline.js';
import { loadExternalClaims, loadExternalPackageRecords, loadInternalPackageRecords, type ExternalClaim } from './registry.js';

/** Pure: the rows from the claims as written and the records the pipeline evaluated from them. */
export function productAudits(
  claims: readonly ExternalClaim[],
  external: readonly AuditRecord[],
  internal: readonly AuditRecord[],
): ProtocolAuditProducts {
  const products = PROTOCOL_AUDIT_PRODUCTS.map((product) => {
    const claim = claims.find(
      (entry) => entry.products?.includes(product) && external.some((record) => record.id === entry.id && record.audited),
    );
    return {
      product,
      external: claim ? { id: claim.id, packagePath: claim.packagePath, signedBy: claim.signedBy, signedAt: claim.signedAt } : null,
    };
  });
  return { products, internal: internal.map((record) => ({ id: record.id, packagePath: record.packagePath })) };
}

export function loadProductAudits(root?: string): ProtocolAuditProducts {
  return productAudits(loadExternalClaims(root), loadExternalPackageRecords(root), loadInternalPackageRecords(root));
}
