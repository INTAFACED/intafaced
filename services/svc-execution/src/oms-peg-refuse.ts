/**
 * Live OMS peg/midpoint that is not matching peg refuses by field.
 * Matching `engine/peg.ts` already installs peg — do not dual-implement.
 * PX-S03 invariant 12: never map to a plain limit without preview+consent.
 * Paper pegged stays paper.
 */
export type OmsPegRefuseReason = 'peg_unsupported' | 'midpoint_unsupported' | 'relative_unsupported';

export type OmsPegRefuseField = 'peg' | 'midpoint' | 'relative' | 'pegOffset' | 'pegType' | 'kind';

export type OmsPegRefusal = {
  readonly ok: false;
  readonly reason: OmsPegRefuseReason;
  readonly field: OmsPegRefuseField;
  readonly detail: string;
};

function kindPegReason(kind: string | null | undefined): OmsPegRefuseReason | null {
  const k = kind?.trim().toLowerCase();
  if (k === 'midpoint') return 'midpoint_unsupported';
  if (k === 'peg' || k === 'pegged') return 'peg_unsupported';
  if (k === 'relative') return 'relative_unsupported';
  return null;
}

function present(raw: string | null | undefined): boolean {
  return raw !== undefined && raw !== null && raw.trim().length > 0;
}

/**
 * Live OMS peg/midpoint/relative is not matching peg.
 * Refuse by field rather than silently mapping to a plain limit.
 */
export function refuseLiveOmsPeg(input: {
  readonly peg?: boolean;
  readonly midpoint?: boolean;
  readonly relative?: boolean;
  readonly pegOffset?: string | null;
  readonly pegType?: string | null;
  readonly kind?: string | null;
}): OmsPegRefusal | null {
  if (input.midpoint === true) {
    return {
      ok: false,
      reason: 'midpoint_unsupported',
      field: 'midpoint',
      detail: 'live OMS midpoint is unsupported — refusing by field rather than mapping to a plain limit without preview+consent',
    };
  }
  if (input.peg === true) {
    return {
      ok: false,
      reason: 'peg_unsupported',
      field: 'peg',
      detail: 'live OMS peg is not matching peg — refusing by field rather than mapping to a plain limit without preview+consent',
    };
  }
  if (input.relative === true) {
    return {
      ok: false,
      reason: 'relative_unsupported',
      field: 'relative',
      detail: 'live OMS relative is not matching peg — refusing by field rather than mapping to a plain limit without preview+consent',
    };
  }
  const fromKind = kindPegReason(input.kind);
  if (fromKind) {
    return {
      ok: false,
      reason: fromKind,
      field: 'kind',
      detail: `live OMS kind ${String(input.kind)} is unsupported peg/midpoint — refusing by field rather than mapping to a plain limit without preview+consent`,
    };
  }
  if (present(input.pegType)) {
    return {
      ok: false,
      reason: 'peg_unsupported',
      field: 'pegType',
      detail: 'live OMS pegType is unsupported — refusing by field rather than mapping to a plain limit without preview+consent',
    };
  }
  if (present(input.pegOffset)) {
    return {
      ok: false,
      reason: 'peg_unsupported',
      field: 'pegOffset',
      detail: 'live OMS pegOffset is unsupported — refusing by field rather than mapping to a plain limit without preview+consent',
    };
  }
  return null;
}
