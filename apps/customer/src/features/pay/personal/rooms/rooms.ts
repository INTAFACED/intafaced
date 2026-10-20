import { matchPath } from '../../../../app/path-match';

/**
 * The personal Pay rooms behind Request detail, Scheduled, Contacts, a payment, a claim, cases, limits, fees, preferences,
 * Scan and the rest (PP-order-02). Each has an address and a layout. Where nothing stands behind a room yet it says what is
 * missing; it never shows a made-up figure.
 */
export type PersonalRoomId =
  | 'request'
  | 'scheduled'
  | 'contacts'
  | 'payment'
  | 'claim'
  | 'cases'
  | 'case'
  | 'limits'
  | 'fees'
  | 'preferences'
  | 'scan'
  | 'link'
  | 'invoice'
  | 'group'
  | 'pool';

export interface PersonalRoomDef {
  id: PersonalRoomId;
  pattern: string;
  /** The slice that unblocks the room. Kept for the registry and tests; the screen says it in plain words. */
  slice: string;
}

// Longer addresses first is not needed: no pattern here can match another's path.
export const personalRooms: readonly PersonalRoomDef[] = [
  { id: 'request', pattern: '/pay/request/:requestId', slice: 'PP-send-request-12' },
  { id: 'scheduled', pattern: '/pay/scheduled', slice: 'PP-send-request-06' },
  { id: 'contacts', pattern: '/pay/contacts', slice: 'PP-send-request-04' },
  { id: 'group', pattern: '/pay/contacts/groups/:groupId', slice: 'PP-send-request-15' },
  { id: 'pool', pattern: '/pay/contacts/pools/:poolId', slice: 'PP-send-request-15' },
  { id: 'payment', pattern: '/pay/history/:transferId', slice: 'PP-disputes-safety-22' },
  { id: 'claim', pattern: '/pay/claim/:token', slice: 'PP-send-request-08' },
  { id: 'cases', pattern: '/pay/cases', slice: 'PP-disputes-safety-22' },
  { id: 'case', pattern: '/pay/cases/:caseId', slice: 'PP-disputes-safety-22' },
  { id: 'limits', pattern: '/pay/send/limits', slice: 'PP-send-request-07' },
  { id: 'fees', pattern: '/pay/fees', slice: 'PP-send-request-07' },
  { id: 'preferences', pattern: '/pay/preferences', slice: 'PP-send-request-06' },
  { id: 'scan', pattern: '/pay/scan', slice: 'PP-send-request-11' },
  { id: 'link', pattern: '/pay/l/:linkId', slice: 'PP-send-request-12' },
  { id: 'invoice', pattern: '/pay/bills/invoices/:invoiceId', slice: 'PP-send-request-19' },
];

export interface PersonalRoomMatch {
  room: PersonalRoomDef;
  params: Record<string, string>;
}

/** The personal room that owns `path` (query string ignored), or undefined when it is not one. */
export function personalRoomFor(path: string): PersonalRoomMatch | undefined {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  for (const room of personalRooms) {
    const params = matchPath(room.pattern, clean);
    if (params) return { room, params };
  }
  return undefined;
}

/** `/pay/request/<id>` for a request this device made. */
export const requestRoomHref = (id: string): string => `/pay/request/${encodeURIComponent(id)}`;

/** An address segment as text, or null when it will not decode. */
export function decodedSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
