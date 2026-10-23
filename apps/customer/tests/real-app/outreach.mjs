import { createHash } from 'node:crypto';

// The founders' CRM on the local stack (svc-ops through Edge), as a founder uses it from the console: campaigns, the
// source keys an invite link carries, and the numbers per campaign. Ids and keys derive from the caller's key, so a
// retried call is the same call.

let gates;
let ctx;
let pair;

async function founder() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, token: await pair.a.crmToken() };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** A stable uuid for `seed`, so the same journey key names the same row. */
function uuidOf(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An active invite campaign and the source key its link carries. Returns { campaignId, sourceKey }. */
export async function inviteCampaign(key) {
  const { ctx, token } = await founder();
  const campaign = data(
    await ctx.edge.mutate(
      'ops',
      'outreach.upsertCampaign',
      {
        requestId: uuidOf(`campaign-request:${key}`),
        id: uuidOf(`campaign:${key}`),
        expectedRevision: 0,
        name: `LOCAL TEST invite ${key}`.slice(0, 120),
        channel: 'invite',
        status: 'active',
        documentRef: null,
        providerLinkId: null,
        reason: 'LOCAL TEST journey invite link',
      },
      token,
    ),
    'outreach.upsertCampaign',
  );
  const sourceKey = createHash('sha256').update(`source:${key}`).digest('hex').slice(0, 32);
  data(
    await ctx.edge.mutate(
      'ops',
      'outreach.upsertSourceMapping',
      {
        requestId: uuidOf(`mapping-request:${key}`),
        id: uuidOf(`mapping:${key}`),
        expectedRevision: 0,
        sourceKey,
        campaignId: campaign.id,
        status: 'active',
        reason: 'LOCAL TEST journey invite link',
      },
      token,
    ),
    'outreach.upsertSourceMapping',
  );
  return { campaignId: campaign.id, sourceKey };
}

/** The CRM's totals for one campaign: { submissions, opportunities, ... }. */
export async function campaignTotals(campaignId) {
  const { ctx, token } = await founder();
  return data(await ctx.edge.query('ops', 'outreach.metrics', { campaignId }, token), 'outreach.metrics').totals;
}
