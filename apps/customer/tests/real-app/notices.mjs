import { noticePayloadHash as payloadHash } from '../../../../tooling/scripts/local-test-notice.mjs';

// The founders' notice board on the local stack, as an operator uses it: operator A drafts, B approves, A publishes.
// Each notice carries a short window, so a run leaves nothing open on the stack for the next one.

/** How long a journey waits for an earlier run's notices to close. Every notice a journey opens must end inside it. */
export const NOTICE_DRAIN_MINUTES = 7;

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
 * A draft notice, open from now for `minutes` unless `startsAt`/`endsAt` say otherwise. Returns the stored row. An incident may name an impact and status page
 * components, update an earlier incident (`parentId`) and close it (`resolves`). A funding incident or maintenance window names
 * one `asset` on one `network` (the registry's spelling, e.g. USDT and ethereum), and every incident entry its `phase`.
 * A `fee_change` notice takes `startsAt` as the time its fee schedule version takes effect, and no end.
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
  category = null,
  audience = null,
  asset = null,
  network = null,
  phase = null,
}) {
  // A fee change names the time it takes effect and has no end; every other notice gets a short window.
  const feeChange = kind === 'fee_change';
  if (feeChange && !startsAt) throw new Error('a fee_change notice needs the `startsAt` it takes effect');
  if (feeChange && endsAt !== null) throw new Error('a fee_change notice has no `endsAt`: svc-notify refuses one');
  if (!feeChange && endsAt === null && !(minutes > 0)) throw new Error('draftNotice needs `minutes` or an `endsAt`');
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
      ...(feeChange ? {} : { endsAt: endsAt ?? new Date(now + minutes * 60_000).toISOString() }),
      ...(impact ? { impact } : {}),
      ...(components.length ? { components } : {}),
      ...(parentId ? { parentId } : {}),
      ...(resolves ? { resolves } : {}),
      ...(category ? { category } : {}),
      ...(audience ? { audience } : {}),
      ...(asset ? { asset, network } : {}),
      ...(phase ? { phase } : {}),
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

/** The public notice board as a signed-out visitor reads it: published notices, newest first. */
export async function publishedNotices() {
  const { ctx } = await founders();
  return data(await ctx.edge.query('notify', 'notify.notices', { limit: 50 }), 'notify.notices');
}

/** Founder `key` ('a' or 'b') publishes a draft with an approval it holds. Returns the refusal code, or null when published. */
export async function publishAs(key, { id, approvalId, operationId }) {
  const { ctx, pair } = await founders();
  const res = await ctx.edge.mutate(
    'notify',
    'notify.publishNotice',
    { id, clientRequestId: `journey:notice-publish:${approvalId}:${key}`, approvalId, operationId },
    await pair[key].tradeOpsToken(),
  );
  if (res.json?.result?.data) return null;
  const code = res.json?.error?.data?.cause?.code;
  if (!code) throw new Error(`notify.publishNotice failed without a code (${res.status}): ${res.text.slice(0, 300)}`);
  return code;
}
