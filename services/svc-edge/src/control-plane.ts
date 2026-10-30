import type { FastifyInstance } from 'fastify';
import { AuthError, type Principal } from '@intafaced/auth';
import {
  checkNetworkAccess,
  type ComplianceQueueDispositionRequest,
  type ComplianceQueueItem,
  type ComplianceQueueKind,
} from '@intafaced/config';
import { InvalidControlBodyError, statusForAuthError, type AdminApi } from './admin-api.js';
import type { MatchingOperatorCall, MatchingOperatorPath } from './matching-operator-door.js';
import { DualControlError } from './dual-control.js';
import { ActionApprovalConsumeError, edgeActionPayloadHash, readApprovalIds } from './action-approval-consume.js';
import { evaluateGeoBlock, geoBlockErrorMessage, geoBlockHttpStatus, geoBlockOpsHttpStatus, geoBlockPublicBody } from './geo-block.js';
import { resolveRequestRegion, regionResolutionStatusLine } from './geo-region.js';
import { resolvedPathname, type KillSwitchState } from './kill-switch.js';
import { isS2sPath, resolve } from './routes.js';
import { describeQuantHonestyDoorStatus } from './quant-honesty-status.js';
import { registerQuantCompositeHonestyRoutes } from './quant-composite-honesty-door.js';
import { registerQuantHonestyRoutes } from './quant-honesty-door.js';
import { registerQuantSurfaceRenderRoutes } from './quant-surface-render-door.js';
import { registerExecutionArbScanConsumerRoutes } from './execution-arb-scan-consumer-door.js';
import { registerExecutionOmsConsumerRoutes } from './execution-oms-consumer-door.js';
import { registerConnectDataLakePersistConsumerRoutes } from './connect-data-lake-persist-consumer-door.js';
import { userCopy } from './user-copy.js';

const QUEUE_KINDS = new Set<ComplianceQueueKind>(['screening_hit', 'kyc_review', 'network_flag', 'manual']);

function geoBlockStatus(region: string) {
  const decision = evaluateGeoBlock({ region });
  return {
    allowed: decision.allowed,
    code: decision.code,
    reason: decision.reason,
    screeningDeclaration: decision.screeningDeclaration,
    screeningConfigured: decision.screeningConfigured,
    listHitCount: decision.listHitCount,
    inventedBlockedList: false as const,
    regionResolved: decision.regionResolved,
    enforcedOnApiPath: true,
  };
}

/**
 * Parse disposition body for the compliance queue. Unknown status refuses closed.
 */
export function parseComplianceDisposition(
  body: {
    status?: string;
    reason?: string;
    partnerRef?: string;
  },
  authenticatedActor: string,
): ComplianceQueueDispositionRequest {
  const status = body.status?.trim();
  if (status === 'pending') return { status: 'pending' };
  if (status === 'cleared') {
    return { status: 'cleared', by: 'operator', actor: authenticatedActor };
  }
  if (status === 'rejected') {
    return { status: 'rejected', by: 'operator', actor: authenticatedActor, reason: body.reason ?? '' };
  }
  if (status === 'partner_cleared') {
    return { status: 'partner_cleared', partnerRef: body.partnerRef ?? '' };
  }
  throw new Error(`compliance disposition status must be pending|cleared|rejected|partner_cleared — got ${JSON.stringify(status)}`);
}

/**
 * THE OPERATOR CONTROL PLANE, AS SOMETHING A TEST CAN DRIVE (§14.6).
 *
 * `index.ts` reads `env` and calls `app.listen()` at module scope, so importing
 * it from a test means booting the real edge against real upstreams. That is why
 * the enforcement rule and the admin routes live here instead: `index.ts`
 * registers them, and a test registers the same two functions on its own Fastify
 * instance with a stub upstream behind them.
 *
 * The point of doing it this way rather than unit-testing `decide()` alone —
 * which `kill-switch.test.ts` also does — is that the interesting failures were
 * never in the rule. They were in the wiring: a prefix that mapped to no module,
 * a release path the rule never saw, a switch nothing could reach. Those are
 * only visible to a request that actually crosses the HTTP boundary.
 */

/**
 * The kill-switch, as an `onRequest` hook.
 *
 * A hook rather than a check inside the proxy handler, for two reasons that both
 * matter during an incident:
 *
 *   · It runs BEFORE body parsing and before the principal exchange, so a killed
 *     module costs the platform nothing per request — no signature verification,
 *     no upstream round trip, no JSON parse of a payload that is going to be
 *     refused anyway.
 *   · It cannot be bypassed by a route added later. A guard written inside one
 *     handler protects that handler; a hook protects the door.
 *
 * Non-`/api` paths are ignored, which is what keeps the hook off `/admin/*`,
 * `/health` and `/ready`. An operator must be able to reach the control plane
 * while modules are killed — otherwise the switch that halted the platform
 * cannot be used to un-halt it — and a load balancer must still get an answer
 * from `/ready`.
 */
