/**
 * ISOLATION WORLD (W14). One fixture, many suites.
 *
 * Seeds, against a REAL Postgres (every forward pay migration) and a MemoryLedger:
 *   - two unrelated gateway merchants, A and B
 *   - a PayFac tree  P -> { C1 -> { G1 }, C2 }   (P is the root, C1 an intermediate node)
 *   - another PayFac tree  Q -> { D1 }
 *   - one entitled founder, and every principal shape the G suites need
 * and mounts the routers exactly as `src/index.ts` composes them (that file boots
 * a server on import, so it cannot be imported; `composition pin` in the founder
 * suite fails if index.ts stops composing the same routers).
 *
 * Later workstreams (W1 control room, W3/W4, W6) add their procedures
 * to the TABLES in `procedures.ts`. They never touch this file's seeding.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { encodePrincipal, mergeRouters, signPrincipalHeader, type Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { MerchantAccountControls } from '../../src/merchant-account-controls.js';
import { defaultDisputeCaseStore } from '../../src/fraud/dispute-case.js';
import { recordMerchantNotification } from '../../src/merchant-ops/index.js';
import { createFounderAuthority, type FounderAuthority } from '../../src/founder-authority.js';
import { createKybPspRouter } from '../../src/kyb-router.js';
import { KybEntityTypeService } from '../../src/kyb-entity-types.js';
import { KybApplicationService } from '../../src/kyb-application.js';
import { KybService } from '../../src/kyb-service.js';
import { MerchantStateService } from '../../src/merchant-state-service.js';
import { createMerchantStateRouter } from '../../src/merchant-state-router.js';
import { MerchantPayoutDestinationStore } from '../../src/merchant-payout-destination.js';
import { MerchantWebhookService, PostgresMerchantWebhookStore } from '../../src/merchant-webhooks.js';
import { createMetricsRuntime, type MetricsRuntime } from '../../src/metrics/index.js';
import { loadHaltAutoTripConfig } from '../../src/halts/config.js';
import { PayHaltStore } from '../../src/halts/store.js';
import { ControlService } from '../../src/control/service.js';
import { teamAccessPorts } from '../../src/control/access.js';
import { createPayNamespaces } from '../../src/namespaces/index.js';
import { PayService } from '../../src/payment-service.js';
import { PspModeService } from '../../src/psp-mode.js';
import { CardSandboxAdapter } from '../../src/rails/card-sandbox.js';
import { BankPayoutAbsentAdapter } from '../../src/rails/bank-payout.js';
import { RailRegistry } from '../../src/rails/registry.js';
import { registerPublicPayRest } from '../../src/public-rest.js';
import { teamReadFromSql } from '../../src/merchant-team-read.js';
import { createPayRouter } from '../../src/router.js';
import { createSubMerchantRouter } from '../../src/submerchant-router.js';
import { SubMerchantService } from '../../src/submerchants.js';
import { unwiredApprovalConsumer } from '../../src/action-approval-consume.js';
import { loadTreasuryLimits } from '../../src/treasury/config.js';
import { ConversionService } from '../../src/conversion/service.js';
import { unconfiguredConversionVenue } from '../../src/conversion/venue.js';
import { createConversionInventory } from '../../src/conversion/inventory.js';
import { createRegistryReader } from '../../src/registries/read-api.js';
import { buildPayGuards } from '../../src/seams/registry.js';
import { UserMoneyService } from '../../src/user-money-service.js';
import { seedControl, type ControlSeed } from './control-seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

export const EDGE_SECRET = 'dev-only-w14-isolation-edge-secret-0123456789abcdef';
const RAIL_SECRET = 'dev-only-w14-isolation-rail-secret-0123456789abcdef';
export const EVM_DESTINATION = '0x000000000000000000000000000000000000dEaD';

/** What a merchant account's interactive session carries after onboarding (pay:* is granted by onboarding). */
export const MERCHANT_SESSION_SCOPES = [...SESSION_SCOPES, 'pay:read', 'pay:write', 'pay:refund', 'pay:payout', 'pay:onboard'];
/**
 * What this isolation key carries. pay:refund is on it because the fixture is a
 * key created with that scope explicitly. pay:payout is not on this default key (D-145).
 */
