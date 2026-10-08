/** Browser-safe projections of svc-ops/router.ts. Unknown fields never reach the desk. */
export const OPS_VIEWS = ['contacts', 'team', 'revenue', 'projects', 'fundraising', 'milestones', 'custody', 'structured'] as const;
export type OpsView = (typeof OPS_VIEWS)[number];
export const OPS_CREATES = [
  'createContact',
  'createTeamMember',
  'projects.create',
  'fundraising.create',
  'custody.createApproval',
  'structured.create',
] as const;
export type OpsCreate = (typeof OPS_CREATES)[number];
export type SourceMeta = { status: 'ok' | 'absent'; code?: string };
export type OpsData = {
  contacts?: { id: string; displayName: string; email: string | null; source: string }[];
  members?: { id: string; handle: string; role: string }[];
  identity?: SourceMeta;
  support?: SourceMeta;
  payroll?: { forbidden: true; code: string };
  projects?: { id: string; title: string; status: 'open' }[];
  raises?: { id: string; name: string; targetAmount: string | null }[];
  milestones?: { id: string; raiseId: string; label: string }[];
  records?: { id: string; name: string; legLabels: string[] }[];
  points?: { metricId: string; value: string; dim: string | null }[];
  empty?: boolean;
  status?: 'ok' | 'empty';
  mayLabelLive?: boolean;
  freshness?: string;
  wrap?: { status: 'unset' | 'configured'; code?: string };
  freeze?: { status: 'unset' | 'frozen' | 'open'; code?: string };
  tiers?: { id: string; keys: { id: string; label: string }[] }[];
  approvals?: { id: string; fromTier: string; toTier: string; amount: string | null; status: 'pending' }[];
};
export type OpsAuthority = { readConfigured: boolean; writeConfigured: boolean; missingRead: string[]; missingWrite: string[] };
export type OpsReply = {
  ok: boolean;
  status: number;
  code?: string;
  uncertain?: boolean;
  data?: OpsData;
  record?: { id: string; label: string };
  authority?: OpsAuthority;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid projection');
  return value as Record<string, unknown>;
}
function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid string');
  return value;
}
function text(value: unknown): string {
  const out = str(value);
  if (!out.trim()) throw new Error('empty string');
  return out;
}
function nullable(value: unknown): string | null {
  return value === null ? null : str(value);
}
function one<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error('invalid state');
  return value as T;
}
function rows<T>(value: unknown, parse: (row: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) throw new Error('invalid rows');
  return value.map((row) => parse(object(row)));
}
function amount(value: unknown): string | null {
  if (value === null) return null;
  const out = str(value);
  if (!/^\d+(\.\d{1,18})?$/.test(out)) throw new Error('invalid decimal');
  return out;
}
function source(value: unknown): SourceMeta {
  const row = object(value);
  return { status: one(row.status, ['ok', 'absent']), ...(row.code === undefined ? {} : { code: str(row.code) }) };
}
function state<T extends string>(value: unknown, allowed: readonly T[], codes: Partial<Record<T, string>>): { status: T; code?: string } {
  const row = object(value);
  const status = one(row.status, allowed);
  const expected = codes[status];
  if (expected && row.code !== expected) throw new Error('invalid policy code');
  return { status, ...(expected ? { code: expected } : {}) };
}
const contact = (r: Record<string, unknown>) => ({
  id: text(r.id),
  displayName: text(r.displayName),
  email: nullable(r.email),
  source: one(r.source, ['local', 'identity', 'support']),
});
const member = (r: Record<string, unknown>) => ({ id: text(r.id), handle: text(r.handle), role: text(r.role) });
const project = (r: Record<string, unknown>) => ({ id: text(r.id), title: text(r.title), status: one(r.status, ['open']) });
const raise = (r: Record<string, unknown>) => ({ id: text(r.id), name: text(r.name), targetAmount: amount(r.targetAmount) });
const approval = (r: Record<string, unknown>) => ({
  id: text(r.id),
  fromTier: one(r.fromTier, ['cold', 'warm', 'hot']),
  toTier: one(r.toTier, ['cold', 'warm', 'hot']),
  amount: amount(r.amount),
  status: one(r.status, ['pending']),
});
const structured = (r: Record<string, unknown>) => {
  if (!Array.isArray(r.legLabels)) throw new Error('invalid labels');
  return { id: text(r.id), name: text(r.name), legLabels: r.legLabels.map(text) };
};