export function registerKillSwitchGuard(app: FastifyInstance, killSwitches: KillSwitchState): void {
  app.addHook('onRequest', async (req, reply) => {
    /**
     * Resolved with the SAME parser the proxy uses — see `resolvedPathname`.
     *
     * Splitting the raw target here and letting `index.ts` re-parse it with
     * `new URL` gave the guard and the handler two different answers about
     * which module a request was for, and `/api/trade/../identity/...` walked
     * through a halted identity service on the difference.
     *
     * Null means no single answer exists (a dot segment we cannot resolve on
     * the upstream's behalf, or a malformed escape). Refused for EVERY path,
     * not just `/api/`, because a request nobody can route is not one the
     * control plane should be answering either.
     */
    const pathname = resolvedPathname(req.url);
    if (pathname === null) {
      req.log.warn({ rawUrl: req.url }, 'edge: refused — the path cannot be resolved to one upstream');
      return reply.code(400).send({
        error: userCopy('edge.unresolvable_path'),
        code: 'edge.unresolvable_path',
      });
    }

    if (!pathname.startsWith('/api/')) return;

    /**
     * Service-to-service `/internal/*` is not a public route. Pay jobs, token stake, identity
     * rank, bank cron — all sit at that path behind a service secret the edge
     * does not hold and will not forward. Refuse here, before the kill-switch
     * and before the proxy, so a live module cannot 200 a service job from the
     * internet. 404 + `edge.s2s_not_proxied`, never a green pass-through.
     */
    const routed = resolve(pathname);
    if (routed && isS2sPath(routed.path)) {
      req.log.warn({ path: pathname, module: routed.upstream.module }, 'edge: refused — service path is not a public door');
      return reply.code(404).send({ error: userCopy('edge.s2s_not_proxied'), code: 'edge.s2s_not_proxied' });
    }

    /**
     * FAIL CLOSED, TWICE.
     *
     * `KillSwitchState.decide` already catches its own failures and returns
     * `undecidable`. This second catch is not belt-and-braces for its own sake:
     * it covers the case where the state OBJECT is broken or replaced — a future
     * durable store whose client throws on a dropped connection, say — and so it
     * holds the property regardless of what `decide` is.
     *
     * A safety control that opens when its own check errors is worse than no
     * control at all: the operator believes the market is halted, the console
     * says it is halted, and orders are being accepted.
     */
    let decision;
    try {
      decision = killSwitches.decide(pathname, req.method);
    } catch {
      decision = { module: null, refused: true, reason: 'undecidable' as const };
    }

    if (!decision.refused) return;

    // `undecidable` means the switch's own check threw and it failed closed.
    // Logged at error and given its own code, because "refused because an
    // operator said so" and "refused because we could not tell" call for
    // completely different responses at 3am.
    if (decision.reason === 'undecidable') {
      req.log.error({ path: pathname }, 'edge: kill-switch check failed — refusing, failing closed');
      return reply
        .code(503)
        .header('retry-after', '30')
        .send({
          error: userCopy('edge.kill_switch_undecidable'),
          code: 'edge.kill_switch_undecidable',
        });
    }

    req.log.warn({ module: decision.module, path: pathname }, 'edge: refused — module killed by operator');
    // 503 with `retry-after`, not 403: this is a temporary operational state, and
    // a client that reads 403 as "you may never do this" will stop retrying once
    // the incident is over.
    //
    // Wave 13: halt codes residual — operatorReason + haltCode so a client never
    // confuses "module killed" with undecidable/network refuse.
    const operatorReason = decision.module != null ? (killSwitches.reasonFor(decision.module) ?? null) : null;
    return reply
      .code(503)
      .header('retry-after', '30')
      .send({
        error: userCopy('edge.module_killed'),
        code: 'edge.module_killed',
        module: decision.module,
        haltCode: decision.reason,
        operatorReason,
      });
  });
}

/**
 * Geo-block on the product door (`/api/*`).
 *
 * Unset / empty screening is unknown — not a geo-clearance and not an invented
 * block list. Admin / health / ready stay open so operators can see why.
 * Does not invent sanctions content (Class X).
 */
