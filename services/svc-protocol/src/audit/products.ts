/**
 * The audit room's per-product rows (D-developer-compliance-02). Each Protocol product shows the external audit the owner
 * recorded for it, or none. A row fills only from an owner-committed external claim in `external-claims.json` that names
 * the product AND whose own package hash matches (`evaluatePackage` sets `audited`); each claim is checked on its own, so
 * one claim can never lend its passing check to another, and a claim whose file cannot be read fills nothing. Tests,
 * internal packages and compile hashes never fill a row: they are listed as internal checks, "Our own tests, not an audit".
 */
import { PROTOCOL_AUDIT_PRODUCTS, type ProtocolAuditProducts } from '@intafaced/contracts/protocol-blockers';
import type { AuditRecord } from './pipeline.js';
import { evaluateExternalClaim, loadExternalClaims, loadInternalPackageRecords, type ExternalClaim } from './registry.js';

/** Pure: the rows from each claim paired with its own evaluated record (null when its package could not be read). */
export function productAudits(
  checked: readonly { claim: ExternalClaim; record: AuditRecord | null }[],
  internal: readonly AuditRecord[],
): ProtocolAuditProducts {
  const products = PROTOCOL_AUDIT_PRODUCTS.map((product) => {
    const hit = checked.find(({ claim, record }) => claim.products?.includes(product) && record?.audited === true)?.claim;
    return {
      product,
      external: hit
        ? {
            id: hit.id,
            packagePath: hit.packagePath,
            signedBy: hit.signedBy,
            signedAt: hit.signedAt,
            scope: hit.scope ?? null,
            reportUrl: hit.reportUrl ?? null,
          }
        : null,
    };
  });
  return { products, internal: internal.map((record) => ({ id: record.id, packagePath: record.packagePath })) };
}

let cached: ProtocolAuditProducts | null = null;
/** The claims and packages are committed files, so they are read and hashed once per process. */
export function loadProductAudits(root?: string): ProtocolAuditProducts {
  if (root === undefined && cached) return cached;
  const checked = loadExternalClaims(root).map((claim) => ({ claim, record: evaluateExternalClaim(claim, root) }));
  const rows = productAudits(checked, loadInternalPackageRecords(root));
  if (root === undefined) cached = rows;
  return rows;
}
