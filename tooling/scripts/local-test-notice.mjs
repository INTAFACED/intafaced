/**
 * The notice desk's four-eyes publish, as a founder pair drives it on the local test stack: founder a drafts, proposes
 * and publishes, founder b approves (svc-notify `notify.draftNotice` / `notify.publishNotice`, svc-identity
 * `actionApproval`). Shared by the tester seed (local-test-home.mjs) and the real-app journeys
 * (apps/customer/tests/real-app/notices.mjs), so both hash a draft the way svc-notify does.
 */
import { createHash } from 'node:crypto';

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/**
 * svc-notify's payload hash: id, kind, title, body and version, plus the incident status fields when the draft set any,
 * the asset, network and phase as stored (an update keeps its incident's pair) when it has any, the category when it names
 * one and the audience when it is not everyone. A fee change adds the time it takes effect. No changelog or reminder
 * fields (nothing here drafts those).
 */
export function noticePayloadHash(row) {
  const status = row.statusFields;
  const withStatus = status && (status.impact || status.components.length > 0 || status.parentId || status.resolves) ? { status } : {};
  const [asset, network, phase] = [row.asset ?? null, row.network ?? null, row.phase ?? null];
  const withScope = asset !== null || phase !== null ? { scope: { asset, network, phase } } : {};
  const withCategory = row.category ? { category: row.category } : {};
  const withAudience = row.audience && row.audience !== 'everyone' ? { audience: row.audience } : {};
  const withEffective = row.kind === 'fee_change' ? { effectiveAt: row.startsAt ?? null } : {};
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        version: row.version,
        ...withStatus,
        ...withScope,
        ...withCategory,
        ...withAudience,
        ...withEffective,
      }),
    )
    .digest('hex')}`;
}

/**
 * Publishes draft `row` with four eyes: a proposes, b approves, a publishes. `publishKey(approvalId)` names the publish
 * request; it should carry the approval id, so a refused publish under one approval never replays onto the next. Returns
 * the published row.
 */
export async function publishWithApproval({ edge, pair, policyVersion }, row, publishKey) {
  const proposal = {
    actionType: 'notify.notice.publish',
    targetService: 'svc-notify',
    targetId: row.id,
    expectedVersion: String(row.version),
    payloadHash: noticePayloadHash(row),
    policyVersion,
  };
  const proposed = data(
    await edge.mutate('identity', 'actionApproval.propose', proposal, await pair.a.approvalToken()),
    'actionApproval.propose',
  );
  const approved = data(
    await edge.mutate(
      'identity',
      'actionApproval.approve',
      { approvalId: proposed.approvalId, expectedPayloadHash: proposal.payloadHash },
      await pair.b.approvalToken(),
    ),
    'actionApproval.approve',
  );
  if (approved.status !== 'APPROVED') throw new Error(`approval ${proposed.approvalId} is ${approved.status}`);
  const res = await edge.mutate(
    'notify',
    'notify.publishNotice',
    { id: row.id, clientRequestId: publishKey(proposed.approvalId), approvalId: proposed.approvalId, operationId: proposed.operationId },
    await pair.a.tradeOpsToken(),
  );
  return data(res, 'notify.publishNotice');
}