export function registerGeoBlockGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const pathname = resolvedPathname(req.url);
    if (pathname === null) return;
    if (!pathname.startsWith('/api/')) return;

    const region = resolveRequestRegion({
      defaultRegion: process.env.DEFAULT_REGION ?? 'XX',
      trustProxy: process.env.EDGE_TRUST_PROXY !== undefined && process.env.EDGE_TRUST_PROXY !== '',
      geoHeaderName: process.env.EDGE_GEO_COUNTRY_HEADER,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    const decision = evaluateGeoBlock({ region: region.region });
    if (decision.allowed) return;

    req.log.warn(
      {
        path: pathname,
        code: decision.code,
        declaration: decision.screeningDeclaration,
        region: decision.region,
      },
      'edge: refused — geo-block / empty screening',
    );
    return reply.code(geoBlockHttpStatus(decision)).send(geoBlockPublicBody(decision));
  });
}

/**
 * Network-signal fail-closed guard on the product door (`/api/*`).
 *
 * Status already surfaces unset≠clear (#1582). Product Done bar: when
 * INTAFACED_NETWORK_SIGNAL_FAIL_CLOSED is armed, traffic refuses with a typed
 * code — not silent allow. Does not invent a VPN partner (Class X).
 *
 * Admin / health / ready stay open so operators can still see why the door is
 * closed and un-arm the switch.
 */
export function registerNetworkAccessGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const pathname = resolvedPathname(req.url);
    if (pathname === null) return; // kill-switch path already refused unresolvable
    if (!pathname.startsWith('/api/')) return;

    const access = checkNetworkAccess(process.env);
    if (access.allowed) return;

    const edgeCode =
      access.code === 'denied.network_flagged'
        ? 'edge.network_flagged'
        : access.code === 'denied.network_dark'
          ? 'edge.network_dark'
          : 'edge.network_unconfigured';

    req.log.warn(
      { path: pathname, networkCode: access.code, declaration: access.signal.declaration },
      'edge: refused — network signal fail-closed',
    );
    return reply
      .code(503)
      .header('retry-after', '30')
      .send({
        error: userCopy(edgeCode),
        code: edgeCode,
        networkCode: access.code,
        declaration: access.signal.declaration,
      });
  });
}

/**
 * The `/admin/*` routes.
 *
 * Registered explicitly, and deliberately OUTSIDE `/api/*`: `resolve()` returns
 * null for `/admin/...`, so if one of these were missing it would 404 rather
 * than fall through to an upstream. The catch-all proxy is never what decides
 * whether an admin path is real.
 */
