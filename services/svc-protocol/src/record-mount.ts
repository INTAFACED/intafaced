import type { ProcedureRecord, TrpcTransport } from '@intafaced/contracts/procedure';
import { mountRecord, type RecordHandler } from '@intafaced/contracts/procedure-mount';
import { protocolRefusal } from './refusal.js';

/**
 * One svc-protocol call mounted from its record: `mountRecord(record, handler, protocolRefusal)`, the handler and the mounted
 * procedure typed by the record. The router (not made from records as a whole yet) places it at the record's path.
 */
export function mountProtocolRecord<const R extends ProcedureRecord & TrpcTransport>(record: R, handler: RecordHandler<R>) {
  return mountRecord(record, handler, protocolRefusal);
}
