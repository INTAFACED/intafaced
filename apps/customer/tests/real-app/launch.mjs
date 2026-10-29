import { createHash } from 'node:crypto';

// TEST launch events for J-more-catalogue-11, made through svc-token's own founder doors (`launch.issuer.set`,
// `launch.events.create`, `launch.events.move`), each with a two-founder approval of exactly its fields, as an operator
// would. Nothing is written to a table directly. Every name, price and cap here is TEST.

const ISSUER_SET = 'token.launch.issuer.set';
const EVENT_CREATE = 'token.launch.event.create';
const EVENT_MOVE = 'token.launch.event.move';

/** The hash svc-token recomputes when it consumes a launch approval (services/svc-token/src/action-approval-consume.ts). */
const payloadHash = (actionType, fields) => `sha256:${createHash('sha256').update(JSON.stringify({ actionType, ...fields })).digest('hex')}`;

/**
 * The canonical event the founders approve, in the order svc-token's `launchEventPayload` writes it. The caller passes
 * amounts already in canonical decimal form ("250", "0.5") and times as `toISOString()`, so nothing is reformatted.
 */
function eventPayload(e) {
  return JSON.stringify({
    id: e.id,
    issuerId: e.issuerId,
    type: e.type,
    projectName: e.projectName.trim(),
    symbol: e.symbol,
    periods: [e.periods.announceAt, e.periods.snapshotAt, e.periods.openAt, e.periods.closeAt, e.periods.distributionAt],
    method: e.allocation.method,
    perUserCap: e.allocation.perUserCap,
    ticketSize: e.allocation.ticketSize,
    tierWeights: e.allocation.tierWeights?.map((t) => [t.minBasis, t.weight]) ?? null,
    price: e.terms.price,
    paymentAsset: e.terms.paymentAsset,
    rateSource: e.terms.rateSource,
  });
}

/** The stack's TEST founders and svc-token's admin door, opened once per worker. */
let door;
async function founders() {
  door ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { gates, ctx, sessions };
  })();
  return door;
}

/** Founder A proposes, founder B approves exactly `fields`, then A calls `procedure` with the approval. */
async function approved(procedure, actionType, fields, expectedVersion, input) {
  const { gates, ctx, sessions } = await founders();
  const ids = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-token',
    targetId: actionType,
    expectedVersion,
    payloadHash: payloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('token', procedure, { ...input, approvalId: ids.approvalId, operationId: ids.operationId }, await sessions.a.tradeOpsToken());
  const row = res.json?.result?.data;
  if (res.status !== 200 || !row) throw new Error(`token ${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

/** An onboarded TEST issuer: added as applied, then moved through review, one approval per step. */
export async function onboardedIssuer(id, name) {
  let revision = 0;
  for (const state of ['applied', 'reviewing', 'onboarded']) {
    const expected = String(revision);
    const row = await approved('launch.issuer.set', ISSUER_SET, { issuerId: id, name, state, expectedRevision: expected }, expected, {
      id,
      name,
      state,
      expectedRevision: revision,
    });
    revision = row.revision;
  }
  return { id, name, revision };
}

/** A draft launch event, approved field for field. Returns its revision. */
export async function createEvent(event) {
  const row = await approved('launch.events.create', EVENT_CREATE, { event: eventPayload(event) }, '0', event);
  return row.revision;
}

/** One status step of a launch event over the revision read. Moving to `snapshot` seals the stake snapshot. */
export async function moveEvent(id, to, expectedRevision) {
  const expected = String(expectedRevision);
  return approved('launch.events.move', EVENT_MOVE, { eventId: id, to, expectedRevision: expected }, expected, { id, to, expectedRevision });
}