export function registerAdminRoutes(app: FastifyInstance, admin: AdminApi, matching: MatchingOperatorCall | null = null): void {
  // Public §29 honesty door — not proxied to svc-quant (that service must not exist yet).
  registerQuantHonestyRoutes(app);
  registerQuantSurfaceRenderRoutes(app);
  registerQuantCompositeHonestyRoutes(app);
  registerExecutionArbScanConsumerRoutes(app, (header) => admin.authenticate(header));
  registerExecutionOmsConsumerRoutes(app, (header) => admin.authenticate(header));
  registerConnectDataLakePersistConsumerRoutes(app, (header) => admin.authenticate(header));
  /**
   * Authenticate, or answer. Returns null when it has already replied, so a
   * handler cannot forget to stop.
   */
  const operator = async (
    header: string | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    kind: 'module' | 'treasury' | 'lookup',
  ) => {
    try {
      const authenticate = { module: admin.authenticate, treasury: admin.authenticateTreasury, lookup: admin.authenticateLookup }[kind];
      const principal = await authenticate(header);
      return { principal, bearer: header as string };
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(statusForAuthError(err)).send({ error: err.message, code: err.code });
        return null;
      }
      throw err;
    }
  };

  /**
   * One-shot control-plane summary for operators and status probes (A-P5-OPS).
   *
   * Deliberately `admin:write` only: this does not move freeze state and must not
   * require treasury just to see whether the door is armed. `ledgerConfigured`
   * is a boolean, not a freeze read — freeze status still needs treasury.
   */
  app.get('/admin/status', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    const snap = admin.read();
    const honesty = admin.honesty();
    const ops = admin.opsHonesty();
    const region = resolveRequestRegion({
      defaultRegion: process.env.DEFAULT_REGION ?? 'XX',
      trustProxy: process.env.EDGE_TRUST_PROXY !== undefined && process.env.EDGE_TRUST_PROXY !== '',
      geoHeaderName: process.env.EDGE_GEO_COUNTRY_HEADER,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    return {
      ok: true,
      service: 'svc-edge',
      controlPlane: 'operator-kill-switch',
      disabledModules: snap.disabledModules,
      disabledCount: snap.disabledModules.length,
      reasons: snap.reasons,
      auditCount: snap.audit.length,
      lastChange: snap.audit[0] ?? null,
      ledgerConfigured: admin.ledgerConfigured(),
      // Modules this edge cannot halt — `ws` is the one that used to look green
      // while the market-data socket stayed live (SOCKET §13 socket.ws-behind-the-edge).
      outsideTheDoor: honesty.outsideTheDoor,
      enforceableModules: honesty.enforceableModules,
      // File and memory stay process-local. multiReplicaShared is true only when
      // a shared kill store is attached; status must not call a local file fleet-wide.
      killState: honesty.killState,
      // Live kill is the operator surface — not the drop-I `edge.gateway` flag
      // (still NOT_ENFORCED until a deliberate enforcement PR). Status must say
      // so out loud so a console never invents a flag-only halt.
      liveKillControl: honesty.liveKillControl,
      flagEdgeGateway: honesty.flagEdgeGateway,
      killMutateDualControl: honesty.killMutateDualControl,
      // Reminder for operators reading JSON at 3am — full path list is in the runbook.
      releaseRule: 'reads and cancels pass under a kill; new commitments refuse (503 edge.module_killed)',
      // ── ops.compliance / ops.analytics residual (wave 10 + 13) ────────────
      // #1551 mechanisms at the door: unset≠clear, invent freeze refuse,
      // partner_cleared refuse, warehouse dark — never silent green ticks.
      // Wave 13: region source honesty + network fail-closed on /api path.
      region: {
        code: region.region,
        regionResolved: region.regionResolved,
        source: region.source,
        headerName: region.headerName,
        statusLine: regionResolutionStatusLine(region),
        note: region.note,
      },
      // Geo-block honesty: unset/empty screening is unknown, never a clearance.
      geoBlock: geoBlockStatus(region.region),
      networkSignal: {
        declaration: ops.network.signal.declaration,
        partnerConfigured: ops.network.signal.partnerConfigured,
        kind: ops.network.signal.kind,
        statusLine: ops.network.statusLine,
        accessAllowed: ops.network.access.allowed,
        accessCode: ops.network.access.code,
        summary: ops.network.signal.summary,
        enforcedOnApiPath: true,
      },
      freezeAuthority: {
        soleKey: ops.freeze.soleKey,
        note: ops.freeze.note,
        authorities: ops.freeze.authorities,
        inventTradeFreezeOk: ops.freeze.inventProbes['trade freeze'].ok,
        inventPayFreezeOk: ops.freeze.inventProbes['pay freeze'].ok,
        ledgerPostingOk: ops.freeze.inventProbes['ledger.posting'].ok,
      },
      complianceQueue: {
        empty: ops.complianceQueue.empty,
        pending: ops.complianceQueue.items.length,
        partnerConfigured: ops.complianceQueue.partnerConfigured,
        summary: ops.complianceQueue.summary,
      },
      analytics: {
        replicaConfigured: ops.analytics.replicaConfigured,
        replicaCount: ops.analytics.replicaCount,
        refuse: ops.analytics.refuse,
        surfaceStatus: ops.analytics.surface.status,
        mayLabelLive: ops.analytics.surface.mayLabelLive,
        statusLine: ops.analytics.statusLine,
        etlWatermark: ops.analytics.etlWatermark,
        etlWatermarkAt: ops.analytics.etlWatermarkAt,
        etlNote: ops.analytics.etlNote,
      },
      quantHonesty: describeQuantHonestyDoorStatus(),
    };
  });

  /**
   * Geo-block probe — refuse with a typed code when screening is unset/empty.
   * 409, not 200 green. Never invents a sanctions list.
   */
  app.get('/admin/compliance/geo-block', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    const region = resolveRequestRegion({
      defaultRegion: process.env.DEFAULT_REGION ?? 'XX',
      trustProxy: process.env.EDGE_TRUST_PROXY !== undefined && process.env.EDGE_TRUST_PROXY !== '',
      geoHeaderName: process.env.EDGE_GEO_COUNTRY_HEADER,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    const decision = evaluateGeoBlock({ region: region.region });
    const status = geoBlockOpsHttpStatus(decision);
    if (status !== 200) {
      return reply.code(status).send({
        ok: false,
        error: geoBlockErrorMessage(decision),
        code: decision.code,
        reason: decision.reason,
        region: decision.region,
        screeningDeclaration: decision.screeningDeclaration,
        screeningConfigured: decision.screeningConfigured,
        inventedBlockedList: false,
        regionResolved: decision.regionResolved,
      });
    }
    return {
      ok: true,
      code: decision.code,
      reason: decision.reason,
      region: decision.region,
      screeningDeclaration: decision.screeningDeclaration,
      screeningConfigured: decision.screeningConfigured,
      listHitCount: decision.listHitCount,
      inventedBlockedList: false,
      regionResolved: decision.regionResolved,
    };
  });

  /**
   * Compliance queue snapshot — honest empty when nothing pending.
   * partnerConfigured follows screening list posture (never invents a vendor).
   */
  app.get('/admin/compliance/queue', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    try {
      return admin.complianceQueueSnapshot();
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message, code: 'edge.compliance_queue_unreadable' });
    }
  });

  /**
   * Open a screening/review case. Never auto-invented — empty stays empty until
   * an operator (or future intake path) opens explicitly.
   */
  app.post('/admin/compliance/queue/open', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'module');
    if (!auth) return reply;

    const body = (req.body ?? {}) as {
      id?: string;
      kind?: string;
      subjectId?: string;
      openedAt?: string;
    };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
    const subjectId = typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
    if (id === '' || subjectId === '' || !QUEUE_KINDS.has(kind as ComplianceQueueKind)) {
      return reply.code(400).send({
        error: 'id, subjectId, and kind (screening_hit|kyc_review|network_flag|manual) required',
        code: 'edge.invalid_compliance_open',
      });
    }

    const item: ComplianceQueueItem = {
      id,
      kind: kind as ComplianceQueueKind,
      subjectId,
      openedAt: typeof body.openedAt === 'string' && body.openedAt.trim() !== '' ? body.openedAt.trim() : new Date().toISOString(),
    };

    try {
      const queue = admin.openComplianceCase(item);
      req.log.warn({ operator: auth.principal.userId, itemId: id, kind }, 'edge: compliance queue open');
      return queue;
    } catch (err) {
      const message = (err as Error).message;
      const conflict = /already open/i.test(message);
      return reply
        .code(conflict ? 409 : 400)
        .send({ error: message, code: conflict ? 'edge.compliance_case_exists' : 'edge.invalid_compliance_open' });
    }
  });

  /**
   * Disposition a queue item. Hostile path blocked here too: partner_cleared
   * without screening partner → 409 refuse.partner_absent (not 200 green).
   */
  app.post('/admin/compliance/queue/disposition', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'module');
    if (!auth) return reply;

    const body = (req.body ?? {}) as {
      itemId?: string;
      status?: string;
      reason?: string;
      partnerRef?: string;
      approvalId?: string;
      operationId?: string;
    };
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
    if (itemId === '') {
      return reply.code(400).send({ error: 'itemId required', code: 'edge.invalid_compliance_disposition' });
    }

    let request;
    try {
      // Attribution comes from the verified token. A caller-supplied `actor`
      // field is deliberately ignored so one operator cannot forge another's
      // identity into the case audit trail.
      request = parseComplianceDisposition(body, auth.principal.userId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message, code: 'edge.invalid_compliance_disposition' });
    }

    let approverId: string | null = null;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (request.status === 'cleared' || request.status === 'rejected') {
      if (reason.length < 12) {
        return reply.code(400).send({
          error: 'A disposition reason of at least 12 characters is required and is stored with the decision.',
          code: 'edge.compliance_reason_required',
        });
      }
      try {
        const ids = readApprovalIds(body);
        const consumed = await admin.consumeApproval(
          {
            approvalId: ids.approvalId,
            operationId: ids.operationId,
            payloadHash: edgeActionPayloadHash('edge.compliance_disposition', { itemId, status: request.status, reason }),
            targetService: 'svc-edge',
            targetId: `disposition:${itemId}`,
            expectedVersion: '1',
          },
          auth.principal,
        );
        if (!consumed.approverId || consumed.approverId === auth.principal.userId) {
          return reply.code(400).send({
            error: 'The approver must be a different person from the operator who runs the disposition.',
            code: 'action_approval.same_person',
          });
        }
        approverId = consumed.approverId;
      } catch (err) {
        if (err instanceof ActionApprovalConsumeError) return reply.code(400).send({ error: err.message, code: err.code });
        return reply.code(400).send({ error: (err as Error).message, code: 'edge.invalid_compliance_disposition' });
      }
    }

    const result = admin.disposeComplianceCase(itemId, request, { approverId, reason: reason || null });
    if (!result.ok) {
      // 409: the case may exist, but this disposition is refused (partner absent).
      return reply.code(409).send({ error: result.reason, code: result.code, ok: false });
    }
    req.log.warn(
      { operator: auth.principal.userId, itemId, status: result.status, actor: result.actor },
      'edge: compliance queue disposition',
    );
    return { ...result, approverId, queue: admin.complianceQueueSnapshot() };
  });

  /**
   * Screening subject intake. There is no subject feed on this edge: the
   * geo-block verdict is for the caller's own request. This door refuses
   * rather than opening a case from that verdict.
   */
  app.post('/admin/compliance/queue/intake', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    return reply.code(409).send({
      error:
        'No screening subject feed is configured. The geo-block verdict is for this request only, so no compliance case is opened from it.',
      code: 'edge.screening_subject_feed_unconfigured',
    });
  });

  /** Population geo-block. The mounted verdict is this request. No counts. */
  app.get('/admin/compliance/geo-population', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    return reply.code(409).send({
      error:
        'Geo-block on this edge is the verdict for this request only. No population screening source is configured, so no region counts are returned.',
      code: 'edge.geo_population_unconfigured',
      scope: 'request',
    });
  });

  /**
   * Analytics warehouse door — real replica lag probe when URLs are set.
   * Absent URL / connect fail / not-a-standby → unknown, never invented live.
   * ETL watermark is operator-stamped or honestly absent (does not paint live).
   */
  app.get('/admin/analytics/warehouse', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    return admin.probeWarehouse();
  });

  app.get('/admin/kill-switches', async (req, reply) => {
    if (!(await operator(req.headers.authorization, reply, 'module'))) return reply;
    return admin.read();
  });

  app.post('/admin/kill-switches', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'module');
    if (!auth) return reply;

    let result;
    try {
      result = await admin.apply(req.body, auth.principal);
    } catch (err) {
      if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      return reply.code(400).send({ error: (err as Error).message, code: 'edge.invalid_kill_switch' });
    }

    // WARN, not INFO. Somebody reading logs after an incident is looking for
    // exactly this line, and it carries who, what, why and the prior state.
    req.log.warn(
      {
        operator: auth.principal.userId,
        confirmOperatorId: result.confirmOperatorId,
        body: req.body,
        state: result.disabledModules,
        entry: result.audit[0],
      },
      'edge: kill-switch changed',
    );
    return result;
  });

  /**
   * The ledger freeze — the switch that halts ALL value movement (§4.2).
   *
   * `admin:treasury`, not `admin:write`: halting one market and halting the
   * money plane are different authorities and must not share a credential.
   * Forwarded to svc-ledger with the operator's OWN token, so
   * `posting_freeze.actor` is written from svc-ledger's own verification and the
   * edge cannot cause a freeze attributed to anybody else.
   *
   * Whatever svc-ledger answers is passed through unchanged, including its
   * failures. The edge must never turn a refused or unconfirmed freeze into a
   * 200 — an operator told the platform is halted when it is not is worse off
   * than one told nothing at all.
   */
  app.get('/admin/ledger/freeze', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    const res = await admin.readFreeze(auth.bearer);
    return reply.code(res.status).send(res.body);
  });

  app.post<{ Params: { action: string } }>('/admin/ledger/:action', async (req, reply) => {
    const action = req.params.action;
    if (action !== 'freeze' && action !== 'unfreeze') {
      return reply.code(404).send({ error: 'no route', code: 'edge.no_route' });
    }

    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;

    let res;
    try {
      res = await admin.setFreeze(action === 'freeze', req.body, auth.bearer);
    } catch (err) {
      if (err instanceof ActionApprovalConsumeError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      return reply.code(400).send({ error: (err as Error).message, code: 'edge.invalid_freeze_request' });
    }

    req.log.warn({ operator: auth.principal.userId, action, status: res.status }, 'edge: LEDGER FREEZE state change requested');
    return reply.code(res.status).send(res.body);
  });

  /**
   * Last successful reconciliation this edge proxied. Never a zero book.
   * A deployment with no ledger URL refuses with edge.ledger_unreachable.
   */
  app.get('/admin/ledger/reconcile', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    const res = await admin.readReconcile();
    return reply.code(res.status).send(res.body);
  });

  app.post('/admin/ledger/reconcile', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    let res;
    try {
      res = await admin.runReconcile(req.body, auth.bearer);
    } catch (err) {
      if (err instanceof ActionApprovalConsumeError) return reply.code(400).send({ error: err.message, code: err.code });
      return reply.code(400).send({ error: (err as Error).message, code: 'edge.invalid_reconcile_request' });
    }
    req.log.warn({ operator: auth.principal.userId, status: res.status }, 'edge: LEDGER RECONCILE requested');
    return reply.code(res.status).send(res.body);
  });

  /**
   * Operator reconciliation controls. Forwarded with the operator's own token.
   * List and runs are treasury or compliance. Define, update and run are treasury (MFA).
   * Run's body carries the reason and the approval. svc-ledger's answer passes through.
   */
  app.get('/admin/ledger/reconciliation/controls', async (req, reply) => {
    try {
      await admin.authenticateControlRead(req.headers.authorization);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(statusForAuthError(err)).send({ error: err.message, code: err.code });
      throw err;
    }
    const header = req.headers.authorization;
    if (typeof header !== 'string') return reply.code(401).send({ error: 'An operator token is required', code: 'token.invalid' });
    const res = await admin.listReconciliationControls(header);
    return reply.code(res.status).send(res.body);
  });

  /** One control's evaluations, newest first. Read-only, so the list rule applies: treasury (MFA) or compliance. */
  app.post('/admin/ledger/reconciliation/controls/runs', async (req, reply) => {
    try {
      await admin.authenticateControlRead(req.headers.authorization);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(statusForAuthError(err)).send({ error: err.message, code: err.code });
      throw err;
    }
    const header = req.headers.authorization;
    if (typeof header !== 'string') return reply.code(401).send({ error: 'An operator token is required', code: 'token.invalid' });
    let res;
    try {
      res = await admin.listReconciliationControlRuns(req.body, header);
    } catch (err) {
      if (!(err instanceof InvalidControlBodyError)) throw err;
      return reply.code(400).send({ error: err.message, code: 'edge.invalid_reconciliation_control' });
    }
    return reply.code(res.status).send(res.body);
  });

  app.post('/admin/ledger/reconciliation/controls', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    let res;
    try {
      res = await admin.defineReconciliationControl(req.body, auth.bearer);
    } catch (err) {
      if (!(err instanceof InvalidControlBodyError)) throw err;
      return reply.code(400).send({ error: err.message, code: 'edge.invalid_reconciliation_control' });
    }
    req.log.warn({ operator: auth.principal.userId, status: res.status }, 'edge: LEDGER RECONCILIATION CONTROL define');
    return reply.code(res.status).send(res.body);
  });

  app.post('/admin/ledger/reconciliation/controls/update', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    let res;
    try {
      res = await admin.updateReconciliationControl(req.body, auth.bearer);
    } catch (err) {
      if (!(err instanceof InvalidControlBodyError)) throw err;
      return reply.code(400).send({ error: err.message, code: 'edge.invalid_reconciliation_control' });
    }
    req.log.warn({ operator: auth.principal.userId, status: res.status }, 'edge: LEDGER RECONCILIATION CONTROL update');
    return reply.code(res.status).send(res.body);
  });

  app.post('/admin/ledger/reconciliation/controls/run', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'treasury');
    if (!auth) return reply;
    let res;
    try {
      res = await admin.runReconciliationControl(req.body, auth.bearer);
    } catch (err) {
      if (!(err instanceof InvalidControlBodyError)) throw err;
      return reply.code(400).send({ error: err.message, code: 'edge.invalid_reconciliation_control' });
    }
    const ran = req.body as { controlId?: unknown; operationId?: unknown; approvalId?: unknown };
    req.log.warn(
      {
        operator: auth.principal.userId,
        status: res.status,
        controlId: ran.controlId,
        operationId: ran.operationId,
        approvalId: ran.approvalId,
      },
      'edge: LEDGER RECONCILIATION CONTROL run',
    );
    return reply.code(res.status).send(res.body);
  });

  /**
   * The ledger object lookup (OPS-rules-monitoring-12): one transaction by id, or the one a business key booked.
   * A founder's `admin:read` with a second factor (owner decision 2026-10-23), forwarded with the operator's OWN token, so svc-ledger records the lookup against the person at the
   * keyboard before it reads. svc-ledger's answer passes through unchanged, refusals included.
   */
  app.get<{ Params: { txId: string } }>('/admin/ledger/transactions/:txId', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'lookup');
    if (!auth) return reply;
    const res = await admin.lookupTransaction(req.params.txId, auth.bearer);
    return reply.code(res.status).send(res.body);
  });

  app.get<{ Querystring: { businessKey?: unknown } }>('/admin/ledger/trace', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'lookup');
    if (!auth) return reply;
    const res = await admin.traceBusinessKey(req.query?.businessKey, auth.bearer);
    return reply.code(res.status).send(res.body);
  });

  /**
   * The ledger desk's browsing reads (OPS-ledger-desk-01): the transaction list, the account address search and the
   * book's counts. The lookups' authority, the operator's OWN token forwarded so svc-ledger records the list and the
   * search against the person before it reads. Only each read's named query keys go through; svc-ledger checks them.
   */
  for (const read of ['transactions', 'accounts', 'stats'] as const) {
    app.get(`/admin/ledger/${read}`, async (req, reply) => {
      const auth = await operator(req.headers.authorization, reply, 'lookup');
      if (!auth) return reply;
      const res = await admin.readLedgerDesk(read, req.query, auth.bearer);
      return reply.code(res.status).send(res.body);
    });
  }

  /**
   * An account's operator metadata (J-ops-console-03 #6, #7). The read takes the lookups' authority with the operator's
   * own token, so svc-ledger records it against the person; the set and the delete are treasury writes like a control
   * run. A delete's body carries the second founder's approval, which svc-ledger spends. svc-ledger's answer passes
   * through, `ledger.frozen` included.
   */
  app.get<{ Params: { accountId: string } }>('/admin/ledger/accounts/:accountId/metadata', async (req, reply) => {
    const auth = await operator(req.headers.authorization, reply, 'lookup');
    if (!auth) return reply;
    const res = await admin.readAccountMetadata(req.params.accountId, auth.bearer);
    return reply.code(res.status).send(res.body);
  });

  for (const write of ['set', 'delete'] as const) {
    app.post<{ Params: { accountId: string } }>(`/admin/ledger/accounts/:accountId/metadata/${write}`, async (req, reply) => {
      const auth = await operator(req.headers.authorization, reply, 'treasury');
      if (!auth) return reply;
      let res;
      try {
        res = await admin.writeAccountMetadata(write, req.params.accountId, req.body, auth.bearer);
      } catch (err) {
        if (!(err instanceof InvalidControlBodyError)) throw err;
        return reply.code(400).send({ error: err.message, code: 'edge.invalid_account_metadata' });
      }
      const sent = req.body as { key?: unknown; approvalId?: unknown } | undefined;
      req.log.warn(
        {
          operator: auth.principal.userId,
          status: res.status,
          accountId: req.params.accountId,
          key: sent?.key,
          approvalId: sent?.approvalId,
        },
        `edge: LEDGER ACCOUNT METADATA ${write}`,
      );
      return reply.code(res.status).send(res.body);
    });
  }

  const matchingUnwired = {
    error: 'MATCHING_URL or EDGE_PRINCIPAL_SECRET is unpublished. This edge does not read the book and does not halt it.',
    code: 'edge.matching_unwired' as const,
  };

  // Same resolver the /api proxy uses before signPrincipalHeader. Never a
  // caller-supplied region: trustProxy and the geo header name come from env.
  const matchingRegion = (headers: Record<string, string | string[] | undefined>): string =>
    resolveRequestRegion({
      defaultRegion: process.env.DEFAULT_REGION ?? 'XX',
      trustProxy: process.env.EDGE_TRUST_PROXY !== undefined,
      geoHeaderName: process.env.EDGE_GEO_COUNTRY_HEADER,
      headers,
    }).region;

  const forwardMatching = async (
    path: MatchingOperatorPath,
    method: 'GET' | 'POST',
    principal: Principal,
    body: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    region: string,
  ) => {
    if (!matching) return reply.code(503).send(matchingUnwired);
    const res = await matching(path, method, principal, body, region);
    return reply.code(res.status).send(res.body);
  };

  app.get('/admin/matching/in-flight', async (req, reply) => {
    let principal: Principal;
    try {
      principal = await admin.authenticateRead(req.headers.authorization);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(statusForAuthError(err)).send({ error: err.message, code: err.code });
      throw err;
    }
    return forwardMatching(
      '/operator/in-flight',
      'GET',
      principal,
      undefined,
      reply,
      matchingRegion(req.headers as Record<string, string | string[] | undefined>),
    );
  });

  const matchingPost = (adminPath: string, upstream: MatchingOperatorPath) => {
    app.post(adminPath, async (req, reply) => {
      const auth = await operator(req.headers.authorization, reply, 'module');
      if (!auth) return reply;
      return forwardMatching(
        upstream,
        'POST',
        auth.principal,
        req.body,
        reply,
        matchingRegion(req.headers as Record<string, string | string[] | undefined>),
      );
    });
  };
  matchingPost('/admin/matching/halt', '/operator/halt');
  matchingPost('/admin/matching/halt-all', '/operator/halt-all');
  matchingPost('/admin/matching/resume', '/operator/resume');
  matchingPost('/admin/matching/resume-all', '/operator/resume-all');
}
