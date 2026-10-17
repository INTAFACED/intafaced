'use client';

import { useEffect, useState } from 'react';
import { appendLog, loadLog, saveLog, type ApprovalLogEntry } from '@/lib/trade-ops/approvals';

/**
 * This tab's own record of approval actions (propose, approve, reject, revoke). Kept in sessionStorage: it ends
 * when the tab closes, it is not the service's record, and every screen that shows it says "this session only".
 * Identity has no list or read-back, so this is the only way an operator sees what they did.
 */
const EVENT = 'trops-approval-log';

export function recordApproval(entry: ApprovalLogEntry): void {
  try {
    saveLog(window.sessionStorage, appendLog(loadLog(window.sessionStorage), entry));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage blocked: the action already happened; only the convenience log is lost */
  }
}

export function useApprovalLog(): ApprovalLogEntry[] {
  const [log, setLog] = useState<ApprovalLogEntry[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        setLog(loadLog(window.sessionStorage));
      } catch {
        setLog([]);
      }
    };
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  return log;
}
