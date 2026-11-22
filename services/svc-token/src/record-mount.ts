import type { ProcedureRecord, TrpcTransport } from '@intafaced/contracts/procedure';
import { mountRecord, type RecordHandler } from '@intafaced/contracts/procedure-mount';
import { tokenRefusal } from './record-refusal.js';

/**
 * One svc-token call mounted from its record: `mountRecord(record, handler, tokenRefusal)`. The router (not made from
 * records as a whole yet) places it at the record's path.
 */
export function mountTokenRecord<const R extends ProcedureRecord & TrpcTransport>(record: R, handler: RecordHandler<R>) {
  return mountRecord(record, handler, tokenRefusal);
}
