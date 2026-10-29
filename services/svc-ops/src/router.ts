import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { HomeConfig } from '@intafaced/contracts';
import { createHomeConfigRouter, homeConfigFromEnv } from './home-config.js';
import {
  opsCostEntryInputSchema,
  opsCostEntrySchema,
  opsVenueEconomicsSchema,
  publicProcedure,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import {
  OPS_CONTACTS_LIST_LIMIT_UNSET,
  OPS_CUSTODY_CHAIN_UNWIRED,
  OPS_CUSTODY_KEYS_FORBIDDEN,
  OPS_CUSTODY_KEYS_UNPUBLISHED,
  OPS_CUSTODY_LEDGER_UNWIRED,
  OPS_CUSTODY_LIST_LIMIT_UNSET,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_ARCHIVE_UNPROBED,
  OPS_RESTORE_STORAGE_UNCONFIGURED,
  OPS_CUSTODY_WRAP_UNSET,
  OPS_CUSTODY_FREEZE_UNSET,
  OPS_CUSTODY_FROZEN,
  OPS_FUNDRAISING_CHAIN_UNWIRED,
  OPS_FUNDRAISING_LIST_LIMIT_UNSET,
  OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET,
  OPS_PAYROLL_INVENT_FORBIDDEN,
  OPS_PROJECTS_LIST_LIMIT_UNSET,
  OPS_STRUCTURED_LIST_LIMIT_UNSET,
  OPS_TEAM_LIST_LIMIT_UNSET,
  OPS_WAREHOUSE_UNWIRED,
  OpsError,
  OPS_COST_STORAGE_UNCONFIGURED,
  OPS_FEE_REVENUE_UNCONFIGURED,
} from './codes.js';
import type { FeeRevenuePort, FeeRevenueRead } from './fee-revenue-client.js';
import { assertOpsListLimit, OPS_LIST_LIMIT_CAP } from './list-limit.js';
import type { OpsService } from './ops-service.js';
import { createReconciliationAlertRoutes } from './reconciliation-alerts/router.js';
import type { ReconciliationAlertStore } from './reconciliation-alerts/store.js';
import type { OutreachCrm } from './outreach/crm.js';
import type { FounderAuthority } from './outreach/authority.js';
import { createOutreachRouter } from './outreach/router.js';
import type { PublicSettingsBook } from './outreach/public-settings.js';
import {
  archivePosture,
  assertIdempotencyKey,
  consumeFounderApproval,
  custodyOpsStatus,
  parseWatermarkInput,
  rememberIdempotent,
  restoreWatermarksRead,
  takeIdempotent,
  type ApprovalConsumer,
  type WatermarkStamp,
} from './operator-desks.js';
import { createAlertRulesRouter } from './alerts/router.js';
import { createAlertDeskRoutes } from './alerts/overview.js';
import type { AlertDeskStore } from './alerts/desk-store.js';
import { ConsoleModeDesk } from './console-mode/desk.js';
import { createConsoleModeRouter } from './console-mode/router.js';
import type { ConsoleModeStore } from './console-mode/store.js';
import { AnnouncementDesk } from './console-announcements/desk.js';
import { createAnnouncementsRouter } from './console-announcements/router.js';
import type { AnnouncementStore } from './console-announcements/store.js';
import { createPreferencesRouter } from './console-preferences/router.js';
import type { PreferenceStore } from './console-preferences/store.js';
import { createServiceRecordsRouter } from './service-records/router.js';
import { StaffHoldDesk } from './staff-holds/desk.js';
import { createStaffHoldsRouter } from './staff-holds/router.js';
import type { ServiceRecordStore } from './service-records/store.js';
import { createProtocolListingRouter } from './protocol-listing/router.js';
import type { ListingDesk } from './protocol-listing/wiring.js';
import { createComplianceRouter } from './compliance/router.js';
import type { ComplianceStore } from './compliance/store.js';
import type { AlertRules } from './alerts/rules.js';
import type { AlertStateStore } from './alerts/state-store.js';
import { stampFingerprint, type RestoreStampStore } from './restore-store.js';
import type { RestoreArchiveProbeResult } from './restore/archive-probe.js';
import type { RestoreDesk } from './restore/desk.js';
import { costFingerprint, type VenueCostStore } from './venue-cost-store.js';
import { composeVenueEconomics, parseCostEntry, parseCostPeriod, periodWindow, readRevenue } from './venue-economics.js';

/**
 * Page size. Optional so omit reaches the named refuse
 * (`ops.*_list_limit_unset`) instead of a Zod "Required".
 * Blank is not 50; pass 50 explicitly when that is the page you want.
 */
const listLimitField = z.number().int().min(1).max(OPS_LIST_LIMIT_CAP).optional();
const listLimitInput = z.object({ limit: listLimitField }).optional();

const contactSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().nullable(),
  source: z.enum(['local', 'identity', 'support']),
});

