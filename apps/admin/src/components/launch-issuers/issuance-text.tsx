import { ISSUANCE_KIND_LABEL, type Issuance } from '@/lib/launch-issuers/model';

/** A launch's issuance as svc-token stores it: its kind, the detail that kind needs, and its compliance flags as labels. */
export function IssuanceText({ issuance }: { issuance: Issuance }) {
  const detail =
    issuance.kind === 'wrapped'
      ? `backed by ${issuance.backingAsset}`
      : issuance.kind === 'synthetic'
        ? `tracks ${issuance.oracle}`
        : issuance.kind === 'structured'
          ? `legs: ${issuance.legTerms}`
          : null;
  return (
    <span data-testid="launch-issuance" data-kind={issuance.kind}>
      {' '}
      <strong data-testid="issuance-kind">{ISSUANCE_KIND_LABEL[issuance.kind]}</strong>
      {detail && <span data-testid="issuance-detail"> ({detail})</span>}
      {issuance.flags.map((f) => (
        <span key={f} className="adm-chip" data-testid="issuance-flag">
          {f}
        </span>
      ))}
    </span>
  );
}