export function parseOpsData(view: OpsView, value: unknown): OpsData {
  const d = object(value);
  switch (view) {
    case 'contacts':
      return { contacts: rows(d.contacts, contact), identity: source(d.identity), support: source(d.support) };
    case 'team': {
      const payroll = object(d.payroll);
      if (payroll.forbidden !== true || payroll.code !== 'ops.payroll_invent_forbidden') throw new Error('invalid payroll state');
      return { members: rows(d.members, member), identity: source(d.identity), payroll: { forbidden: true, code: payroll.code } };
    }
    case 'projects':
      return { projects: rows(d.projects, project) };
    case 'fundraising':
      return { raises: rows(d.raises, raise) };
    case 'milestones':
      return { milestones: rows(d.milestones, (r) => ({ id: text(r.id), raiseId: text(r.raiseId), label: text(r.label) })) };
    case 'structured':
      return { records: rows(d.records, structured) };
    case 'custody':
      return {
        wrap: state(d.wrap, ['unset', 'configured'], { unset: 'ops.custody_wrap_unset' }),
        freeze: state(d.freeze, ['unset', 'frozen', 'open'], { unset: 'ops.custody_freeze_unset', frozen: 'ops.custody_frozen' }),
        tiers: rows(d.tiers, (r) => ({
          id: one(r.id, ['cold', 'warm', 'hot']),
          keys: rows(r.keys, (k) => ({ id: text(k.id), label: text(k.label) })),
        })),
        approvals: rows(d.approvals, approval),
      };
    case 'revenue': {
      if (typeof d.empty !== 'boolean' || typeof d.mayLabelLive !== 'boolean') throw new Error('invalid revenue state');
      return {
        empty: d.empty,
        status: one(d.status, ['ok', 'empty']),
        mayLabelLive: d.mayLabelLive,
        freshness: str(d.freshness),
        points: rows(d.points, (r) => ({ metricId: text(r.metricId), value: str(r.value), dim: nullable(r.dim) })),
      };
    }
  }
}

export function parseOpsCreated(operation: OpsCreate, value: unknown): { id: string; label: string } {
  const d = object(value);
  switch (operation) {
    case 'createContact': {
      const r = contact(d);
      return { id: r.id, label: r.displayName };
    }
    case 'createTeamMember': {
      const r = member(d);
      return { id: r.id, label: r.handle };
    }
    case 'projects.create': {
      const r = project(d);
      return { id: r.id, label: r.title };
    }
    case 'fundraising.create': {
      const r = raise(d);
      return { id: r.id, label: r.name };
    }
    case 'custody.createApproval': {
      const r = approval(d);
      return { id: r.id, label: `${r.fromTier} → ${r.toTier}` };
    }
    case 'structured.create': {
      const r = structured(d);
      return { id: r.id, label: r.name };
    }
  }
}

export function opsCreateInput(operation: OpsCreate, value: unknown): Record<string, unknown> {
  const d = object(value);
  const allowed: Record<OpsCreate, string[]> = {
    createContact: ['displayName', 'email'],
    createTeamMember: ['handle', 'role'],
    'projects.create': ['title'],
    'fundraising.create': ['name', 'milestoneLabels', 'targetAmount'],
    'custody.createApproval': ['fromTier', 'toTier', 'amount'],
    'structured.create': ['name', 'legLabels'],
  };
  if (Object.keys(d).some((key) => !allowed[operation].includes(key))) throw new Error('unsupported input');
  switch (operation) {
    case 'createContact':
      return { displayName: text(d.displayName).trim(), ...(d.email == null ? {} : { email: str(d.email).trim() }) };
    case 'createTeamMember':
      return { handle: text(d.handle).trim(), role: text(d.role).trim() };
    case 'projects.create':
      return { title: text(d.title).trim() };
    case 'fundraising.create': {
      if (!Array.isArray(d.milestoneLabels)) throw new Error('milestones must be labels');
      return { name: text(d.name).trim(), milestoneLabels: d.milestoneLabels.map(text), targetAmount: amount(d.targetAmount ?? null) };
    }
    case 'structured.create': {
      if (!Array.isArray(d.legLabels)) throw new Error('legs must be labels');
      return { name: text(d.name).trim(), legLabels: d.legLabels.map(text) };
    }
    case 'custody.createApproval': {
      const fromTier = one(d.fromTier, ['cold', 'warm', 'hot']);
      const toTier = one(d.toTier, ['cold', 'warm', 'hot']);
      if (fromTier === toTier) throw new Error('different tiers required');
      return { fromTier, toTier, amount: amount(d.amount ?? null) };
    }
  }
}
