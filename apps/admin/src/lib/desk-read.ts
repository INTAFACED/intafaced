import type { ProcedureRecord, TrpcTransport } from '@intafaced/contracts/procedure';
import type { DeskModule } from '@/lib/desk';

/**
 * A desk read's call by its written record. It lives outside the ops desk's server-only entry so that a read spec in a
 * file a client component also reads (admin's account search) names its call by record without pulling server code into
 * the browser bundle.
 */
export type DeskReadRecord = ProcedureRecord & TrpcTransport & { readonly kind: 'query'; readonly module: DeskModule };

/** A read whose call has a record: its module and path are the record's, never typed again here. */
export const readOf = (record: DeskReadRecord) => ({ recordName: record.name, module: record.module, procedure: record.path });
