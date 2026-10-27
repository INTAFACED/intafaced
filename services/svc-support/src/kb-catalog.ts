/**
 * Support Stage-2 — KB catalog (TRK-ops.support / ops.kb-workflow content).
 *
 * i18n-keyed articles only. No third-party product/vendor names in keys.
 * No money advice that invents rates or refund amounts.
 * No SLA timings.
 */

import type { SupportKbArticle } from '@intafaced/contracts';
import { en } from '@intafaced/i18n';

/**
 * Day-one platform KB spine. Keys are catalog ids for @intafaced/i18n —
 * strings here are keys, not user-facing English copy.
 */
export const PLATFORM_KB_SPINE: readonly SupportKbArticle[] = [
  {
    id: 'kb-account-access',
    titleKey: 'support.kb.account_access.title',
    bodyKey: 'support.kb.account_access.body',
    version: 1,
    revision: 1,
    published: true,
  },
  {
    id: 'kb-security-basics',
    titleKey: 'support.kb.security_basics.title',
    bodyKey: 'support.kb.security_basics.body',
    version: 1,
    revision: 1,
    published: true,
  },
  {
    id: 'kb-orders-status',
    titleKey: 'support.kb.orders_status.title',
    bodyKey: 'support.kb.orders_status.body',
    version: 1,
    revision: 1,
    published: true,
  },
  {
    id: 'kb-deposit-withdraw-honest',
    titleKey: 'support.kb.deposit_withdraw.title',
    bodyKey: 'support.kb.deposit_withdraw.body',
    version: 1,
    revision: 1,
    published: true,
  },
  {
    id: 'kb-paper-vs-live',
    titleKey: 'support.kb.paper_vs_live.title',
    bodyKey: 'support.kb.paper_vs_live.body',
    version: 1,
    revision: 1,
    published: true,
  },
  {
    id: 'kb-security-scam-tactics',
    titleKey: 'support.kb.scam_tactics.title',
    bodyKey: 'support.kb.scam_tactics.body',
    version: 1,
    revision: 1,
    published: true,
    category: 'security',
    tags: ['scams'],
  },
  {
    id: 'kb-security-spoofed-sms',
    titleKey: 'support.kb.spoofed_sms.title',
    bodyKey: 'support.kb.spoofed_sms.body',
    version: 1,
    revision: 1,
    published: true,
    category: 'security',
    tags: ['scams'],
  },
  {
    id: 'kb-security-dusting',
    titleKey: 'support.kb.dusting.title',
    bodyKey: 'support.kb.dusting.body',
    version: 1,
    revision: 1,
    published: true,
    category: 'security',
    tags: ['scams'],
  },
  {
    id: 'kb-security-email-compromise',
    titleKey: 'support.kb.email_compromise.title',
    bodyKey: 'support.kb.email_compromise.body',
    version: 1,
    revision: 1,
    published: true,
    category: 'security',
    tags: ['scams'],
  },
] as const;

/** Identity stays `id`; content generations are integer versions ≥ 1. */
export function kbVersionOf(article: Pick<SupportKbArticle, 'version' | 'revision'>): number {
  return article.version ?? article.revision ?? 1;
}

function isPublished(article: SupportKbArticle): boolean {
  return article.published !== false;
}

/**
 * One row per id — the highest version. Search/list never duplicate identities.
 */
export function latestById(catalog: readonly SupportKbArticle[]): SupportKbArticle[] {
  const best = new Map<string, SupportKbArticle>();
  const order: string[] = [];
  for (const article of catalog) {
    if (!best.has(article.id)) order.push(article.id);
    const current = best.get(article.id);
    if (!current || kbVersionOf(article) >= kbVersionOf(current)) best.set(article.id, article);
  }
  return order.map((id) => ({ ...best.get(id)! }));
}

/** Public doors: published === true only. Missing flag is not a public article. */
export function publishedOnly(catalog: readonly SupportKbArticle[]): SupportKbArticle[] {
  return latestById(catalog.filter((a) => a.published === true)).map(toPublicKb);
}

/**
 * Public wire: every article carries `version` (≥ 1). `revision` stays as the
 * operator CAS alias of the same integer. Store-only columns stay off the wire.
 */
