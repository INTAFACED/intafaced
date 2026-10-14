import type { Article, Category, TicketStatus } from './support-api';
import { categories } from './support-api';

/** Help articles that describe features this release does not offer (Deposits and withdrawals, Paper vs live). */
const HIDDEN_FEATURE_ARTICLES: ReadonlySet<string> = new Set(['kb-deposit-withdraw-honest', 'kb-paper-vs-live']);

/**
 * Articles worth showing: published, not about a hidden feature, and with text we can actually read (a missing translation key
 * would otherwise show up as a raw code).
 */
export function visibleArticles(
  rows: readonly Article[],
  text: (key: string) => string | null,
  depositsHidden: boolean,
): Array<{ id: string; title: string; body: string }> {
  const out: Array<{ id: string; title: string; body: string }> = [];
  for (const row of rows) {
    if (row.published === false) continue;
    if (depositsHidden && HIDDEN_FEATURE_ARTICLES.has(row.id)) continue;
    const title = text(row.titleKey);
    const body = text(row.bodyKey);
    if (title && body) out.push({ id: row.id, title, body });
  }
  return out;
}

/** The categories a person may pick: deposits and withdrawals only while that feature is on. */
export function pickableCategories(depositsHidden: boolean): Category[] {
  return categories.filter((value) => !(depositsHidden && value === 'deposit_withdraw'));
}

/** A request that can still take a reply. */
export const canReply = (status: TicketStatus) => status !== 'closed';

/** Splits a free-text reply into paragraphs for display. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}
