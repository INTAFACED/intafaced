/**
 * A short, readable stand-in for a long identifier. Customers can quote it to support; the full value stays behind a
 * "Details" disclosure or in a tooltip, never in body copy.
 */
export function shortReference(id: string): string {
  return id
    .replace(/[^0-9a-z]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}
