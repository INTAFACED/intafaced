import type { CubeFactRow, CubePoint } from '@intafaced/contracts';
import { queryWarehouseSurface, resolveEtlWatermark, resolveWarehouseReplicaConfig } from '@intafaced/contracts/ops-analytics-warehouse';
import {
  OPS_CONTACT_REQUIRED,
  OPS_FUNDRAISING_AMOUNT_INVALID,
  OPS_FUNDRAISING_CHAIN_UNWIRED,
  OPS_STRUCTURED_OWNER_PRICE_REQUIRED,
  OPS_STRUCTURED_PRICE_FORBIDDEN,
  OPS_IDENTITY_UNWIRED,
  OPS_PAYROLL_INVENT_FORBIDDEN,
  OPS_PROJECT_REQUIRED,
  OPS_RAISE_NAME_REQUIRED,
  OPS_SUPPORT_UNWIRED,
  OPS_TEAM_HANDLE_REQUIRED,
  OPS_WAREHOUSE_LAG_STALE,
  OPS_WAREHOUSE_LAG_UNKNOWN,
  OPS_WAREHOUSE_UNWIRED,
  OPS_CUSTODY_WRAP_UNSET,
  OPS_CUSTODY_CHAIN_UNWIRED,
  OPS_CUSTODY_KEYS_FORBIDDEN,
  OPS_CUSTODY_TIER_REQUIRED,
  OPS_CUSTODY_AMOUNT_INVALID,
  OPS_CUSTODY_FREEZE_UNSET,
  OPS_CUSTODY_FROZEN,
  OpsError,
} from './codes.js';

export type ContactSource = 'local' | 'identity' | 'support';

export type Contact = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly source: ContactSource;
};

export type TeamMember = {
  readonly id: string;
  readonly handle: string;
  readonly role: string;
};

export type Project = {
  readonly id: string;
  readonly title: string;
  readonly status: 'open';
};

export type Raise = {
  readonly id: string;
  readonly name: string;
  readonly targetAmount: string | null;
};

export type Milestone = {
  readonly id: string;
  readonly raiseId: string;
  readonly label: string;
};

export type StructuredRecord = {
  readonly id: string;
  readonly name: string;
  readonly legLabels: string[];
};

export type SourcedRows<T> = {
  readonly status: 'ok' | 'absent';
  readonly code?: string;
  readonly rows: readonly T[];
};

export type RevenuePoint = {
  metricId: string;
  value: string;
  dim: string | null;
};

export type RevenueResult = {
  empty: boolean;
  status: 'ok' | 'empty';
  mayLabelLive: boolean;
  freshness: string;
  points: RevenuePoint[];
};

export type ContactsResult = {
  contacts: Contact[];
  identity: { status: 'ok' | 'absent'; code?: string };
  support: { status: 'ok' | 'absent'; code?: string };
};

export type TeamResult = {
  members: TeamMember[];
  identity: { status: 'ok' | 'absent'; code?: string };
  payroll: { forbidden: true; code: typeof OPS_PAYROLL_INVENT_FORBIDDEN };
};

export const CUSTODY_TIERS = ['cold', 'warm', 'hot'] as const;
export type CustodyTierId = (typeof CUSTODY_TIERS)[number];

export type CustodyKey = {
  readonly id: string;
  readonly label: string;
};

export type CustodyTier = {
  readonly id: CustodyTierId;
  readonly keys: readonly CustodyKey[];
};

export type CustodyWrap = { readonly status: 'unset'; readonly code: typeof OPS_CUSTODY_WRAP_UNSET } | { readonly status: 'configured' };

export type CustodyFreeze =
  | { readonly status: 'unset'; readonly code: typeof OPS_CUSTODY_FREEZE_UNSET }
  | { readonly status: 'frozen'; readonly code: typeof OPS_CUSTODY_FROZEN }
  | { readonly status: 'open' };

export type CustodyApproval = {
  readonly id: string;
  readonly fromTier: CustodyTierId;
  readonly toTier: CustodyTierId;
  readonly amount: string | null;
  readonly status: 'pending';
};

