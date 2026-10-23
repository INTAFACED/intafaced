import { createHash } from 'node:crypto';

// The founders' notice board on the local stack, as an operator uses it: operator A drafts, B approves, A publishes.
// Each notice carries a short window, so a run leaves nothing open on the stack for the next one.

let gates;
let ctx;
let pair;

async function founders() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { gates, ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** svc-notify's payload hash for an announcement or maintenance notice (no status, scope or changelog fields). */
const payloadHash = (row) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ id: row.id, kind: row.kind, title: row.title, body: row.body, version: row.version }))
    .digest('hex')}`;

/** A draft notice, open from now for `minutes`. Returns the stored row. */
export async function draftNotice({ kind, title, body, minutes, key }) {
  const { ctx, pair } = await founders();
  const now = Date.now();
  const res = await ctx.edge.mutate(
    'notify',
    'notify.draftNotice',
    {
      kind,
      title,
      body,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + minutes * 60_000).toISOString(),
      clientRequestId: `journey:notice-draft:${key}`,
    },
    await pair.a.tradeOpsToken(),
  );
  return data(res, 'notify.draftNotice');
}

/** Four-eyes publish of a draft: A proposes, B approves, A publishes. Returns the published row. */
export async function publishNotice(row, key) {
  const { gates, ctx, pair } = await founders();
  const proposal = {
    actionType: 'notify.notice.publish',
    targetService: 'svc-notify',
    targetId: row.id,
    expectedVersion: String(row.version),
    payloadHash: payloadHash(row),
    policyVersion: gates.MARKERS.policyVersion,
  };
  const proposed = data(
    await ctx.edge.mutate('identity', 'actionApproval.propose', proposal, await pair.a.approvalToken()),
    'actionApproval.propose',
  );
  const approved = data(
    await ctx.edge.mutate(
      'identity',
      'actionApproval.approve',
      { approvalId: proposed.approvalId, expectedPayloadHash: proposal.payloadHash },
      await pair.b.approvalToken(),
    ),
    'actionApproval.approve',
  );
  if (approved.status !== 'APPROVED') throw new Error(`approval ${proposed.approvalId} is ${approved.status}`);
  const res = await ctx.edge.mutate(
    'notify',
    'notify.publishNotice',
    { id: row.id, clientRequestId: `journey:notice-publish:${key}`, approvalId: proposed.approvalId, operationId: proposed.operationId },
    await pair.a.tradeOpsToken(),
  );
  return data(res, 'notify.publishNotice');
}

/** What the public board holds open right now: { incidents, maintenance, announcement }. */
export async function openNotices() {
  const { ctx } = await founders();
  const status = data(await ctx.edge.query('notify', 'notify.noticeStatus'), 'notify.noticeStatus');
  const current = await ctx.edge.query('notify', 'notify.announcement');
  return { ...status, announcement: current.json?.result?.data ?? null };
}
