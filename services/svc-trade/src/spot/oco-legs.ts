/**
 * A sell OCO is ONE order row with ONE hold. The engine rests it as two legs under derived ids
 * (`<orderId>:tp`, `<orderId>:sl`), so every engine event that names a leg is settled against the parent.
 */
const LEG_SUFFIX = /^(.+):(tp|sl)$/;

/** The parent order id for an engine leg id, or null when the id is not an OCO leg. */
export function ocoLegParent(id: string): string | null {
  const m = LEG_SUFFIX.exec(id);
  return m ? (m[1] as string) : null;
}

/** The parent id for a leg id, or the id itself for an ordinary order. */
export function settlementOrderId(id: string): string {
  return ocoLegParent(id) ?? id;
}

/** The other leg of the pair. */
export function ocoOtherLeg(legId: string): string | null {
  const m = LEG_SUFFIX.exec(legId);
  return m ? `${m[1]}:${m[2] === 'tp' ? 'sl' : 'tp'}` : null;
}
