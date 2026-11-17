import './desk.css';
import type { QuantPromotionAudit, QuantStage } from '@intafaced/contracts/quant-algo';
import { formatAsOf } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';

/**
 * PROMOTION AUDIT (AL-lifecycle-01, J-algo-dev-13 #3), on the quant desk. Every gate decision svc-quant stores, newest
 * first. Each row is one press of Promote that reached the gate: its audit row (the decision, who pressed, the runs the
 * gate read and the owner criteria it judged by) and the one stage row an approval wrote; a rejection wrote none. A read
 * only: nothing here writes.
 */

const STAGE_WORDS: Record<QuantStage, string> = {
  draft: 'Draft',
  backtested: 'Backtested',
  validated: 'Validated',
  paper: 'Paper',
  candidate: 'Candidate',
  live: 'Live',
  paused: 'Paused',
  stopped: 'Stopped',
  killed: 'Killed',
  retired: 'Retired',
};

const CRITERION_WORDS: Record<string, string> = {
  paperMinutes: 'Shortest paper run (minutes)',
  maxDrawdownPercent: 'Largest backtest drawdown (percent)',
};

export function QuantPromotionAuditDesk({ audit }: { audit: Part<QuantPromotionAudit> }) {
  return (
    <section className="dk dk-stack" data-testid="quant-promotion-audit" aria-labelledby="h-quant-promotion-audit">
      <h2 id="h-quant-promotion-audit">Promotion audit</h2>
      <p className="dk-muted">
        Every promotion the gate decided, newest first: one audit row per decision, with the criteria the gate judged by, and the one stage
        row an approval wrote. A rejection writes no stage row.
      </p>
      {audit.kind === 'failed' ? (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="promotion-audit-failed" data-code={audit.code ?? ''}>
          <strong>Could not read the promotion audit</strong>
          <p>{audit.message}</p>
          {audit.code && <p className="dk-muted">Code: {audit.code}</p>}
        </div>
      ) : (
        <>
          <p className="dk-asof" data-testid="promotion-audit-count" data-total={audit.data.total} data-shown={audit.data.rows.length}>
            {audit.data.total === audit.data.rows.length
              ? `${audit.data.total} ${audit.data.total === 1 ? 'decision' : 'decisions'} stored.`
              : `The newest ${audit.data.rows.length} of ${audit.data.total} decisions stored.`}{' '}
            Read {formatAsOf(audit.data.asOf)}
          </p>
          {audit.data.rows.length === 0 ? (
            <p className="dk-muted" data-testid="promotion-audit-empty">
              No promotion has reached the gate yet.
            </p>
          ) : (
            <table className="adm-table" data-testid="promotion-audit-table">
              <thead>
                <tr>
                  <th scope="col">Strategy and version</th>
                  <th scope="col">Account</th>
                  <th scope="col">Audit row</th>
                  <th scope="col">Criteria used</th>
                  <th scope="col">Stage row</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.rows.map((row) => (
                  <tr
                    key={row.key}
                    data-testid="promotion-audit-row"
                    data-key={row.key}
                    data-strategy-id={row.strategyId}
                    data-strategy-version={row.strategyVersion}
                    data-decision={row.decision.decision}
                    data-stages={row.stage ? 1 : 0}
                  >
                    <td>
                      <code>{row.strategyId}</code> v{row.strategyVersion}
                    </td>
                    <td>
                      <code>{row.accountId}</code>
                    </td>
                    <td data-testid="promotion-audit-decision" data-actor={row.actor} data-run-ids={row.decision.runIds.join(',')}>
                      {row.decision.decision === 'approved' ? 'Approved' : 'Rejected'} at {formatAsOf(row.decision.at)} by{' '}
                      <code>{row.actor}</code>
                      {row.decision.runIds.length > 0 && <> · runs read: {row.decision.runIds.join(', ')}</>}
                    </td>
                    <td>
                      <ul>
                        {row.decision.criteria.map((c) => (
                          <li key={c.name} data-testid="promotion-audit-criterion" data-name={c.name} data-value={c.value ?? ''}>
                            {CRITERION_WORDS[c.name] ?? c.name}: {c.value ?? 'not set'}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td data-testid="promotion-audit-stage" data-from={row.stage?.from ?? ''} data-to={row.stage?.to ?? ''}>
                      {row.stage
                        ? `${STAGE_WORDS[row.stage.from]} → ${STAGE_WORDS[row.stage.to]} at ${formatAsOf(row.stage.at)}`
                        : 'None: the gate rejected it'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
