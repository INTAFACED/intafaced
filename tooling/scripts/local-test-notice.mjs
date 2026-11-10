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
 * one and the audience when it is not everyone, a changelog entry's fields and the other-language text when it has any.
 * A fee change adds the time it takes effect. No reminder fields (nothing here drafts those). The keys go in
 * svc-notify's order (notices/board.ts payloadHash).
 */
export function noticePayloadHash(row) {
  const status = row.statusFields;
  const withStatus = status && (status.impact || status.components.length > 0 || status.parentId || status.resolves) ? { status } : {};
  const [asset, network, phase] = [row.asset ?? null, row.network ?? null, row.phase ?? null];
  const withScope = asset !== null || phase !== null ? { scope: { asset, network, phase } } : {};
  // A changelog entry's fields, as svc-notify stored and answered them on the draft.
  const withChangelog = row.changelog ? { changelog: row.changelog } : {};
  const withCategory = row.category ? { category: row.category } : {};
  const withAudience = row.audience && row.audience !== 'everyone' ? { audience: row.audience } : {};
  const withEffective = row.kind === 'fee_change' ? { effectiveAt: row.startsAt ?? null } : {};
  // The other-language text, in language order, as svc-notify's translationsForHash writes it (J-cex-spot-15 #2).
  const translations = Object.entries(row.translations ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([language, text]) => [language, { title: text.title, body: text.body }]);
  const withTranslations = translations.length ? { translations } : {};
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
        ...withChangelog,
        ...withCategory,
        ...withAudience,
        ...withTranslations,
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
