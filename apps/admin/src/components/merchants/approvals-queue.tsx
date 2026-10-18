import type { PayoutApproval } from '@intafaced/contracts';
import {
  approvalAmountText,
  approvalKpis,
  approvalsCsv,
  filterApprovals,
  hasApprovalFilter,
  sortApprovals,
  tookPart,
  type ApprovalQuery,
} from '@/lib/merchants/approvals-model';
import { payoutApprovalChip, type ChipSpec } from '@/lib/merchants/chips';
import { ageView, waitedText } from '@/lib/merchants/control-model';
import type { ApprovalsPageData } from '@/lib/merchants/loaders';
import { formatUtc } from '@/lib/merchants/time';
import { ApprovalDecision } from './approval-decision';
import { CsvButton } from './csv-button';
import { AsOf, Card, FailureState, KpiTile, MerchantLabel, PageHead, shortId, StateBlock, StatusChip, UNNAMED_MERCHANT } from './ui';

const ASSETS_NOTE = 'Amounts are per asset and never added across assets.';

function ageChips(a: PayoutApproval, now: Date) {
  const v = ageView(a.createdAt, a.expiresAt, now);
  const expiry: ChipSpec = { label: v.expiry.label, tone: v.expiry.tone, hint: v.expiry.hint };
  return { age: v.age, expiry };
}

