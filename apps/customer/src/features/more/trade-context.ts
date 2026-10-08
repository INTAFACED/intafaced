/** Carry an explicitly selected Paper journey through related links. A
 * destination that declares its own mode keeps that explicit choice. */
export function preservePaperHref(href: string, paper: boolean): string {
  if (!paper) return href;
  const url = new URL(href, 'https://customer.invalid');
  if (!url.searchParams.has('simulated')) url.searchParams.set('simulated', 'true');
  return url.pathname + url.search + url.hash;
}