export type CustodyResult = {
  wrap: CustodyWrap;
  freeze: CustodyFreeze;
  tiers: CustodyTier[];
  approvals: CustodyApproval[];
};

const PAYROLL_KEYS = ['salary', 'compensation', 'payroll', 'wage', 'pay'] as const;
const CHAIN_KEYS = ['escrow', 'vesting', 'settlement', 'fund', 'release', 'tokenPrice', 'valuation', 'price', 'mid'] as const;
const KEY_MATERIAL_KEYS = ['privateKey', 'mnemonic', 'seed', 'secret', 'key', 'wrapped', 'hex', 'wif', 'xprv', 'wrap'] as const;
const DECIMAL_AMOUNT = /^\d+(\.\d{1,18})?$/;

export interface OpsServiceDeps {
  readonly warehouseEnv?: Record<string, string | undefined>;
  readonly identitySource?: () => Promise<SourcedRows<Contact>>;
  readonly supportSource?: () => Promise<SourcedRows<Contact>>;
  readonly identityTeamSource?: () => Promise<SourcedRows<TeamMember>>;
  readonly facts?: readonly CubeFactRow[] | null;
  readonly now?: () => Date;
  readonly id?: () => string;
  /** Presence only. Blank → wrap/execute refuse-closed. Never echoed or invented. */
  readonly custodyWrap?: string;
  /**
   * Owner freeze policy. Blank / unknown → createApproval + execute refuse-closed.
   * `frozen` refuses sends. `open` passes this gate only. Never echoed.
   */
  readonly custodyFreezePolicy?: string;
}

function absent<T>(code: string): SourcedRows<T> {
  return { status: 'absent', code, rows: [] };
}

export class OpsService {
  private readonly warehouseEnv: Record<string, string | undefined>;
  private readonly identitySource: () => Promise<SourcedRows<Contact>>;
  private readonly supportSource: () => Promise<SourcedRows<Contact>>;
  private readonly identityTeamSource: () => Promise<SourcedRows<TeamMember>>;
  private readonly facts: readonly CubeFactRow[];
  private readonly id: () => string;
  private readonly custodyWrap: string;
  private readonly custodyFreezePolicy: string;
  private readonly contacts = new Map<string, Contact>();
  private readonly members = new Map<string, TeamMember>();
  private readonly projects = new Map<string, Project>();
  private readonly raises = new Map<string, Raise>();
  private readonly milestones = new Map<string, Milestone>();
  private readonly structured = new Map<string, StructuredRecord>();
  private readonly approvals = new Map<string, CustodyApproval>();

  constructor(deps: OpsServiceDeps = {}) {
    this.warehouseEnv = deps.warehouseEnv ?? {};
    this.identitySource = deps.identitySource ?? (async () => absent<Contact>(OPS_IDENTITY_UNWIRED));
    this.supportSource = deps.supportSource ?? (async () => absent<Contact>(OPS_SUPPORT_UNWIRED));
    this.identityTeamSource = deps.identityTeamSource ?? (async () => absent<TeamMember>(OPS_IDENTITY_UNWIRED));
    this.facts = deps.facts ?? [];
    this.id = deps.id ?? (() => crypto.randomUUID());
    this.custodyWrap = (deps.custodyWrap ?? '').trim();
    this.custodyFreezePolicy = (deps.custodyFreezePolicy ?? '').trim();
  }

  async listContacts(): Promise<ContactsResult> {
    const identity = await this.identitySource();
    const support = await this.supportSource();
    const local = [...this.contacts.values()];
    const seen = new Set(local.map((c) => c.id));
    const sourced: Contact[] = [];
    for (const row of [...identity.rows, ...support.rows]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      sourced.push(row);
    }
    return {
      contacts: [...local, ...sourced],
      identity: { status: identity.status, code: identity.code },
      support: { status: support.status, code: support.code },
    };
  }