const sourcedMeta = z.object({
  status: z.enum(['ok', 'absent']),
  code: z.string().optional(),
});

const teamMemberSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  role: z.string().min(1),
});

const projectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.literal('open'),
});

const raiseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  targetAmount: z.string().nullable(),
});

const milestoneSchema = z.object({
  id: z.string().min(1),
  raiseId: z.string().min(1),
  label: z.string().min(1),
});

const structuredSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  legLabels: z.array(z.string().min(1)),
});

const pointSchema = z.object({
  metricId: z.string().min(1),
  value: z.string(),
  dim: z.string().nullable(),
});

const custodyTierId = z.enum(['cold', 'warm', 'hot']);

const custodyKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

const custodyTierSchema = z.object({
  id: custodyTierId,
  keys: z.array(custodyKeySchema),
});

const custodyWrapSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(OPS_CUSTODY_WRAP_UNSET) }),
  z.object({ status: z.literal('configured') }),
]);

const custodyFreezeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(OPS_CUSTODY_FREEZE_UNSET) }),
  z.object({ status: z.literal('frozen'), code: z.literal(OPS_CUSTODY_FROZEN) }),
  z.object({ status: z.literal('open') }),
]);

const custodyApprovalSchema = z.object({
  id: z.string().min(1),
  fromTier: custodyTierId,
  toTier: custodyTierId,
  amount: z.string().nullable(),
  status: z.literal('pending'),
});

async function readFeeRevenue(port: FeeRevenuePort | undefined, period: string): Promise<FeeRevenueRead> {
  if (!port) {
    return {
      ok: false,
      code: OPS_FEE_REVENUE_UNCONFIGURED,
      message: 'The ledger is not wired to this service. No fee revenue was invented.',
    };
  }
  return port.read(periodWindow(period));
}

function requireRestoreDesk(desk: RestoreDesk | undefined): RestoreDesk {
  if (!desk) {
    throw new OpsError(OPS_RESTORE_STORAGE_UNCONFIGURED, 'No durable storage is configured for restore runs. Nothing was read or started.');
  }
  return desk;
}

function requireVenueCosts(store: VenueCostStore | undefined): VenueCostStore {
  if (!store) {
    throw new OpsError(
      OPS_COST_STORAGE_UNCONFIGURED,
      'No durable storage is configured for venue cost entries. Nothing was read or saved.',
    );
  }
  return store;
}