export const MERCHANT_KEY_SCOPES = ['pay:read', 'pay:write', 'pay:refund'];
export const ADMIN_SCOPES = ['admin:read', 'admin:write', 'admin:compliance'];

/** A venue key the registries recognise (KNOWN_VENUE_KEYS) and a network the fixture seeds, for the founder positive control's registry saves. */
export const REGISTRY_VENUE_ID = 'binance-spot';
export const REGISTRY_NETWORK_ID = 'isolation-network';

export type Tag = 'A' | 'B' | 'P' | 'C1' | 'G1' | 'C2' | 'Q' | 'D1';

/** Everything seeded for one merchant. */
export interface Entity {
  readonly tag: Tag;
  readonly userId: string;
  readonly merchantId: string;
  /** captured, settled-into `settlementId`. */
  readonly paymentId: string;
  /** created only (nothing captured). */
  readonly paymentId2: string;
  readonly settlementId: string;
  readonly linkId: string;
  readonly endpointId: string;
  /** A second endpoint the isolation sweep may disable without silencing the primary. */
  readonly spareEndpointId: string;
  /** A failed delivery on `endpointId`, so a retry positive control has a row to requeue. */
  readonly deliveryId: string;
  /** W15: a dispute case (process-wide store; the id is unique per entity) on `paymentId`. */
  readonly disputeId: string;
  /** W15: the opaque customer reference the merchant put on `paymentId`. */
  readonly customerRef: string;
  /** W15: a finished CSV export job requested by the owner. */
  readonly exportJobId: string;
  /** W15: an in-app notification. */
  readonly notificationId: string;
  /** W15: a team member row (status `invited`, a stranger's account) that the owner may change or remove. */
  readonly memberId: string;
  /** W15: an invitation to the OWNER's own account onto the own team, so the owner can accept or decline it. */
  readonly inviteId: string;
  /** W1: the pending payout approval this merchant's owner (the maker) requested on `settlementId`. */
  readonly approvalId: string;
  /** Portal refund list: the `refund.posted` event id. No ledger movement. */
  readonly refundEventId: string;
  /** Draft standalone invoice for `paymentId`'s amount and asset. */
  readonly invoiceId: string;
  /** Evidence bytes stored for `disputeId`. */
  readonly evidenceId: string;
}

export type Entitlement = 'enabled' | 'revoked' | 'unconfigured' | 'not_operator';
export type IdentityMode = 'normal' | 'unreachable' | 'http500' | 'garbage' | 'http403';

export interface IdentityDouble {
  mode: IdentityMode;
  /** userId (lower case) -> status. Anyone absent is `not_operator`. */
  readonly entitlements: Map<string, Entitlement>;
  /** One entry per call the founder authority made to identity. */
  readonly calls: Array<{ userId: string }>;
  readonly fetcher: typeof fetch;
}

