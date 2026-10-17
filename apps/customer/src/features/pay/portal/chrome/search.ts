export type SearchPage = { href: string; label: string; group: string };

/** Pages whose name, or whose tab's name, contains every word typed. An empty search lists them all. */
export function pageMatches(pages: readonly SearchPage[], query: string): SearchPage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pages.filter((page) => {
    const hay = `${page.label} ${page.group}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A pasted payment ID goes straight to that payment. Anything else is a page search. */
export function paymentTarget(query: string): string | null {
  const id = query.trim();
  return PAYMENT_ID.test(id) ? `/pay/payments/${encodeURIComponent(id)}` : null;
}