export function ApprovalsTable({
  rows,
  names,
  now,
  currentUserId,
  showMerchant = true,
}: {
  rows: readonly PayoutApproval[];
  names: ReadonlyMap<string, string | null>;
  now: Date;
  currentUserId: string | undefined;
  showMerchant?: boolean;
}) {
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label="Approvals table, scrolls sideways on small screens">
      <table className="mp-table mp-table--rows mp-table--cards">
        <caption className="mp-visually-hidden">Payouts waiting for two founders</caption>
        <thead>
          <tr>
            {showMerchant ? <th scope="col">Merchant</th> : null}
            <th scope="col" className="mp-right">
              Payout
            </th>
            <th scope="col">Status</th>
            <th scope="col">Requested</th>
            <th scope="col">Time left</th>
            <th scope="col">Merchant’s approver</th>
            <th scope="col">Your decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const { age, expiry } = ageChips(a, now);
            const name = names.get(a.merchantId);
            const merchantText = name ? name : `${UNNAMED_MERCHANT} ${shortId(a.merchantId)}`;
            return (
              <tr key={a.approvalId}>
                {showMerchant ? (
                  <td data-label="Merchant">
                    <MerchantLabel merchantId={a.merchantId} displayName={name ?? null} href={`/merchants/${a.merchantId}?tab=approvals`} />
                  </td>
                ) : null}
                <td className="mp-right mp-num" data-label="Payout">
                  {approvalAmountText(a)}
                  <a className="mp-sub mp-block" href={`/approvals/${a.approvalId}`}>
                    Details
                  </a>
                </td>
                <td data-label="Status">
                  <StatusChip spec={payoutApprovalChip(a.status)} />
                  <span className="mp-sub mp-block">needs two founders</span>
                </td>
                <td data-label="Requested">
                  <span className="mp-num">{formatUtc(a.createdAt)}</span>
                  <span className="mp-sub mp-block">{age}</span>
                </td>
                <td data-label="Time left">
                  <StatusChip spec={expiry} />
                </td>
                <td data-label="Merchant’s approver">
                  {a.checkerUserId ? (
                    <code className="mp-sub" title={a.checkerUserId}>
                      {shortId(a.checkerUserId)}
                    </code>
                  ) : (
                    <span className="mp-muted">—</span>
                  )}
                </td>
                <td data-label="Your decision">
                  <ApprovalDecision
                    subject={{
                      approvalId: a.approvalId,
                      payloadHash: a.payloadHash,
                      amountText: approvalAmountText(a),
                      merchantText,
                      createdAt: a.createdAt,
                      expiresAt: a.expiresAt,
                      tookPart: tookPart(a, currentUserId),
                      expired: expiry.tone === 'danger',
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ApprovalsQueueView({
  data,
  query,
  now,
  currentUserId,
}: {
  data: ApprovalsPageData;
  query: ApprovalQuery;
  now: Date;
  currentUserId: string | undefined;
}) {
  const here = '/merchants/approvals';
  const fresh = { asOf: data.readAt, lagSeconds: 0 };
  const queue = data.queue.kind === 'ok' ? data.queue.data : null;
  const all = queue?.approvals ?? [];
  const kpi = approvalKpis(all, now, currentUserId);
  const visible = sortApprovals(filterApprovals(all, query, data.names, now), query.sort);
  const assets = [...new Set(all.map((a) => a.assetCode))].sort();
  const oldest = kpi.oldestCreatedAt === null ? null : waitedText(kpi.oldestCreatedAt, now);

  return (
    <div className="mp-page">
      <PageHead
        title="Founder approvals"
        purpose="Payouts that a merchant’s own team approved and that now wait for two different founders. Each row shows how long it has waited and how much of its own time is left."
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
        actions={
          queue ? (
            <CsvButton
              csv={approvalsCsv(
                visible,
                data.names,
                now.toISOString(),
                data.readAt,
                hasApprovalFilter(query) ? 'Filtered view.' : 'All waiting approvals.',
              )}
              filename={`approvals-${now.toISOString().slice(0, 10)}.csv`}
              count={visible.length}
            />
          ) : undefined
        }
      />

      {queue ? (
        <div className="mp-kpis" role="group" aria-label="Approval counts">
          <KpiTile
            label="Waiting for founders"
            value={<span className="mp-num">{kpi.waiting}</span>}
            period={`Right now, as of ${formatUtc(data.readAt)}`}
            href={here}
          />
          <KpiTile
            label="Oldest request"
            value={oldest === null ? <span className="mp-muted">None waiting</span> : <span className="mp-num">{oldest}</span>}
            period="Time since it was asked for"
            href={`${here}?sort=oldest`}
          />
          <KpiTile
            label="Running out of time"
            value={<span className="mp-num">{kpi.expiringSoon}</span>}
            period="Last quarter of their own window"
            note={kpi.expired > 0 ? `${kpi.expired} already expired` : undefined}
            href={`${here}?urgent=1&sort=expiry`}
          />
          <KpiTile
            label="You took part in"
            value={<span className="mp-num">{kpi.involvingYou}</span>}
            period="You cannot sign these; another founder must"
          />
        </div>
      ) : null}

      <Card
        id="queue"
        title="Waiting for two founders"
        sub={`A different founder must sign each one; neither may be the person who asked or the merchant’s own approver. ${ASSETS_NOTE}`}
      >
        {data.queue.kind !== 'ok' ? (
          <FailureState failure={data.queue} what="The approvals queue" retryHref={here} />
        ) : (
          <>
            <AsOf freshness={fresh} label="Queue" />
            {queue && queue.truncated ? (
              <StateBlock kind="info" title="Showing the oldest part of a longer queue">
                More requests are waiting than this page reads at once. Work through these first; the rest appear as they are decided.
              </StateBlock>
            ) : null}
            <form className="mp-filters" method="get" action={here} aria-label="Filter approvals">
              <div className="mp-field mp-field--grow">
                <label htmlFor="ap-q">Search</label>
                <input
                  id="ap-q"
                  name="q"
                  className="mp-input"
                  type="search"
                  defaultValue={query.q}
                  placeholder="Merchant name or id, or approval id"
                  autoComplete="off"
                />
              </div>
              <div className="mp-field">
                <label htmlFor="ap-asset">Asset</label>
                <select id="ap-asset" name="asset" className="mp-input" defaultValue={query.asset}>
                  <option value="">Any asset</option>
                  {assets.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mp-field">
                <label htmlFor="ap-sort">Sort</label>
                <select id="ap-sort" name="sort" className="mp-input" defaultValue={query.sort}>
                  <option value="oldest">Oldest first</option>
                  <option value="newest">Newest first</option>
                  <option value="expiry">Running out of time first</option>
                </select>
              </div>
              <div className="mp-field mp-field--check">
                <label className="mp-check" htmlFor="ap-urgent">
                  <input id="ap-urgent" type="checkbox" name="urgent" value="1" defaultChecked={query.urgent} />
                  <span>Only running out of time</span>
                </label>
              </div>
              <div className="mp-filters__actions">
                <button type="submit" className="mp-btn mp-btn--primary">
                  Apply
                </button>
                {hasApprovalFilter(query) ? (
                  <a className="mp-btn" href={here}>
                    Clear
                  </a>
                ) : null}
              </div>
            </form>
            <p className="mp-rowcount" role="status">
              Showing {visible.length} of {all.length} waiting
            </p>
            {all.length === 0 ? (
              <StateBlock kind="empty" title="No payouts are waiting for founders">
                A payout appears here after a merchant asks for it and its own team approves, when the amount is at or above the founder
                threshold of its tier. Nothing is waiting right now.
              </StateBlock>
            ) : visible.length === 0 ? (
              <StateBlock
                kind="empty"
                title="Nothing matches these filters"
                action={
                  <a className="mp-btn" href={here}>
                    Clear filters
                  </a>
                }
              >
                {all.length} approval{all.length === 1 ? ' is' : 's are'} waiting, but none match.
              </StateBlock>
            ) : (
              <ApprovalsTable rows={visible} names={data.names} now={now} currentUserId={currentUserId} />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
