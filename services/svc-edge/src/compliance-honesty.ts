/**
 * EDGE OPS HONESTY — wire packages/config + contracts analytics refuse to the door.
 *
 * TRK-ops.compliance / ops.analytics residual after #1551 (pure config) and
 * Stage-1 warehouse contracts: operators must SEE unset≠clear, partner_cleared
 * refuse, sole ledger freeze authority, and dark analytics — not invent green
 * ticks from silence on `/admin/status`.
 *
 * No sanctions list content (Class X). No VPN vendor invent. No fake cubes.
 * No second freeze path. Money freeze remains ledger-only.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  FREEZE_AUTHORITY_FLAG_KEY,
  NETWORK_SIGNAL_CONFIGURED_ENV,
  NETWORK_SIGNAL_FAIL_CLOSED_ENV,
  applyComplianceQueueDisposition,
  assertFreezeAuthority,
  assertScreeningConfigured,
  checkNetworkAccess,
  complianceQueueSnapshot,
  freezeAuthorityNote,
  inventFreezeOutsideLedger,
  listFreezeAuthorities,
  networkSignalStatusLine,
  resolveNetworkSignal,
  type ComplianceQueueDispositionRequest,
  type ComplianceQueueDispositionResult,
  type ComplianceQueueItem,
  type ComplianceQueueSnapshot,
  type FreezeAuthorityCheck,
  type NetworkAccessDecision,
  type NetworkSignalObservation,
  type NetworkSignalStatus,
} from '@intafaced/config';
import {
  assertAnalyticsReplicaRole,
  listConfiguredAnalyticsReplicaUrls,
  queryWarehouseSurface,
  resolveEtlWatermark,
  warehouseSurfaceStatusLine,
  type EtlWatermarkState,
  type WarehouseSurfaceResult,
} from '@intafaced/contracts';

export type EdgeNetworkHonesty = {
  readonly signal: NetworkSignalStatus;
  readonly access: NetworkAccessDecision;
  /** Compact line for logs / status. */
  readonly statusLine: string;
  /**
   * Env keys this surface reads — names only, never secrets or vendor brands.
   * Operators set fail-closed when they mean enforcement (Class X partner first).
   */
  readonly envKeys: {
    readonly configured: typeof NETWORK_SIGNAL_CONFIGURED_ENV;
    readonly failClosed: typeof NETWORK_SIGNAL_FAIL_CLOSED_ENV;
  };
};

export type EdgeFreezeHonesty = {
  readonly soleKey: typeof FREEZE_AUTHORITY_FLAG_KEY;
  readonly note: string;
  readonly authorities: readonly string[];
  /**
   * Hostile path: free-text invent freezes ("trade freeze") must refuse.
   * Always evaluated for the probe labels below so status cannot stay silent.
   */
  readonly inventProbes: Readonly<Record<'trade freeze' | 'pay freeze' | 'ledger.posting', FreezeAuthorityCheck>>;
};

export type EdgeAnalyticsHonesty = {
  readonly replicaConfigured: boolean;
  readonly replicaCount: number;
  /** Writer-looking URLs refuse before any cube is painted. */
  readonly refuse: string | null;
  readonly surface: WarehouseSurfaceResult;
  readonly statusLine: string;
  /**
   * ETL watermark honesty residual (ops.analytics / D26-P1-O4 Done bar).
   *
   * `absent` — no parseable operator stamp: empty cannot claim "ETL ran and
   * found nothing" vs "ETL never ran". `present` — ISO stamp from
   * ANALYTICS_ETL_WATERMARK_AT. Never invent cubes from a stamp alone.
   */
  readonly etlWatermark: EtlWatermarkState;
  /** ISO-8601 when present; otherwise null. */
  readonly etlWatermarkAt: string | null;
  readonly etlNote: string;
};

/** Disposition audit entry — process-local; durable case product residual. */
export type ComplianceQueueAuditEntry = {
  readonly at: string;
  readonly itemId: string;
  readonly ok: boolean;
  readonly status: string | null;
  readonly actor: string | null;
  /** Approver from the consumed approval. Absent on a refuse that never reached one. */
  readonly approverId?: string | null;
  readonly code?: string;
  readonly reason?: string;
};

export type ComplianceQueueDoorSnapshot = ComplianceQueueSnapshot & {
  readonly recentAudit: readonly ComplianceQueueAuditEntry[];
  /** `file` survives a process restart. `memory` does not. */
  readonly store: 'file' | 'memory';
};

