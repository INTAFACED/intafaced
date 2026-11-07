import type { TradeAuditRow } from '@/lib/trade-ops/order-read';

/** svc-trade's operator audit rows (J-cex-spot-18 #5): who did what to which account and object, and when. */
export function TradeAuditTable({ rows }: { rows: readonly TradeAuditRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-fg-2">No trade operator audit rows match.</p>;
  return (
    <table aria-label="Audit rows" className="w-full text-sm">
      <thead>
        <tr className="text-fg-3">
          <th className="text-start font-normal">When (UTC)</th>
          <th className="text-start font-normal">What</th>
          <th className="text-start font-normal">Operator</th>
          <th className="text-start font-normal">Customer account</th>
          <th className="text-start font-normal">Object</th>
          <th className="text-start font-normal">Second operator</th>
          <th className="text-start font-normal">Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-audit-id={row.id}>
            <td className="if-num">
              <time dateTime={row.occurredAt}>{row.occurredAt.replace('T', ' ').slice(0, 19)}</time>
            </td>
            <td className="if-num">{row.kind}</td>
            <td className="if-num break-all" data-testid="audit-operator">
              {row.operatorId}
            </td>
            <td className="if-num break-all" data-testid="audit-account">
              {row.accountId ?? 'None'}
            </td>
            <td className="if-num break-all">{row.objectId}</td>
            <td className="if-num break-all">{row.approverId ?? 'None'}</td>
            <td>{row.reason ?? 'None given'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