export function toPublicKb(article: SupportKbArticle): SupportKbArticle {
  const version = kbVersionOf(article);
  return {
    id: article.id,
    titleKey: article.titleKey,
    bodyKey: article.bodyKey,
    version,
    revision: article.revision ?? version,
    ...(article.published != null ? { published: article.published } : {}),
    ...(article.category != null && article.category !== '' ? { category: article.category } : {}),
    ...(article.tags != null && article.tags.length > 0 ? { tags: [...article.tags] } : {}),
    // Public is the default and stays off the wire, so an article that was never restricted reads as it always did.
    ...(article.audience != null && article.audience !== 'public' ? { audience: article.audience } : {}),
    // Text typed in the desk (SP-kb-01). A catalogue-keyed article carries none of these.
    ...(article.title != null && article.body != null && article.language != null
      ? { title: article.title, body: article.body, language: article.language }
      : {}),
    ...(article.sectionId != null ? { sectionId: article.sectionId } : {}),
  };
}

/**
 * Published articles that share a category or a tag with `id`.
 * The article itself is never included. Unpublished rows are not in
 * `publishedOnly`, so they cannot appear. No category and no tags → empty.
 * A missing or unpublished id is empty (the public door does not confirm it).
 */
export function relatedPublished(id: string, catalog: readonly SupportKbArticle[]): SupportKbArticle[] {
  const published = publishedOnly(catalog);
  const source = published.find((article) => article.id === id);
  if (!source) return [];
  const category = source.category ?? null;
  const tags = new Set(source.tags ?? []);
  if (category == null && tags.size === 0) return [];
  return published.filter((article) => {
    if (article.id === source.id) return false;
    const shareCategory = category != null && article.category === category;
    const shareTag = (article.tags ?? []).some((tag) => tags.has(tag));
    return shareCategory || shareTag;
  });
}

/** citedArticleIds max, reused so a tag list does not grow a new cap. */
const KB_TAG_MAX = 20;
/** publishKb titleKey / bodyKey input max. */
const KB_TOPIC_LEN = 200;

export function assertKbTopic(input: { category?: string | null; tags?: readonly string[] | null }): {
  category: string | null;
  tags: string[] | null;
} {
  const category = input.category?.trim() ?? '';
  if (category.length > KB_TOPIC_LEN) {
    throw new KbCatalogError('KB category is too long', 'support.kb_invalid');
  }
  if (category && VENDOR_SMELL.test(category)) {
    throw new KbCatalogError('KB keys must stay vendor-clean', 'support.kb_vendor_name');
  }
  const raw = input.tags ?? [];
  if (raw.length > KB_TAG_MAX) {
    throw new KbCatalogError('KB tags exceed the cited-article list bound', 'support.kb_invalid');
  }
  const tags: string[] = [];
  for (const tag of raw) {
    const trimmed = tag.trim();
    if (!trimmed || trimmed.length > KB_TOPIC_LEN) {
      throw new KbCatalogError('KB tag is empty or too long', 'support.kb_invalid');
    }
    if (VENDOR_SMELL.test(trimmed)) {
      throw new KbCatalogError('KB keys must stay vendor-clean', 'support.kb_vendor_name');
    }
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  return { category: category || null, tags: tags.length > 0 ? tags : null };
}

const VENDOR_SMELL = /\b(binance|coinbase|kraken|okx|bybit|deriv|metatrader|tradingview)\b/i;

/** Whether text a reader will see names a partner or vendor (the same list the keys are checked against). */
export function namesVendor(text: string): boolean {
  return VENDOR_SMELL.test(text);
}

export type KbCatalogErrorCode = 'support.kb_invalid' | 'support.kb_vendor_name' | 'support.kb_version_unknown';

export class KbCatalogError extends Error {
  constructor(
    message: string,
    readonly code: KbCatalogErrorCode,
  ) {
    super(message);
    this.name = 'KbCatalogError';
  }
}

function assertVersionNumber(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new KbCatalogError(`KB article ${label} must be an integer ≥ 1`, 'support.kb_invalid');
  }
}