export type EdgeComplianceHonesty = {
  readonly network: EdgeNetworkHonesty;
  readonly freeze: EdgeFreezeHonesty;
  readonly complianceQueue: ComplianceQueueSnapshot;
  readonly analytics: EdgeAnalyticsHonesty;
  /**
   * Screening list posture already asserted at boot — partnerConfigured for the
   * queue is the screening list being configured (listed OR reviewed-empty),
   * never invent of a vendor pass.
   */
  readonly screeningPartnerConfigured: boolean;
};

/**
 * Resolve all edge-facing ops honesty from env + optional network observation.
 *
 * Pure enough for unit tests: pass env maps; no I/O, no list content invent.
 */
export function edgeComplianceHonesty(
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly networkObservation?: NetworkSignalObservation | null;
    readonly queueItems?: readonly ComplianceQueueItem[];
  } = {},
): EdgeComplianceHonesty {
  const signal = resolveNetworkSignal(env, options.networkObservation);
  const access = checkNetworkAccess(env, options.networkObservation);
  const screening = assertScreeningConfigured(env);
  const partnerConfigured = screening.configured;

  const inventProbes = {
    'trade freeze': inventFreezeOutsideLedger('trade freeze'),
    'pay freeze': inventFreezeOutsideLedger('pay freeze'),
    'ledger.posting': inventFreezeOutsideLedger('ledger.posting'),
  } as const;

  const authorities = listFreezeAuthorities().map((f) => f.key);
  // Sole authority must still assert clean — misconfigured registry is a halt lie.
  const sole = assertFreezeAuthority(FREEZE_AUTHORITY_FLAG_KEY);
  if (!sole.ok) {
    // freezeAuthorityNote already spells MISCONFIGURED; keep authorities empty of lies.
  }

  return {
    network: {
      signal,
      access,
      statusLine: networkSignalStatusLine(env, options.networkObservation),
      envKeys: {
        configured: NETWORK_SIGNAL_CONFIGURED_ENV,
        failClosed: NETWORK_SIGNAL_FAIL_CLOSED_ENV,
      },
    },
    freeze: {
      soleKey: FREEZE_AUTHORITY_FLAG_KEY,
      note: freezeAuthorityNote(),
      authorities,
      inventProbes,
    },
    complianceQueue: complianceQueueSnapshot(options.queueItems ?? [], partnerConfigured),
    analytics: analyticsHonesty(env),
    screeningPartnerConfigured: partnerConfigured,
  };
}

function withEtl(
  env: Record<string, string | undefined>,
  base: Omit<EdgeAnalyticsHonesty, 'etlWatermark' | 'etlWatermarkAt' | 'etlNote'>,
): EdgeAnalyticsHonesty {
  const etl = resolveEtlWatermark(env);
  return { ...base, etlWatermark: etl.state, etlWatermarkAt: etl.at, etlNote: etl.note };
}

function analyticsHonesty(env: Record<string, string | undefined>): EdgeAnalyticsHonesty {
  const listed = listConfiguredAnalyticsReplicaUrls(env);
  if (listed.length === 0) {
    const surface = queryWarehouseSurface({ replicaConfigured: false, lagSeconds: null, facts: [] });
    return withEtl(env, {
      replicaConfigured: false,
      replicaCount: 0,
      refuse: null,
      surface,
      statusLine: warehouseSurfaceStatusLine(surface),
    });
  }

  for (const { source, url } of listed) {
    const role = assertAnalyticsReplicaRole(url, 'readonly');
    if (!role.ok) {
      const surface = queryWarehouseSurface({ replicaConfigured: false, lagSeconds: null, facts: [] });
      return withEtl(env, {
        replicaConfigured: false,
        replicaCount: listed.length,
        refuse: `analytics replica ${source}: ${role.reason}`,
        surface,
        statusLine: `status=refuse reason=writer_or_bad_role source=${source} live=0`,
      });
    }
  }

  // Sync status snapshot stays I/O-free. The warehouse door probes via
  // createSqlWarehouseLagProbe (admin.probeWarehouse). Unknown here is honest.
  const surface = queryWarehouseSurface({
    replicaConfigured: true,
    lagSeconds: null,
    lagSource: 'unknown',
    facts: [],
  });
  return withEtl(env, {
    replicaConfigured: true,
    replicaCount: listed.length,
    refuse: null,
    surface,
    statusLine: warehouseSurfaceStatusLine(surface),
  });
}