function mapError(err: unknown): never {
  if (err instanceof OpsError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${err.code} — ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

export interface OperatorDeskConfig {
  readonly now?: () => string;
  readonly restoreArchiveUrl?: string | null;
  /**
   * Reads the archive manifest for `restore.backups`. Absent means a configured URL stays
   * `ops.restore_archive_unprobed` and the list stays empty.
   */
  readonly restoreArchiveProbe?: (url: string) => Promise<RestoreArchiveProbeResult>;
  /** Reconciliation alerts (OPS-reconciliation-03). Absent means every call refuses `ops.alert_storage_unconfigured`. */
  readonly reconciliationAlerts?: ReconciliationAlertStore;
  readonly approvals?: ApprovalConsumer;
  /** Durable joint-restore stamps. Absent means stamping refuses `ops.restore_storage_unconfigured`. */
  readonly restoreStamps?: RestoreStampStore;
  /** The joint restore saga: runs, steps, gates. Absent means every run call refuses `ops.restore_storage_unconfigured`. */
  readonly restoreDesk?: RestoreDesk;
  /** Durable venue cost entries. Absent means the venue economics calls refuse `ops.cost_storage_unconfigured`. */
  readonly venueCosts?: VenueCostStore;
  /** The ledger's fee revenue read. Absent means the report says `ops.fee_revenue_unconfigured` and gives no net. */
  readonly feeRevenue?: FeeRevenuePort;
  /** Durable alert rules. Absent means every alertRules call refuses `ops.alert_storage_unconfigured`. */
  readonly alertRules?: AlertRules;
  readonly alertState?: AlertStateStore;
  /** Heartbeats, templates and the quality policy. Absent refuses ops.alert_storage_unconfigured. */
  readonly alertDesk?: AlertDeskStore;
  /** Blank means a heartbeat is recorded but never judged overdue. */
  readonly alertHeartbeatMaxAgeSeconds?: number | null;
  /** Protocol pool hide and market delist (D-order-controls-04). Absent means every call refuses `ops.protocol_listing_storage_unconfigured`. */
  readonly protocolListing?: ListingDesk;
  /** Durable compliance cases. Absent means every compliance call refuses `ops.compliance_storage_unconfigured`. */
  readonly compliance?: ComplianceStore;
  /** The founder console's maintenance mode. Absent means every call refuses `ops.console_mode_storage_unconfigured`. */
  readonly consoleMode?: ConsoleModeStore;
  /** The console's announcement banner. Absent means every call refuses `ops.announcement_storage_unconfigured`. */
  readonly announcements?: AnnouncementStore;
  /** Console preferences. Absent means every call refuses `ops.preferences_storage_unconfigured`. */
  readonly preferences?: PreferenceStore;
  /** Service records per module (owner, dependencies, runbook). Absent means every call refuses `ops.service_storage_unconfigured`. */
  readonly serviceRecords?: ServiceRecordStore;
  /** Staff holds on funds. Absent means every call refuses `ops.hold_storage_unconfigured`. */
  readonly staffHolds?: StaffHoldDesk;
  /** Home's owner values for the public `home.config` read. Absent means every value is blank. */
  readonly homeConfig?: HomeConfig;
}

export function createOpsRouter(
  ops: OpsService,
  outreach?: { crm: OutreachCrm; authority: FounderAuthority; publicSettings?: PublicSettingsBook },
  desks: OperatorDeskConfig = {},
) {
  const now = desks.now ?? (() => new Date().toISOString());
  const reconciliationAlertRoutes = createReconciliationAlertRoutes(desks.reconciliationAlerts);
  const alertDeskRoutes = createAlertDeskRoutes({
    now,
    ...(desks.alertState ? { alertState: desks.alertState } : {}),
    ...(desks.alertRules ? { alertRules: desks.alertRules } : {}),
    ...(desks.alertDesk ? { alertDesk: desks.alertDesk } : {}),
    alertHeartbeatMaxAgeSeconds: desks.alertHeartbeatMaxAgeSeconds ?? null,
  });
  const idem = new Map<string, { fingerprint: string; value: unknown }>();
  const deskError = (err: unknown): never => {
    if (err instanceof OpsError && err.code === OPS_IDEMPOTENCY_CONFLICT) {
      throw new TRPCError({ code: 'CONFLICT', message: `${err.code} — ${err.message}`, cause: err });
    }
    mapError(err);
  };
  return router({
    ...(outreach ? { outreach: createOutreachRouter(outreach.crm, outreach.authority, outreach.publicSettings) } : {}),
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.literal('svc-ops') }))
      .query(() => ({ ok: true as const, service: 'svc-ops' as const })),

    contacts: scopedProcedure('ops:read', guards)
      .input(listLimitInput)
      .output(
        z.object({
          contacts: z.array(contactSchema),
          identity: sourcedMeta,
          support: sourcedMeta,
        }),
      )
      .query(async ({ input }) => {
        try {
          const limit = assertOpsListLimit(input?.limit, OPS_CONTACTS_LIST_LIMIT_UNSET);
          const out = await ops.listContacts();
          return { ...out, contacts: out.contacts.slice(0, limit) };
        } catch (err) {
          mapError(err);
        }
      }),

    createContact: scopedProcedure('ops:write', guards)
      .input(z.object({ displayName: z.string(), email: z.string().optional().nullable() }))
      .output(contactSchema)
      .mutation(({ input }) => {
        try {
          return ops.createContact(input);
        } catch (err) {
          mapError(err);
        }
      }),

    team: scopedProcedure('ops:read', guards)
      .input(listLimitInput)
      .output(
        z.object({
          members: z.array(teamMemberSchema),
          identity: sourcedMeta,
          payroll: z.object({
            forbidden: z.literal(true),
            code: z.literal(OPS_PAYROLL_INVENT_FORBIDDEN),
          }),
        }),
      )
      .query(async ({ input }) => {
        try {
          const limit = assertOpsListLimit(input?.limit, OPS_TEAM_LIST_LIMIT_UNSET);
          const out = await ops.listTeam();
          return { ...out, members: out.members.slice(0, limit) };
        } catch (err) {
          mapError(err);
        }
      }),

    createTeamMember: scopedProcedure('ops:write', guards)
      .input(z.object({ handle: z.string().optional(), role: z.string().optional() }).passthrough())
      .output(teamMemberSchema)
      .mutation(({ input }) => {
        try {
          return ops.createTeamMember(input as Record<string, unknown>);
        } catch (err) {
          mapError(err);
        }
      }),

    inventPayroll: scopedProcedure('ops:write', guards)
      .input(z.object({}).passthrough().optional())
      .mutation(() => {
        try {
          ops.inventPayroll({});
        } catch (err) {
          mapError(err);
        }
      }),

    revenue: scopedProcedure('ops:read', guards)
      .output(
        z.object({
          empty: z.boolean(),
          status: z.enum(['ok', 'empty']),
          mayLabelLive: z.boolean(),
          freshness: z.string(),
          points: z.array(pointSchema),
        }),
      )
      .query(async () => {
        try {
          const out = await ops.revenue();
          return { ...out, points: [...out.points] };
        } catch (err) {
          mapError(err);
        }
      }),

    projects: router({
      list: scopedProcedure('ops:read', guards)
        .input(listLimitInput)
        .output(z.object({ projects: z.array(projectSchema) }))
        .query(({ input }) => {
          try {
            const limit = assertOpsListLimit(input?.limit, OPS_PROJECTS_LIST_LIMIT_UNSET);
            const out = ops.listProjects();
            return { projects: out.projects.slice(0, limit) };
          } catch (err) {
            mapError(err);
          }
        }),
      create: scopedProcedure('ops:write', guards)
        .input(z.object({ title: z.string() }))
        .output(projectSchema)
        .mutation(({ input }) => {
          try {
            return ops.createProject(input);
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    fundraising: router({
      list: scopedProcedure('ops:read', guards)
        .input(listLimitInput)
        .output(z.object({ raises: z.array(raiseSchema) }))
        .query(({ input }) => {
          try {
            const limit = assertOpsListLimit(input?.limit, OPS_FUNDRAISING_LIST_LIMIT_UNSET);
            const out = ops.listRaises();
            return { raises: out.raises.slice(0, limit) };
          } catch (err) {
            mapError(err);
          }
        }),
      create: scopedProcedure('ops:write', guards)
        .input(
          z
            .object({
              name: z.string().optional(),
              milestoneLabels: z.union([z.array(z.string()), z.string()]).optional(),
              targetAmount: z.string().nullable().optional(),
            })
            .passthrough(),
        )
        .output(raiseSchema)
        .mutation(({ input }) => {
          try {
            return ops.createRaise(input as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
      milestones: scopedProcedure('ops:read', guards)
        .input(z.object({ raiseId: z.string().optional(), limit: listLimitField }).optional())
        .output(z.object({ milestones: z.array(milestoneSchema) }))
        .query(({ input }) => {
          try {
            const limit = assertOpsListLimit(input?.limit, OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET);
            const out = ops.listMilestones({ raiseId: input?.raiseId });
            return { milestones: out.milestones.slice(0, limit) };
          } catch (err) {
            mapError(err);
          }
        }),
      fund: scopedProcedure('ops:write', guards)
        .input(z.object({}).passthrough().optional())
        .mutation(({ input }) => {
          try {
            ops.fundRaise((input ?? {}) as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    structured: router({
      list: scopedProcedure('ops:read', guards)
        .input(listLimitInput)
        .output(z.object({ records: z.array(structuredSchema) }))
        .query(({ input }) => {
          try {
            const limit = assertOpsListLimit(input?.limit, OPS_STRUCTURED_LIST_LIMIT_UNSET);
            const out = ops.listStructured();
            return { records: out.records.slice(0, limit) };
          } catch (err) {
            mapError(err);
          }
        }),
      create: scopedProcedure('ops:write', guards)
        .input(
          z
            .object({
              name: z.string().optional(),
              legLabels: z.union([z.array(z.string()), z.string()]).optional(),
            })
            .passthrough(),
        )
        .output(structuredSchema)
        .mutation(({ input }) => {
          try {
            return ops.createStructured(input as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    custody: router({
      list: scopedProcedure('ops:read', guards)
        .input(listLimitInput)
        .output(
          z.object({
            wrap: custodyWrapSchema,
            freeze: custodyFreezeSchema,
            tiers: z.array(custodyTierSchema),
            approvals: z.array(custodyApprovalSchema),
          }),
        )
        .query(({ input }) => {
          try {
            const limit = assertOpsListLimit(input?.limit, OPS_CUSTODY_LIST_LIMIT_UNSET);
            const out = ops.listCustody();
            return {
              wrap: out.wrap,
              freeze: out.freeze,
              tiers: out.tiers.map((t) => ({ id: t.id, keys: [...t.keys] })),
              approvals: out.approvals.slice(0, limit),
            };
          } catch (err) {
            mapError(err);
          }
        }),
      createApproval: scopedProcedure('ops:write', guards)
        .input(
          z
            .object({
              fromTier: z.string().optional(),
              toTier: z.string().optional(),
              amount: z.string().nullable().optional(),
            })
            .passthrough(),
        )
        .output(custodyApprovalSchema)
        .mutation(({ input }) => {
          try {
            return ops.createApproval(input as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
      wrap: scopedProcedure('ops:write', guards)
        .input(z.object({}).passthrough().optional())
        .mutation(({ input }) => {
          try {
            ops.wrapKeys((input ?? {}) as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
      execute: scopedProcedure('ops:write', guards)
        .input(z.object({}).passthrough().optional())
        .mutation(({ input }) => {
          try {
            ops.executeApproval((input ?? {}) as Record<string, unknown>);
          } catch (err) {
            mapError(err);
          }
        }),
      ops: router({
        status: scopedProcedure('admin:read', guards)
          .output(
            z.object({
              asOf: z.string(),
              wrap: custodyWrapSchema,
              freeze: custodyFreezeSchema,
              tiers: z.array(
                z.object({
                  id: custodyTierId,
                  keyCount: z.null(),
                  code: z.literal(OPS_CUSTODY_KEYS_UNPUBLISHED),
                }),
              ),
              pendingApprovals: z.array(custodyApprovalSchema),
              balances: z.object({
                status: z.literal('unconfigured'),
                code: z.literal(OPS_CUSTODY_LEDGER_UNWIRED),
              }),
            }),
          )
          .query(() => custodyOpsStatus(ops.listCustody(), now())),
        createApproval: scopedProcedure('admin:treasury', guards)
          .input(
            z.object({
              fromTier: z.string(),
              toTier: z.string(),
              amount: z.string().nullable().optional(),
              idempotencyKey: z.string(),
            }),
          )
          .output(custodyApprovalSchema)
          .mutation(({ input }) => {
            try {
              const key = assertIdempotencyKey(input.idempotencyKey);
              const fingerprint = JSON.stringify({
                fromTier: input.fromTier,
                toTier: input.toTier,
                amount: input.amount ?? null,
              });
              const prior = takeIdempotent(idem, `custody:${key}`, fingerprint);
              if (prior) return prior as z.infer<typeof custodyApprovalSchema>;
              const created = ops.createApproval(input);
              return rememberIdempotent(idem, `custody:${key}`, fingerprint, created) as z.infer<typeof custodyApprovalSchema>;
            } catch (err) {
              return deskError(err);
            }
          }),
        execute: scopedProcedure('admin:treasury', guards)
          .input(z.object({ id: z.string().optional(), idempotencyKey: z.string().optional() }).optional())
          .mutation(({ input }) => {
            try {
              ops.executeApproval((input ?? {}) as Record<string, unknown>);
            } catch (err) {
              deskError(err);
            }
          }),
      }),
    }),

    restore: router({
      watermarks: scopedProcedure('admin:read', guards)
        .output(
          z.object({
            asOf: z.string(),
            archive: z.object({
              configured: z.boolean(),
              probed: z.literal(false),
              code: z.enum([OPS_RESTORE_ARCHIVE_UNCONFIGURED, OPS_RESTORE_ARCHIVE_UNPROBED]),
            }),
            watermarks: z
              .object({
                stamped: z.boolean(),
                rows: z.array(
                  z.object({
                    service: z.string(),
                    kind: z.string(),
                    watermark: z.string(),
                    recordedAt: z.string(),
                    recordedBy: z.string(),
                    approverId: z.string(),
                  }),
                ),
              })
              .nullable(),
            storage: z.object({ configured: z.boolean(), code: z.literal(OPS_RESTORE_STORAGE_UNCONFIGURED).optional() }),
            restored: z.literal(false),
          }),
        )
        .query(async () => {
          try {
            const store = desks.restoreStamps;
            const read = restoreWatermarksRead(desks.restoreArchiveUrl, store ? await store.list() : [], now());
            return store
              ? { ...read, storage: { configured: true } }
              : { ...read, watermarks: null, storage: { configured: false, code: OPS_RESTORE_STORAGE_UNCONFIGURED } };
          } catch (err) {
            mapError(err);
          }
        }),
      // A blank URL is unconfigured. A probe that fails or is unwired stays unprobed. A manifest is listed as returned.
      backups: scopedProcedure('admin:read', guards).query(async () => {
        const archive = archivePosture(desks.restoreArchiveUrl);
        if (!archive.configured || !desks.restoreArchiveProbe || desks.restoreArchiveUrl == null) {
          return { asOf: now(), archive, backups: [] as const, reason: archive.code };
        }
        let probed: RestoreArchiveProbeResult;
        try {
          probed = await desks.restoreArchiveProbe(desks.restoreArchiveUrl);
        } catch {
          probed = { probed: false };
        }
        if (!probed.probed) {
          return { asOf: now(), archive, backups: [] as const, reason: OPS_RESTORE_ARCHIVE_UNPROBED };
        }
        return {
          asOf: now(),
          archive: { configured: true as const, probed: true as const, code: null },
          backups: probed.backups,
          reason: probed.backups.length === 0 ? 'The archive listed no backups.' : 'The archive listed these backups.',
        };
      }),
      runs: scopedProcedure('admin:read', guards).query(async () => {
        try {
          return { asOf: now(), runs: [...(await requireRestoreDesk(desks.restoreDesk).list())] };
        } catch (err) {
          mapError(err);
        }
      }),
      run: scopedProcedure('admin:read', guards)
        .input(z.object({ restoreNo: z.string().min(1).max(128) }))
        .query(async ({ input }) => {
          try {
            return await requireRestoreDesk(desks.restoreDesk).get(input.restoreNo);
          } catch (err) {
            mapError(err);
          }
        }),
      start: scopedProcedure('admin:treasury', guards)
        .input(z.object({ restoreNo: z.string().min(1).max(128), cutOff: z.string(), idempotencyKey: z.string() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await requireRestoreDesk(desks.restoreDesk).start({ ...input, actor: ctx.principal.userId });
          } catch (err) {
            deskError(err);
          }
        }),
      step: scopedProcedure('admin:treasury', guards)
        .input(
          z.object({
            restoreNo: z.string().min(1).max(128),
            step: z.enum(['restore_clean', 'validate', 'preview']),
            idempotencyKey: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            return await requireRestoreDesk(desks.restoreDesk).step({ ...input, actor: ctx.principal.userId });
          } catch (err) {
            deskError(err);
          }
        }),
      finalize: scopedProcedure('admin:treasury', guards)
        .input(
          z.object({
            restoreNo: z.string().min(1).max(128),
            idempotencyKey: z.string(),
            approvalId: z.string(),
            operationId: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            return await requireRestoreDesk(desks.restoreDesk).finalize({ ...input, actor: ctx.principal.userId });
          } catch (err) {
            deskError(err);
          }
        }),
      record: scopedProcedure('admin:treasury', guards)
        .input(
          z.object({
            service: z.string(),
            kind: z.string(),
            watermark: z.string(),
            idempotencyKey: z.string(),
            approvalId: z.string(),
            operationId: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const posture = archivePosture(desks.restoreArchiveUrl);
            if (!posture.configured) {
              throw new OpsError(
                OPS_RESTORE_ARCHIVE_UNCONFIGURED,
                'No joint-restore archive is configured. A watermark is not stamped, and nothing is marked restored.',
              );
            }
            const store = desks.restoreStamps;
            if (!store) {
              throw new OpsError(
                OPS_RESTORE_STORAGE_UNCONFIGURED,
                'No durable storage is configured for restore stamps. A watermark is not stamped, and nothing is marked restored.',
              );
            }
            const key = assertIdempotencyKey(input.idempotencyKey);
            const parsed = parseWatermarkInput(input);
            const fingerprint = stampFingerprint({ ...parsed, approvalId: input.approvalId, operationId: input.operationId });
            const stored = await store.find(key, fingerprint);
            if (stored) return { ...stored, archive: posture, restored: false as const };
            const consumed = await consumeFounderApproval(desks.approvals, {
              approvalId: input.approvalId,
              operationId: input.operationId,
              actionType: 'ops.restore.record',
              targetService: 'svc-ops',
              targetId: `watermark:${parsed.service}:${parsed.kind}`,
              fields: parsed,
              requesterId: ctx.principal.userId,
            });
            const row: WatermarkStamp = {
              ...parsed,
              recordedAt: now(),
              recordedBy: consumed.requesterId,
              approverId: consumed.approverId ?? '',
            };
            const kept = await store.append(key, fingerprint, row);
            return { ...kept, archive: posture, restored: false as const };
          } catch (err) {
            deskError(err);
          }
        }),
    }),

    // admin:read, not ops:read: the report is operator-only, and ops:read is held by ordinary sessions.
    venueEconomics: scopedProcedure('admin:read', guards)
      .input(z.object({ period: z.string() }))
      .output(opsVenueEconomicsSchema)
      .query(async ({ input }) => {
        try {
          const store = requireVenueCosts(desks.venueCosts);
          const period = parseCostPeriod(input.period);
          const [revenue, entries, fees] = await Promise.all([
            readRevenue(() => ops.revenue()),
            store.list(period),
            readFeeRevenue(desks.feeRevenue, period),
          ]);
          return composeVenueEconomics(now(), period, revenue, entries, fees);
        } catch (err) {
          mapError(err);
        }
      }),
    recordVenueCost: scopedProcedure('admin:write', guards)
      .input(opsCostEntryInputSchema)
      .output(opsCostEntrySchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const fields = parseCostEntry(input);
          const store = requireVenueCosts(desks.venueCosts);
          const key = assertIdempotencyKey(input.idempotencyKey);
          const fingerprint = costFingerprint({ ...fields, approvalId: input.approvalId, operationId: input.operationId });
          const stored = await store.find(key, fingerprint);
          if (stored) return stored;
          const consumed = await consumeFounderApproval(desks.approvals, {
            approvalId: input.approvalId,
            operationId: input.operationId,
            actionType: 'ops.venue_cost.record',
            targetService: 'svc-ops',
            targetId: `venue-cost:${fields.period}:${fields.category}`,
            fields: { ...fields },
            requesterId: ctx.principal.userId,
          });
          return await store.append(key, fingerprint, fields, {
            enteredBy: consumed.requesterId,
            approverId: consumed.approverId ?? '',
            enteredAt: now(),
          });
        } catch (err) {
          return deskError(err);
        }
      }),

    protocolListing: createProtocolListingRouter(desks.protocolListing),

    home: createHomeConfigRouter(desks.homeConfig ?? homeConfigFromEnv({})),

    alertRules: createAlertRulesRouter(desks.alertRules, desks.alertState),

    compliance: createComplianceRouter(desks.compliance, now),

    consoleMode: createConsoleModeRouter(new ConsoleModeDesk({ store: desks.consoleMode, approvals: desks.approvals, now })),

    announcements: createAnnouncementsRouter(new AnnouncementDesk({ store: desks.announcements, now })),

    preferences: createPreferencesRouter({ store: desks.preferences, now }),

    services: createServiceRecordsRouter({ store: desks.serviceRecords, now }),

    staffHolds: createStaffHoldsRouter(
      desks.staffHolds ??
        new StaffHoldDesk({
          store: undefined,
          ledger: undefined,
          approvals: desks.approvals,
          settings: { confirmAccount: null, expiryMaxHours: null },
          now: () => new Date(),
        }),
    ),

    alerts: router({
      ...reconciliationAlertRoutes,
      activity: alertDeskRoutes.activity,
      heartbeat: alertDeskRoutes.heartbeat,
      heartbeatStatus: alertDeskRoutes.heartbeatStatus,
    }),

    alertTemplates: alertDeskRoutes.templates,
    alertQuality: alertDeskRoutes.quality,
  });
}

export type OpsRouter = ReturnType<typeof createOpsRouter>;

/** Grep anchor for the shell golden. */
export const WAREHOUSE_UNWIRED = OPS_WAREHOUSE_UNWIRED;
export const PAYROLL_INVENT_FORBIDDEN = OPS_PAYROLL_INVENT_FORBIDDEN;
export const FUNDRAISING_CHAIN_UNWIRED = OPS_FUNDRAISING_CHAIN_UNWIRED;
export const CUSTODY_WRAP_UNSET = OPS_CUSTODY_WRAP_UNSET;
export const CUSTODY_CHAIN_UNWIRED = OPS_CUSTODY_CHAIN_UNWIRED;
export const CUSTODY_KEYS_FORBIDDEN = OPS_CUSTODY_KEYS_FORBIDDEN;
export const CUSTODY_FREEZE_UNSET = OPS_CUSTODY_FREEZE_UNSET;
export const CUSTODY_FROZEN = OPS_CUSTODY_FROZEN;