export interface Outbound {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

export interface World {
  readonly db: TestDatabase;
  readonly sql: TestDatabase['sql'];
  readonly pay: PayService;
  readonly webhooks: MerchantWebhookService;
  readonly subMerchants: SubMerchantService;
  readonly appRouter: ReturnType<typeof composeRouter>;
  readonly rest: FastifyInstance;
  readonly identity: IdentityDouble;
  readonly founderAuthority: FounderAuthority;
  readonly metrics: MetricsRuntime;
  readonly outbound: Outbound[];
  readonly e: Record<Tag, Entity>;
  readonly founderUserId: string;
  /** A live operator note on merchant A, for the founder positive control of `founderAdmin.ops.notes.retract`. */
  readonly operatorNoteId: string;
  /** W1: one-shot targets for the founder positive controls (see control-seed.ts). */
  readonly control: ControlSeed;
  /** An ACTIVE `finance` team member of merchant B (a real row in pay.merchant_team_members): the cross-merchant probe for teamAccessPorts. */
  readonly bFinanceUserId: string;
  /** Every id of a merchant row seeded by `tag` (merchant, payments, settlement, link, endpoint, W15 rows). */
  idsOf(tag: Tag): string[];
  stop(): Promise<void>;
}

// ── principals and contexts ────────────────────────────────────────────────

export function principal(userId: string, over: Partial<Principal> = {}): Principal {
  return {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: MERCHANT_SESSION_SCOPES,
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...over,
  } as Principal;
}

/** The merchant owner's interactive session (MFA'd, full tier). */
export const sessionOf = (userId: string, over: Partial<Principal> = {}): Principal => principal(userId, over);

/** The same owner's `ifc_` API key: kid + key_env, no MFA, no interactive-only scopes. */
export const keyOf = (userId: string, over: Partial<Principal> = {}): Principal =>
  principal(userId, { kid: randomUUID(), key_env: 'live', mfa: false, scopes: MERCHANT_KEY_SCOPES, ...over });

export const ctxOf = (p: Principal | null, service: string | null = null): Context => ({
  principal: p,
  service,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: p ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});

/** Signed edge headers, so REST sees exactly what svc-edge would forward. */
export function signedHeaders(p: Principal): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

// ── identity double (the founder authority's only dependency) ──────────────

function createIdentityDouble(): IdentityDouble {
  const entitlements = new Map<string, Entitlement>();
  const calls: Array<{ userId: string }> = [];
  const state = { mode: 'normal' as IdentityMode };
  const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
    const { userId } = JSON.parse(String(init?.body ?? '{}')) as { userId: string };
    calls.push({ userId });
    if (state.mode === 'unreachable') throw new TypeError('fetch failed');
    if (state.mode === 'http500') return new Response('boom', { status: 500 });
    if (state.mode === 'http403') return new Response('{}', { status: 403 });
    if (state.mode === 'garbage') return new Response('{"result":{"data":{"status":"enabled"}}}', { status: 200 });
    const status = entitlements.get(userId.toLowerCase()) ?? 'not_operator';
    const data =
      status === 'enabled' || status === 'revoked'
        ? { status, userId, version: '1', changedAt: '2026-10-10T00:00:00Z' }
        : { status, userId };
    return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    get mode() {
      return state.mode;
    },
    set mode(m: IdentityMode) {
      state.mode = m;
    },
    entitlements,
    calls,
    fetcher,
  };
}

// ── composition (mirror of src/index.ts) ───────────────────────────────────

function composeRouter(parts: {
  pay: PayService;
  rails: RailRegistry;
  userMoney: UserMoneyService;
  subMerchants: SubMerchantService;
  destinations: MerchantPayoutDestinationStore;
  sql: TestDatabase['sql'];
  founderAuthority: FounderAuthority;
  metrics: MetricsRuntime;
  conversion: ConversionService;
  ledger: MemoryLedger;
}) {
  // src/index.ts: `actionApprovals` is the identity client when IDENTITY_URL is set, else this refusing consumer.
  const actionApprovals = unwiredApprovalConsumer();
  const kybService = new KybService(parts.sql);
  const kybEntityTypes = new KybEntityTypeService(parts.sql);
  return mergeRouters(
    createPayRouter(
      parts.pay,
      parts.rails,
      parts.userMoney,
      parts.subMerchants,
      parts.destinations,
      actionApprovals,
      teamReadFromSql(parts.sql),
      undefined,
      parts.sql,
    ),
    createMerchantStateRouter(new MerchantStateService(parts.sql), new MerchantAccountControls(parts.sql, parts.founderAuthority)),
    createKybPspRouter(
      kybService,
      new PspModeService(parts.sql),
      actionApprovals,
      parts.pay,
      kybEntityTypes,
      new KybApplicationService(parts.sql, kybService, kybEntityTypes),
    ),
    createSubMerchantRouter(parts.subMerchants, parts.pay, parts.sql),
    // One mount list, as in src/index.ts. A workstream that adds a mount there adds ONE line here.
    createPayNamespaces({
      founderAuthority: parts.founderAuthority,
      metrics: parts.metrics,
      registries: { sql: parts.sql, approvals: actionApprovals },
      sql: parts.sql, // W15: merchantOps.* and founderAdmin.ops.*
      webhooksAllowLocalHttp: true,
      webhookRetry: { maxPerWindow: 100, windowMs: 60_000 },
      invoiceLinks: parts.pay,
      // W5: the same Postgres halt store the guards read, and the treasury exposure read. Limits come from an
      // EMPTY environment, as in an unconfigured deployment (no defaults). The conversion reader is the live inventory.
      payHalts: {
        store: new PayHaltStore(parts.sql, loadHaltAutoTripConfig({})),
        merchants: parts.pay,
        team: teamReadFromSql(parts.sql),
      },
      treasury: { sql: parts.sql, limits: loadTreasuryLimits({}), inventory: createConversionInventory(parts.sql, parts.ledger) },
      // W1: as src/index.ts, the approver is whoever holds payout.approve on the merchant team (W15 roles).
      control: new ControlService(parts.sql, teamAccessPorts(parts.sql)),
      conversion: parts.conversion,
      pay: parts.pay,
    }),
  );
}