/**
 * In-memory compliance queue for the operator door.
 *
 * Persistence/UI product remains residual. Mechanism Done bar: partner_cleared
 * refuses without screening partner; empty is honest empty; no invent cases.
 * Wave 13: explicit open path + disposition audit (process-local).
 */
export class EdgeComplianceQueue {
  private readonly items = new Map<string, ComplianceQueueItem>();
  private readonly audit: ComplianceQueueAuditEntry[] = [];
  private static readonly AUDIT_CAP = 50;
  private readonly statePath: string | undefined;
  private unreadable: string | null = null;

  constructor(
    private readonly env: () => Record<string, string | undefined> = () => process.env,
    options: { readonly statePath?: string | undefined } = {},
  ) {
    this.statePath = options.statePath?.trim() || undefined;
    if (this.statePath) this.hydrate();
  }

  snapshot(): ComplianceQueueDoorSnapshot {
    if (this.unreadable) {
      throw new Error(`edge.compliance_queue_unreadable: ${this.unreadable}`);
    }
    const base = complianceQueueSnapshot([...this.items.values()], assertScreeningConfigured(this.env()).configured);
    return { ...base, recentAudit: [...this.audit], store: this.statePath ? 'file' : 'memory' };
  }

  /**
   * Seed a case for review. Does not invent cases on empty — caller must open.
   * Used by tests and by the admin open route; not auto-filled.
   */
  open(item: ComplianceQueueItem): ComplianceQueueDoorSnapshot {
    const id = item.id.trim();
    if (id === '') throw new Error('compliance queue: item id required');
    if (this.items.has(id)) throw new Error(`compliance queue: item ${id} already open`);
    const subjectId = item.subjectId.trim();
    if (subjectId === '') throw new Error('compliance queue: subjectId required');
    this.items.set(id, { ...item, id, subjectId });
    this.pushAudit({
      at: new Date().toISOString(),
      itemId: id,
      ok: true,
      status: 'opened',
      actor: 'operator',
    });
    this.persist();
    return this.snapshot();
  }

  dispose(
    itemId: string,
    request: ComplianceQueueDispositionRequest,
    meta: { readonly approverId?: string | null; readonly reason?: string | null } = {},
  ): ComplianceQueueDispositionResult {
    const item = this.items.get(itemId.trim()) ?? null;
    const partnerConfigured = assertScreeningConfigured(this.env()).configured;
    const result = applyComplianceQueueDisposition(item, request, partnerConfigured);
    if (result.ok) {
      this.pushAudit({
        at: new Date().toISOString(),
        itemId: result.itemId,
        ok: true,
        status: result.status,
        actor: result.actor,
        approverId: meta.approverId ?? null,
        ...(meta.reason ? { reason: meta.reason } : {}),
      });
      if (result.status !== 'pending') {
        this.items.delete(itemId.trim());
      }
    } else {
      this.pushAudit({
        at: new Date().toISOString(),
        itemId: itemId.trim() || '(unknown)',
        ok: false,
        status: null,
        actor: null,
        code: result.code,
        reason: result.reason,
      });
    }
    this.persist();
    return result;
  }

  private hydrate(): void {
    const path = this.statePath;
    if (!path) return;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.unreadable = code ?? 'read failed';
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { items?: ComplianceQueueItem[]; recentAudit?: ComplianceQueueAuditEntry[] };
      if (!Array.isArray(parsed.items) || !Array.isArray(parsed.recentAudit)) {
        this.unreadable = 'shape';
        return;
      }
      this.items.clear();
      for (const item of parsed.items) this.items.set(item.id, item);
      this.audit.splice(0, this.audit.length, ...parsed.recentAudit.slice(0, EdgeComplianceQueue.AUDIT_CAP));
    } catch {
      this.unreadable = 'json';
    }
  }

  private persist(): void {
    if (!this.statePath || this.unreadable) return;
    const body = `${JSON.stringify({ items: [...this.items.values()], recentAudit: this.audit }, null, 2)}\n`;
    const path = this.statePath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      const data = Buffer.from(body, 'utf8');
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      unlinkSync(tmp);
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, path);
  }

  private pushAudit(entry: ComplianceQueueAuditEntry): void {
    this.audit.unshift(entry);
    if (this.audit.length > EdgeComplianceQueue.AUDIT_CAP) {
      this.audit.length = EdgeComplianceQueue.AUDIT_CAP;
    }
  }
}