  createContact(input: { displayName?: string; email?: string | null }): Contact {
    const displayName = (input.displayName ?? '').trim();
    if (!displayName) {
      throw new OpsError(OPS_CONTACT_REQUIRED, 'A contact needs a name — nothing was invented');
    }
    const emailRaw = (input.email ?? '').trim();
    const contact: Contact = {
      id: this.id(),
      displayName,
      email: emailRaw.length > 0 ? emailRaw : null,
      source: 'local',
    };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  async listTeam(): Promise<TeamResult> {
    const identity = await this.identityTeamSource();
    const local = [...this.members.values()];
    const seen = new Set(local.map((m) => m.id));
    const sourced: TeamMember[] = [];
    for (const row of identity.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      sourced.push(row);
    }
    return {
      members: [...local, ...sourced],
      identity: { status: identity.status, code: identity.code },
      payroll: { forbidden: true, code: OPS_PAYROLL_INVENT_FORBIDDEN },
    };
  }

  createTeamMember(input: Record<string, unknown>): TeamMember {
    this.refusePayroll(input);
    const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
    const role = typeof input.role === 'string' ? input.role.trim() : 'member';
    if (!handle) {
      throw new OpsError(OPS_TEAM_HANDLE_REQUIRED, 'A directory row needs a handle — payroll was not invented either');
    }
    const member: TeamMember = { id: this.id(), handle, role: role.length > 0 ? role : 'member' };
    this.members.set(member.id, member);
    return member;
  }

  inventPayroll(_input: Record<string, unknown>): never {
    throw new OpsError(OPS_PAYROLL_INVENT_FORBIDDEN, 'Payroll is not built and must not be invented');
  }

  async revenue(): Promise<RevenueResult> {
    const resolved = await resolveWarehouseReplicaConfig({ env: this.warehouseEnv });
    if (resolved.status === 'refuse' || !resolved.replicaConfigured) {
      throw new OpsError(OPS_WAREHOUSE_UNWIRED, 'Analytics warehouse replica is not wired. No invented revenue.');
    }
    const etl = resolveEtlWatermark(this.warehouseEnv);
    const surface = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: resolved.lagSeconds,
      lagMeasuredAt: resolved.lagMeasuredAt,
      lagSource: resolved.lagSource,
      facts: this.facts,
      etlWatermark: etl.state,
      etlWatermarkAt: etl.at,
    });
    if (surface.status === 'unavailable') {
      if (surface.reason === 'replica_unconfigured') {
        throw new OpsError(OPS_WAREHOUSE_UNWIRED, 'Analytics warehouse replica is not wired. No invented revenue.');
      }
      if (surface.reason === 'lag_stale') {
        throw new OpsError(OPS_WAREHOUSE_LAG_STALE, 'Warehouse lag is stale. No invented revenue.');
      }
      throw new OpsError(OPS_WAREHOUSE_LAG_UNKNOWN, 'Warehouse lag is unknown. No invented revenue.');
    }
    if (surface.status === 'refuse') {
      throw new OpsError(OPS_WAREHOUSE_UNWIRED, surface.reason);
    }
    const points: CubePoint[] = surface.status === 'ok' ? [...surface.points] : [];
    const freshness = surface.freshness;
    return {
      empty: surface.status === 'empty' || points.length === 0,
      status: surface.status === 'ok' && points.length > 0 ? 'ok' : 'empty',
      mayLabelLive: surface.mayLabelLive,
      freshness,
      points: points.map((p) => ({ metricId: p.metricId, value: p.value, dim: p.dim ?? null })),
    };
  }

  listProjects(): { projects: Project[] } {
    return { projects: [...this.projects.values()] };
  }

  createProject(input: { title?: string }): Project {
    const title = (input.title ?? '').trim();
    if (!title) {
      throw new OpsError(OPS_PROJECT_REQUIRED, 'A project needs a title — the list stays empty rather than fake');
    }
    const project: Project = { id: this.id(), title, status: 'open' };
    this.projects.set(project.id, project);
    return project;
  }

  listRaises(): { raises: Raise[] } {
    return { raises: [...this.raises.values()] };
  }

  listMilestones(input: { raiseId?: string } = {}): { milestones: Milestone[] } {
    const raiseId = typeof input.raiseId === 'string' ? input.raiseId.trim() : '';
    const rows = [...this.milestones.values()];
    return { milestones: raiseId.length > 0 ? rows.filter((m) => m.raiseId === raiseId) : rows };
  }

  listStructured(): { records: StructuredRecord[] } {
    return { records: [...this.structured.values()] };
  }

  createStructured(input: Record<string, unknown>): StructuredRecord {
    this.refuseStructuredPricing(input);
    const ownerPrice = (this.warehouseEnv.STRUCTURED_OWNER_PRICE ?? this.warehouseEnv.OPS_STRUCTURED_OWNER_PRICE ?? '').trim();
    if (!ownerPrice) {
      throw new OpsError(
        OPS_STRUCTURED_OWNER_PRICE_REQUIRED,
        'Structured launch needs an owner-published price env; no price was invented',
      );
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new OpsError(OPS_RAISE_NAME_REQUIRED, 'A structured record needs a name — nothing was invented');
    }
    const record: StructuredRecord = {
      id: this.id(),
      name,
      legLabels: this.parseMilestoneLabels(input.legLabels),
    };
    this.structured.set(record.id, record);
    return record;
  }

  createRaise(input: Record<string, unknown>): Raise {
    this.refuseChain(input);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new OpsError(OPS_RAISE_NAME_REQUIRED, 'A raise needs a name — nothing was invented');
    }
    const raise: Raise = {
      id: this.id(),
      name,
      targetAmount: this.parseTargetAmount(input.targetAmount),
    };
    this.raises.set(raise.id, raise);
    for (const label of this.parseMilestoneLabels(input.milestoneLabels)) {
      const milestone: Milestone = { id: this.id(), raiseId: raise.id, label };
      this.milestones.set(milestone.id, milestone);
    }
    return raise;
  }

  fundRaise(_input: Record<string, unknown>): never {
    throw new OpsError(OPS_FUNDRAISING_CHAIN_UNWIRED, 'On-chain escrow and vesting are not wired. Fundraising records do not move value.');
  }

  listCustody(): CustodyResult {
    return {
      wrap: this.wrapState(),
      freeze: this.freezeState(),
      tiers: CUSTODY_TIERS.map((id) => ({ id, keys: [] })),
      approvals: [...this.approvals.values()],
    };
  }

  createApproval(input: Record<string, unknown>): CustodyApproval {
    this.refuseKeyMaterial(input);
    this.assertFreezeAllowsSend();
    const fromTier = this.parseTier(input.fromTier);
    const toTier = this.parseTier(input.toTier);
    if (fromTier === toTier) {
      throw new OpsError(OPS_CUSTODY_TIER_REQUIRED, 'An approval needs two different tiers — nothing was invented');
    }
    const approval: CustodyApproval = {
      id: this.id(),
      fromTier,
      toTier,
      amount: this.parseCustodyAmount(input.amount),
      status: 'pending',
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  wrapKeys(_input: Record<string, unknown> = {}): never {
    this.refuseKeyMaterial(_input);
    if (!this.wrapConfigured()) {
      throw new OpsError(OPS_CUSTODY_WRAP_UNSET, 'Custody wrap is unset. Wrap stays refuse-closed. No key was invented.');
    }
    throw new OpsError(OPS_CUSTODY_KEYS_FORBIDDEN, 'Real keys are not stored or invented');
  }

  executeApproval(_input: Record<string, unknown> = {}): never {
    this.refuseKeyMaterial(_input);
    this.assertFreezeAllowsSend();
    if (!this.wrapConfigured()) {
      throw new OpsError(OPS_CUSTODY_WRAP_UNSET, 'Custody wrap is unset. Execute stays refuse-closed. No key was invented.');
    }
    throw new OpsError(OPS_CUSTODY_CHAIN_UNWIRED, 'On-chain multi-sig is not wired here. Custody records do not move value.');
  }

  private parseTargetAmount(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === 'number') {
      throw new OpsError(OPS_FUNDRAISING_AMOUNT_INVALID, 'targetAmount must be a decimal string — money is never a number');
    }
    if (typeof raw !== 'string') {
      throw new OpsError(OPS_FUNDRAISING_AMOUNT_INVALID, 'targetAmount must be a decimal string — money is never a number');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (!DECIMAL_AMOUNT.test(trimmed)) {
      throw new OpsError(OPS_FUNDRAISING_AMOUNT_INVALID, 'targetAmount must be a decimal string — no invented price');
    }
    return trimmed;
  }

  private parseMilestoneLabels(raw: unknown): string[] {
    const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
    const labels: string[] = [];
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      const label = part.trim();
      if (label.length > 0) labels.push(label);
    }
    return labels;
  }

  private refuseChain(input: Record<string, unknown>): void {
    for (const key of CHAIN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '') {
        throw new OpsError(
          OPS_FUNDRAISING_CHAIN_UNWIRED,
          'On-chain escrow and vesting are not wired. Fundraising records do not move value.',
        );
      }
    }
  }

  private refuseStructuredPricing(input: Record<string, unknown>): void {
    for (const key of ['mark', 'payoff', 'price', 'tokenPrice', 'valuation']) {
      if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '') {
        throw new OpsError(
          OPS_STRUCTURED_PRICE_FORBIDDEN,
          'Structured records carry names and leg labels only — no mark, payoff, or price calculation',
        );
      }
    }
  }

  private refusePayroll(input: Record<string, unknown>): void {
    for (const key of PAYROLL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '') {
        throw new OpsError(OPS_PAYROLL_INVENT_FORBIDDEN, 'Payroll is not built and must not be invented');
      }
    }
  }

  private wrapConfigured(): boolean {
    return this.custodyWrap.length > 0;
  }

  private wrapState(): CustodyWrap {
    if (!this.wrapConfigured()) {
      return { status: 'unset', code: OPS_CUSTODY_WRAP_UNSET };
    }
    return { status: 'configured' };
  }

  private freezeState(): CustodyFreeze {
    const token = this.custodyFreezePolicy.toLowerCase();
    if (token === 'open') return { status: 'open' };
    if (token === 'frozen') return { status: 'frozen', code: OPS_CUSTODY_FROZEN };
    return { status: 'unset', code: OPS_CUSTODY_FREEZE_UNSET };
  }

  private assertFreezeAllowsSend(): void {
    const freeze = this.freezeState();
    if (freeze.status === 'unset') {
      throw new OpsError(
        OPS_CUSTODY_FREEZE_UNSET,
        'Custody freeze policy is unset. Withdrawals and external sends stay refuse-closed. Nothing was queued.',
      );
    }
    if (freeze.status === 'frozen') {
      throw new OpsError(OPS_CUSTODY_FROZEN, 'Custody is frozen. Withdrawals and external sends refuse. Nothing was queued.');
    }
  }

  private parseTier(raw: unknown): CustodyTierId {
    if (typeof raw !== 'string') {
      throw new OpsError(OPS_CUSTODY_TIER_REQUIRED, 'A custody approval needs a cold/warm/hot tier — nothing was invented');
    }
    const tier = raw.trim();
    if (!CUSTODY_TIERS.includes(tier as CustodyTierId)) {
      throw new OpsError(OPS_CUSTODY_TIER_REQUIRED, 'A custody approval needs a cold/warm/hot tier — nothing was invented');
    }
    return tier as CustodyTierId;
  }

  private parseCustodyAmount(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === 'number') {
      throw new OpsError(OPS_CUSTODY_AMOUNT_INVALID, 'amount must be a decimal string — money is never a number');
    }
    if (typeof raw !== 'string') {
      throw new OpsError(OPS_CUSTODY_AMOUNT_INVALID, 'amount must be a decimal string — money is never a number');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (!DECIMAL_AMOUNT.test(trimmed)) {
      throw new OpsError(OPS_CUSTODY_AMOUNT_INVALID, 'amount must be a decimal string — no invented balance');
    }
    return trimmed;
  }

  private refuseKeyMaterial(input: Record<string, unknown>): void {
    for (const key of KEY_MATERIAL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '') {
        throw new OpsError(OPS_CUSTODY_KEYS_FORBIDDEN, 'Real keys are not stored or invented');
      }
    }
  }
}