// ── the world ──────────────────────────────────────────────────────────────

export async function createWorld(): Promise<World> {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is unset; the isolation suites need a real Postgres (no skip-green)');
  const migrations = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
  const db = await createTestDatabase({ service: 'pay', url, migrations });
  const sql = db.sql;

  const ledger = new MemoryLedger();
  const rails = new RailRegistry([new CardSandboxAdapter({ secret: RAIL_SECRET, toleranceSeconds: 300 }), new BankPayoutAbsentAdapter()]);
  const destinations = new MerchantPayoutDestinationStore(sql);
  const pay = new PayService(sql, ledger, rails, {
    checkoutRiskBand: 'low',
    payoutDestinations: destinations,
    linkDefaultTtlDays: 30,
    linkMaxTtlDays: 365,
    checkoutSessionTtlSeconds: 900,
    maxOpenSessionsPerLink: 25,
  });
  const subMerchants = new SubMerchantService(sql);
  const userMoney = new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [], valueMovement: 'allow-sandbox' });

  const outbound: Outbound[] = [];
  const webhooks = new MerchantWebhookService(new PostgresMerchantWebhookStore(sql), {
    allowLocalHttp: true,
    transport: async (req) => {
      outbound.push({ url: String(req.url), body: req.body, headers: { ...req.headers } });
      return { status: 200 } as never;
    },
  });

  const identity = createIdentityDouble();
  const founderAuthority = createFounderAuthority({
    identityUrl: 'https://identity.invalid',
    serviceSecret: 's'.repeat(32),
    fetcher: identity.fetcher,
  });
  const metrics = createMetricsRuntime({ sql, pay, trees: subMerchants, rails }, { settlementAssets: ['USDT'] });
  const conversion = new ConversionService({
    sql,
    ledger,
    guards: buildPayGuards({ sql, ledger }),
    venue: unconfiguredConversionVenue(),
    registries: createRegistryReader(sql),
    slippageBps: null,
    placingMaxAgeMs: null,
  });
  const appRouter = composeRouter({
    pay,
    rails,
    userMoney,
    subMerchants,
    destinations,
    sql,
    founderAuthority,
    metrics,
    conversion,
    ledger,
  });

  const rest = Fastify();
  await registerPublicPayRest(rest, {
    edgeSecret: EDGE_SECRET,
    serviceName: 'svc-pay',
    pay,
    webhooks,
    trees: subMerchants,
    teamReads: teamReadFromSql(sql),
  });
  await rest.ready();

  // ── seed ──
  const fee = { feeBps: 250 };
  const settleAt = { from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) };
  const entities = {} as Record<Tag, Entity>;

  async function seed(tag: Tag, merchantId: string, userId: string): Promise<void> {
    const customerRef = `cust-${tag}-${randomUUID().slice(0, 8)}`;
    const mk = async (ref?: string) =>
      pay.createPayment({
        merchantId,
        amount: parseAmount('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
        metadata: { tag },
        ...(ref ? { customerRef: ref } : {}),
      });
    const first = await mk(customerRef);
    await pay.authorize(first.id);
    const captured = await pay.capture(first.id);
    const second = await mk();
    const settlement = await pay.settleWindow({ merchantId, window: `w14-${tag}`, assetId: 'USDT', ...settleAt });
    const link = await pay.createPaymentLink({ merchantId, label: `link-${tag}` });
    const endpoint = await webhooks.registerEndpoint(merchantId, `http://localhost:9/hook-${tag}`);
    const spare = await webhooks.registerEndpoint(merchantId, `http://localhost:9/hook-${tag}-spare`);
    await webhooks.enqueue({ type: 'payment.captured', payment: captured });
    const deliveryRows = await sql<Array<{ id: string }>>`
      SELECT id FROM pay.merchant_webhook_deliveries
       WHERE merchant_id = ${merchantId} AND endpoint_id = ${endpoint.id}
       ORDER BY created_at DESC LIMIT 1`;
    await sql`
      UPDATE pay.merchant_webhook_deliveries SET status = 'failed', attempts = 1
       WHERE id = ${deliveryRows[0]!.id}`;
    await sql`DELETE FROM pay.merchant_webhook_deliveries WHERE endpoint_id = ${spare.id}`;

    // W15 merchant operations rows. Direct inserts for the ones the product creates asynchronously
    // (export, invitations), so seeding starts no background work.
    const disputeId = `dp-${tag}-${randomUUID()}`;
    defaultDisputeCaseStore.open({ disputeId, paymentId: first.id, merchantId, amount: '100', assetId: 'USDT', reasonCode: '4853' });
    const evidenceBytes = Buffer.from('%PDF');
    const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
    const evidenceRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, added_by)
      VALUES (${merchantId}, ${disputeId}, 'receipt', 'receipt.pdf', 'application/pdf', ${evidenceBytes.length}, ${evidenceSha}, ${userId})
      RETURNING id`;
    const evidenceId = evidenceRows[0]!.id;
    await sql`
      INSERT INTO pay.merchant_dispute_evidence_content (evidence_id, merchant_id, content)
      VALUES (${evidenceId}, ${merchantId}, ${evidenceBytes})`;
    const invoiceRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_invoices (merchant_id, status, asset_id, amount, customer_ref, description, created_by)
      VALUES (${merchantId}, 'draft', 'USDT', 100, ${customerRef}, 'isolation invoice', ${userId})
      RETURNING id`;
    const exportRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_export_jobs (merchant_id, request_id, requested_by, kind, status, file_name, content_type, content, size_bytes, row_count, as_of)
      VALUES (${merchantId}, ${randomUUID()}, ${userId}, 'payments', 'ready', ${`payments-${tag}.csv`}, 'text/csv; charset=utf-8', 'id\n', 3, 0, now())
      RETURNING id`;
    const notificationId = await recordMerchantNotification(sql, { merchantId, kind: 'export_ready', title: `isolation ${tag}` });
    const memberRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
      VALUES (${merchantId}, ${randomUUID()}, 'viewer', 'invited', ${userId}) RETURNING id`;
    const inviteRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by)
      VALUES (${merchantId}, ${userId}, 'viewer', 'invited', ${userId}) RETURNING id`;
    const refundRows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (
        ${first.id},
        'refund.posted',
        ${sql.json({ refundId: `iso-${tag}`, amount: '1', source: 'clearing' })}
      )
      RETURNING id`;
    entities[tag] = {
      tag,
      userId,
      merchantId,
      paymentId: first.id,
      paymentId2: second.id,
      settlementId: settlement.id,
      linkId: link.id,
      endpointId: endpoint.id,
      spareEndpointId: spare.id,
      deliveryId: deliveryRows[0]!.id,
      disputeId,
      customerRef,
      exportJobId: exportRows[0]!.id,
      notificationId: notificationId!,
      memberId: memberRows[0]!.id,
      inviteId: inviteRows[0]!.id,
      approvalId: '', // set by seedControl below, once every merchant has a tier
      refundEventId: refundRows[0]!.id,
      invoiceId: invoiceRows[0]!.id,
      evidenceId,
    };
  }

  // Two unrelated gateway merchants.
  for (const tag of ['A', 'B'] as const) {
    const userId = randomUUID();
    const m = await pay.createMerchant({ userId, pricing: fee });
    await seed(tag, m.id, userId);
  }

  // Tree 1: P -> { C1 -> { G1 }, C2 }.  Tree 2: Q -> { D1 }.
  const root = async (tag: 'P' | 'Q') => {
    const userId = randomUUID();
    const m = await pay.createMerchant({ userId, mode: 'payfac', pricing: fee });
    await seed(tag, m.id, userId);
    return entities[tag];
  };
  const child = async (tag: Tag, parent: Entity, actor: Entity) => {
    const userId = randomUUID();
    const m = await subMerchants.createSubMerchant({
      actorMerchantId: actor.merchantId,
      parentMerchantId: parent.merchantId,
      userId,
      pricing: fee,
      actorId: actor.userId,
      actorScope: 'pay:write',
    });
    // A sub-merchant is onboarded `pending`; the operator's activation is out of scope here.
    await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${m.id}`;
    await seed(tag, m.id, userId);
    return entities[tag];
  };
  const P = await root('P');
  const C1 = await child('C1', P, P);
  await child('G1', C1, P);
  await child('C2', P, P);
  const Q = await root('Q');
  await child('D1', Q, Q);

  // W1: a tier, a destination and one pending payout approval per merchant (the owner is the maker).
  const all = Object.values(entities);
  const control = await seedControl(sql, all, (userId) => principal(userId), {
    railId: 'crypto-native',
    kind: 'crypto',
    ref: EVM_DESTINATION,
  });
  for (const x of all) (entities[x.tag] as { approvalId: string }).approvalId = control.approvalIds[x.tag]!;

  // A real finance member of merchant B: holds payout.approve on B and nothing on anyone else.
  const bFinanceUserId = randomUUID();
  await sql`
    INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
    VALUES (${entities.B.merchantId}, ${bFinanceUserId}, 'finance', 'active', ${entities.B.userId}, now())`;

  await sql`
    INSERT INTO pay.network_registry (network_id, display_name, asset_codes, updated_by)
    VALUES (${REGISTRY_NETWORK_ID}, 'Isolation network', '["USDT"]'::jsonb, 'fixture')`;

  const operatorNote = await sql<Array<{ id: string }>>`
    INSERT INTO pay.operator_merchant_notes (merchant_id, body, author_id)
    VALUES (${entities.A.merchantId}, 'isolation drill: operator-only note', 'fixture') RETURNING id`;

  const founderUserId = randomUUID();
  identity.entitlements.set(founderUserId, 'enabled');
  outbound.length = 0; // seeding enqueues only; nothing has been processed yet

  return {
    db,
    sql,
    pay,
    webhooks,
    subMerchants,
    appRouter,
    rest,
    identity,
    founderAuthority,
    metrics,
    outbound,
    e: entities,
    founderUserId,
    bFinanceUserId,
    operatorNoteId: operatorNote[0]!.id,
    control,
    idsOf(tag) {
      const x = entities[tag];
      return [
        x.merchantId,
        x.paymentId,
        x.paymentId2,
        x.settlementId,
        x.linkId,
        x.endpointId,
        x.spareEndpointId,
        x.deliveryId,
        x.disputeId,
        x.exportJobId,
        x.notificationId,
        x.memberId,
        x.inviteId,
        x.approvalId,
        x.refundEventId,
        x.invoiceId,
        x.evidenceId,
      ];
    },
    async stop() {
      await rest.close();
      await db.drop();
    },
  };
}

// ── calling procedures and normalising outcomes ────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX = /0x[0-9a-f]{8,}/gi;
/** Ids differ between a real row and a ghost; nothing else about a message may. */
export const normalise = (s: string): string => s.replace(UUID, '<id>').replace(HEX, '<hex>');

export type Outcome =
  { kind: 'ok'; value: unknown } | { kind: 'error'; code: string; message: string; causeCode: string | undefined; httpStatus?: number };

export type Callable = (input?: unknown) => Promise<unknown>;

export function procedureAt(caller: unknown, path: string): Callable {
  return path.split('.').reduce((node, key) => (node as Record<string, unknown>)[key], caller) as Callable;
}

export async function callTrpc(w: World, ctx: Context, path: string, input?: unknown): Promise<Outcome> {
  const caller = w.appRouter.createCaller(ctx);
  try {
    return { kind: 'ok', value: await procedureAt(caller, path)(input) };
  } catch (e) {
    const err = e as { code?: string; message?: string; cause?: { code?: string } };
    return {
      kind: 'error',
      code: String(err.code ?? 'UNKNOWN'),
      message: normalise(String(err.message ?? '')),
      causeCode: err.cause?.code,
    };
  }
}

/** The part of an error a caller can observe. Equal shapes = no existence oracle. */
export function shapeOf(o: Outcome): unknown {
  return o.kind === 'ok' ? { kind: 'ok' } : { code: o.code, message: o.message, causeCode: o.causeCode, httpStatus: o.httpStatus };
}

export interface RestCall {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  body?: unknown;
}

export async function callRest(w: World, p: Principal | null, req: RestCall): Promise<Outcome & { status: number; json: unknown }> {
  const res = await w.rest.inject({
    method: req.method,
    url: req.url,
    headers: {
      ...(p ? signedHeaders(p) : {}),
      ...(req.method === 'POST' ? { 'idempotency-key': `w14-${randomUUID()}`, 'content-type': 'application/json' } : {}),
    },
    ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
  });
  const json = res.body ? (JSON.parse(res.body) as unknown) : null;
  if (res.statusCode < 400) return { kind: 'ok', value: json, status: res.statusCode, json };
  const err = (json as { error?: { code?: string; message?: string } } | null)?.error ?? {};
  return {
    kind: 'error',
    code: String(err.code ?? 'UNKNOWN'),
    message: normalise(String(err.message ?? '')),
    causeCode: undefined,
    httpStatus: res.statusCode,
    status: res.statusCode,
    json,
  };
}

export const ghostId = (): string => randomUUID();

/** Median wall time of `n` runs, for the coarse timing-class check. */
export async function medianMs(n: number, run: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** Full row snapshot of everything a probe could mutate for one merchant. */
export async function snapshotMerchant(w: World, merchantId: string): Promise<string> {
  const q = async (table: string, col: string) =>
    (await w.sql.unsafe(`SELECT to_jsonb(t) AS r FROM pay.${table} t WHERE ${col} = '${merchantId}' ORDER BY 1::text`)).map((x) => x.r);
  return JSON.stringify({
    merchants: await q('merchants', 'id'),
    payments: await q('payments', 'merchant_id'),
    links: await q('payment_links', 'merchant_id'),
    settlements: await q('settlements', 'merchant_id'),
    destinations: await q('merchant_payout_destinations', 'merchant_id'),
    endpoints: await q('merchant_webhook_endpoints', 'merchant_id'),
    deliveries: await q('merchant_webhook_deliveries', 'merchant_id'),
    permissions: await q('merchant_permission_events', 'subject_merchant_id'),
    // W15
    team: await q('merchant_team_members', 'merchant_id'),
    teamEvents: await q('merchant_team_events', 'merchant_id'),
    notifications: await q('merchant_notifications', 'merchant_id'),
    exportJobs: await q('merchant_export_jobs', 'merchant_id'),
    disputeEvidence: await q('merchant_dispute_evidence', 'merchant_id'),
    disputeEvidenceContent: await q('merchant_dispute_evidence_content', 'merchant_id'),
    disputeDeadlines: await q('dispute_response_deadlines', 'merchant_id'),
    disputeResponses: await q('merchant_dispute_responses', 'merchant_id'),
    invoices: await q('merchant_invoices', 'merchant_id'),
    invoiceActions: await q('merchant_invoice_actions', 'merchant_id'),
    disputeCasesPg: await q('dispute_cases', 'merchant_id'),
    // W1
    controlProfile: await q('control_merchant_profiles', 'merchant_id'),
    controlApprovals: await q('control_payout_approvals', 'merchant_id'),
    controlAudit: await q('control_audit', 'merchant_id'),
    limitRequests: await q('control_limit_requests', 'merchant_id'),
    disputeCases: defaultDisputeCaseStore.listForMerchant(merchantId),
  });
}
