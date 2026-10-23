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

/**
 * svc-notify's payload hash: id, kind, title, body and version, plus the incident status fields when the draft set any.
 * No scope or changelog fields (no journey here drafts those).
 */
const payloadHash = (row) => {
  const status = row.statusFields;
  const withStatus = status && (status.impact || status.components.length > 0 || status.parentId || status.resolves) ? { status } : {};
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ id: row.id, kind: row.kind, title: row.title, body: row.body, version: row.version, ...withStatus }))
    .digest('hex')}`;
};

/**
 * A draft notice, open from now for `minutes` unless `startsAt`/`endsAt` say otherwise. Returns the stored row. An incident may name an impact and status page
 * components, update an earlier incident (`parentId`) and close it (`resolves`).
 */
export async function draftNotice({
  kind,
  title,
  body,
  minutes,
  key,
  impact = null,
  components = [],
  parentId = null,
  resolves = false,
  startsAt = null,
  endsAt = null,
}) {
  if (endsAt === null && !(minutes > 0)) throw new Error('draftNotice needs `minutes` or an `endsAt`');
  const { ctx, pair } = await founders();
  const now = Date.now();
  const res = await ctx.edge.mutate(
    'notify',
    'notify.draftNotice',
    {
      kind,
      title,
      body,
      startsAt: startsAt ?? new Date(now - 60_000).toISOString(),
      endsAt: endsAt ?? new Date(now + minutes * 60_000).toISOString(),
      ...(impact ? { impact } : {}),
      ...(components.length ? { components } : {}),
      ...(parentId ? { parentId } : {}),
      ...(resolves ? { resolves } : {}),
      clientRequestId: `journey:notice-draft:${key}`,
    },
    await pair.a.tradeOpsToken(),
  );
  return { ...data(res, 'notify.draftNotice'), statusFields: { impact, components, parentId, resolves } };
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
  // None published answers notify.announcement_unset; any other failure is not an empty board.
  if (current.json?.error?.data?.cause?.code === 'notify.announcement_unset') return { ...status, announcement: null };
  return { ...status, announcement: data(current, 'notify.announcement') };
}
