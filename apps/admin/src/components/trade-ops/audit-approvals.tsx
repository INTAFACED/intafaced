'use client';

import { Badge } from '@intafaced/ui';
import { auditRowsFromApprovalLog } from '@/lib/trade-ops/audit-rows';
import { AuditTable } from './audit-table';
import { useApprovalLog } from './approvals-log';

/**
 * The approvals this browser tab proposed, approved, rejected or revoked. Identity cannot list approvals, so this
 * is NOT a service record: it starts empty, ends when the tab closes, and does not show other operators' actions.
 */
export function AuditApprovals() {
  const log = useApprovalLog();
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        <Badge density="dense">This session only</Badge>
        Approval actions you took in this tab. To check any approval, act on it by id in Freezes &amp; approvals.
      </p>
      <AuditTable
        label="Approval actions in this session"
        rows={auditRowsFromApprovalLog(log)}
        emptyText="No approval actions in this session yet."
      />
    </div>
  );
}
