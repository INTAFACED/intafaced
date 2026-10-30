import type { ActionApprovalPolicyEntry } from '@intafaced/contracts';
import { formatAsOf } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import '../desk.css';

/**
 * Approval policy per governed action type (OPS-change-control-01 CR-1). svc-identity reads the owner setting on every
 * request; this room shows what it reads now. It edits nothing: the rows are owner values set in the deployment.
 */

export interface ChangePolicyRoomProps {
  readonly asOf: string;
  readonly policies: Part<readonly ActionApprovalPolicyEntry[]>;
}

const AUDIENCE_WORDS: Record<string, string> = {
  founder: 'Founders',
  operator: 'Operators',
  trade_ops: 'Trade operators',
};

function Row({ entry }: { entry: ActionApprovalPolicyEntry }) {
  if (entry.state === 'unset') {
    return (
      <tr data-testid="policy-row" data-state="unset">
        <th scope="row">
          <code>{entry.actionType}</code>
        </th>
        <td colSpan={4}>
          <strong>Unset.</strong> svc-identity refuses to propose, approve or apply this action until the owner sets a row.{' '}
          <span className="dk-muted">Code: {entry.code}</span>
        </td>
      </tr>
    );
  }
  const p = entry.policy;
  return (
    <tr data-testid="policy-row" data-state="set">
      <th scope="row">
        <code>{entry.actionType}</code>
      </th>
      <td>{p.requiredApprovals} other than the requester</td>
      <td>{AUDIENCE_WORDS[p.approverAudience] ?? p.approverAudience}</td>
      <td>
        <code>{p.applier}</code>
      </td>
      <td>{p.maxAgeSeconds} s</td>
    </tr>
  );
}

export function ChangePolicyRoom({ asOf, policies }: ChangePolicyRoomProps) {
  return (
    <section className="dk-stack" aria-label="Approval policy" data-testid="change-policy">
      <h2>Approval policy</h2>
      <p className="dk-muted">
        Read {formatAsOf(asOf)}. Each governed action needs this many distinct approvers other than the requester, from this audience,
        applied only by this service, within this age. A request is bound to the row it was proposed under; if the row changes, the request
        is refused and must be proposed again.
      </p>
      <p className="dk-muted">Read only. The rows are owner settings of the deployment; this console does not change them.</p>
      {policies.kind === 'failed' ? (
        <div
          className="adm-callout"
          data-tone={policies.forbidden || policies.notBuilt ? 'warn' : 'danger'}
          role="status"
          data-testid="policy-failed"
        >
          <strong>{policies.forbidden ? 'Access refused' : 'The policy could not be read'}</strong>
          <p>{policies.message}</p>
          {policies.code && <p className="dk-muted">Code: {policies.code}</p>}
          <p className="dk-muted">Nothing is shown here rather than a guess.</p>
        </div>
      ) : policies.data.length === 0 ? (
        <p data-testid="policy-empty">svc-identity names no governed action type.</p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Policy rows" tabIndex={0}>
          <table className="adm-table" data-testid="policy-table">
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Approvals</th>
                <th scope="col">Who may approve</th>
                <th scope="col">Applied by</th>
                <th scope="col">Longest life</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((entry) => (
                <Row key={entry.actionType} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