/** Validate a single article shape — refuse empty keys and vendor smuggle in keys. */
export function assertKbArticle(article: SupportKbArticle): SupportKbArticle {
  if (!article.id?.trim() || !article.titleKey?.trim() || !article.bodyKey?.trim()) {
    throw new KbCatalogError('KB article requires id, titleKey, bodyKey', 'support.kb_invalid');
  }
  assertVersionNumber(article.version, 'version');
  assertVersionNumber(article.revision, 'revision');
  const blob = `${article.id} ${article.titleKey} ${article.bodyKey}`;
  if (VENDOR_SMELL.test(blob)) {
    throw new KbCatalogError('KB keys must stay vendor-clean', 'support.kb_vendor_name');
  }
  if (!article.titleKey.startsWith('support.kb.') || !article.bodyKey.startsWith('support.kb.')) {
    throw new KbCatalogError('KB keys must live under support.kb.*', 'support.kb_invalid');
  }
  return article;
}

/** List platform spine (immutable copy of latest published). */
export function listPlatformKb(): readonly SupportKbArticle[] {
  return publishedOnly(PLATFORM_KB_SPINE).map((a) => assertKbArticle({ ...a }));
}

/** The English title a catalogue-keyed article shows (the copy catalogue's text for its key), or null without one. */
function publishedTitle(titleKey: string): string | null {
  const text = (en as Readonly<Record<string, unknown>>)[titleKey];
  return typeof text === 'string' ? text : null;
}

/**
 * How closely one article matches a query. A label (tag or category) outranks
 * a title, which outranks the body. Zero means it is not a hit.
 */
function kbSearchScore(article: SupportKbArticle, q: string): number {
  const labels = [...(article.tags ?? []), ...(article.category ? [article.category] : [])].map((label) => label.toLowerCase());
  let score = 0;
  if (labels.some((label) => label === q)) score += 300;
  else if (labels.some((label) => label.includes(q))) score += 200;
  // A version typed in the desk is matched on its text; a catalogue-keyed one on its keys and on the title people read.
  const title = article.title ?? article.titleKey;
  const body = article.body ?? article.bodyKey;
  const shown = article.title === undefined ? publishedTitle(article.titleKey) : null;
  if (title.toLowerCase().includes(q) || (shown !== null && shown.toLowerCase().includes(q))) score += 100;
  if (article.id.toLowerCase().includes(q)) score += 80;
  if (body.toLowerCase().includes(q)) score += 10;
  return score;
}

/**
 * Search by id, title, body, tag or category. Empty query → latest per id, in
 * catalog order. A non-empty query is ranked: a labelled article comes before
 * one that only mentions the word in the body. Ties keep catalog order.
 * Empty catalog and unknown queries stay empty — never a default article.
 * Duplicate ids collapse to the highest version (search is latest-only).
 */
export function searchKb(query: string, catalog: readonly SupportKbArticle[] = PLATFORM_KB_SPINE): readonly SupportKbArticle[] {
  if (catalog.length === 0) return [];
  const unique = latestById(catalog);
  const q = query.trim().toLowerCase();
  if (!q) return unique.map((a) => ({ ...a }));
  return unique
    .map((article, index) => ({ article, index, score: kbSearchScore(article, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => ({ ...row.article }));
}

/**
 * Read one article.
 * - omitted version → latest published (null when missing / unpublished)
 * - explicit version → that immutable body, or named refuse (never a silent older body)
 */
export function getKb(
  query: { id: string; version?: number },
  catalog: readonly SupportKbArticle[] = PLATFORM_KB_SPINE,
): SupportKbArticle | null {
  const id = query.id.trim();
  if (!id || catalog.length === 0) return null;
  const rows = catalog.filter((a) => a.id === id);
  if (query.version === undefined) {
    const published = rows.filter(isPublished);
    if (published.length === 0) return null;
    return { ...latestById(published)[0]! };
  }
  const hit = rows.find((a) => kbVersionOf(a) === query.version);
  if (!hit) {
    throw new KbCatalogError('support.kb_version_unknown', 'support.kb_version_unknown');
  }
  return { ...hit };
}

export function getKbById(id: string, catalog: readonly SupportKbArticle[] = PLATFORM_KB_SPINE): SupportKbArticle | null {
  return getKb({ id }, catalog);
}
