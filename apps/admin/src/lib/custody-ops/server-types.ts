import type { Part } from '@/lib/desk/part';
import type { CustodyApprover, CustodyTask } from './model';

export interface CustodyOpsRead {
  /** When the console server read svc-pay. Every row below is as of this time. */
  readonly asOf: string;
  readonly pending: Part<readonly CustodyTask[]>;
  readonly recent: Part<readonly CustodyTask[]>;
  readonly approvers: Part<readonly CustodyApprover[]>;
}

/** How many rows each read asks for. They are reading windows, not product limits: the page says how many it shows. */
export const PENDING_WINDOW = 50;
export const RECENT_WINDOW = 30;
