/**
 * Support agent live desk port — HTTP/tRPC to svc-support KB + ticket read,
 * and identity's account projection (the same S2S path svc-support already uses).
 *
 * Live without a port is not a desk: the caller must refuse `no_live_kb` rather
 * than answering from fixture rows or memory. Fixture implementations exist for
 * tests only — production `index.ts` constructs the HTTP port iff SUPPORT_URL is set.
 */

import {
  accountStateSchema,
  serviceCallSigner,
  supportKbArticleSchema,
  supportTicketSchema,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { AgentError, assertKbSearchPageLimit } from '../errors.js';
import { accountProjectionHasInventMoney, type AccountProjectionFixture, type KbArticleFixture, type TicketFixture } from './data-tools.js';

export type DeskSearchResult =
  | { readonly status: 'ok'; readonly articles: readonly KbArticleFixture[] }
  | { readonly status: 'unreachable' }
  | {
      readonly status: 'refuse';
      readonly reason: 'kb_search_limit_unset';
      readonly userMessageKey: 'agents.refused.kb_search_limit_unset';
    };

export type DeskTicketResult =
  { readonly status: 'ok'; readonly ticket: TicketFixture } | { readonly status: 'missing' } | { readonly status: 'unreachable' };

export type DeskAccountResult =
  | { readonly status: 'ok'; readonly account: AccountProjectionFixture }
  | { readonly status: 'unread' }
  | { readonly status: 'unreachable' };

export type SupportDeskPort = {
  /**
   * Search published KB. `limit` is owner-published page size — omit refuses
   * named, never invents 100. Empty hits stay ok + [] (empty ≠ failed).
   */
  searchKb(query: string, limit?: number): Promise<DeskSearchResult>;
  getKb(id: string): Promise<DeskSearchResult>;
  readTicket(ticketId: string, headers?: Readonly<Record<string, string>>): Promise<DeskTicketResult>;
  readAccount(userId: string): Promise<DeskAccountResult>;
};

function articleFromContract(id: string, titleKey: string, bodyKey: string): KbArticleFixture {
  return { articleKey: id, titleKey, bodyKey };
}

function ticketFromContract(row: { id: string; userId: string; status: TicketFixture['status']; category: string }): TicketFixture {
  return {
    ticketId: row.id,
    ownerUserId: row.userId,
    status: row.status,
    category: row.category,
  };
}

function unwrapTrpc(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  const result = (body as { result?: { data?: unknown } }).result;
  const data = result?.data;
  if (data !== undefined) {
    if (data !== null && typeof data === 'object' && 'json' in data) {
      return (data as { json: unknown }).json;
    }
    return data;
  }
  return body;
}

function parseArticles(raw: unknown): KbArticleFixture[] | null {
  if (!Array.isArray(raw)) return null;
  const out: KbArticleFixture[] = [];
  for (const item of raw) {
    const parsed = supportKbArticleSchema.safeParse(item);
    if (!parsed.success) return null;
    out.push(articleFromContract(parsed.data.id, parsed.data.titleKey, parsed.data.bodyKey));
  }
  return out;
}

/**
 * In-memory desk for tests. Never constructed from production env.
 * Empty rows are empty — they do not invent articles or "account is fine".
 */
export function createFixtureSupportDesk(rows: {
  readonly articles?: readonly KbArticleFixture[];
  readonly tickets?: readonly TicketFixture[];
  readonly accounts?: readonly AccountProjectionFixture[];
  readonly unreadAccounts?: boolean;
}): SupportDeskPort {
  const articles = rows.articles ?? [];
  const tickets = rows.tickets ?? [];
  const accounts = rows.accounts ?? [];
  const unread = rows.unreadAccounts === true;

  return {
    async searchKb(query, limit) {
      let page: number;
      try {
        page = assertKbSearchPageLimit(limit);
      } catch (err) {
        if (err instanceof AgentError && err.code === 'agents.kb_search_limit_unset') {
          return {
            status: 'refuse' as const,
            reason: 'kb_search_limit_unset' as const,
            userMessageKey: 'agents.refused.kb_search_limit_unset' as const,
          };
        }
        throw err;
      }
      const q = query.trim().toLowerCase();
      const hits = !q
        ? articles
        : articles.filter(
            (a) => a.articleKey.toLowerCase().includes(q) || a.titleKey.toLowerCase().includes(q) || a.bodyKey.toLowerCase().includes(q),
          );
      return { status: 'ok', articles: hits.slice(0, page) };
    },
    async getKb(id) {
      const hit = articles.find((a) => a.articleKey === id);
      return { status: 'ok', articles: hit ? [hit] : [] };
    },
    async readTicket(ticketId) {
      const hit = tickets.find((t) => t.ticketId === ticketId);
      return hit ? { status: 'ok', ticket: hit } : { status: 'missing' };
    },
    async readAccount(userId) {
      if (unread) return { status: 'unread' };
      const hit = accounts.find((a) => a.userId === userId);
      return hit ? { status: 'ok', account: hit } : { status: 'unread' };
    },
  };
}

export type HttpSupportDeskOptions = {
  readonly supportUrl: string;
  readonly identityUrl?: string;
  readonly internalSecret: string;
  /** svc-agents' own key. With it the identity account read is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
  readonly fetchImpl?: typeof fetch;
};

async function trpcQuery(
  fetchImpl: typeof fetch,
  baseUrl: string,
  procedure: string,
  input: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${baseUrl.replace(/\/$/, '')}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
    });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

/**
 * Live desk: `searchKb` / `getKb` (public tRPC) + ticket `get` (forwarded
 * principal) + identity `GET /internal/account/:userId` (S2S). Transport or
 * parse failure is unread/unreachable — never an invented article or active account.
 */
export function createHttpSupportDeskPort(options: HttpSupportDeskOptions): SupportDeskPort {
  const supportUrl = options.supportUrl.replace(/\/$/, '');
  const identityUrl = options.identityUrl?.replace(/\/$/, '') ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;
  const signIdentity = serviceCallSigner({
    service: 'svc-agents',
    audience: 'svc-identity',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });

  return {
    async searchKb(query, limit) {
      let page: number;
      try {
        page = assertKbSearchPageLimit(limit);
      } catch (err) {
        if (err instanceof AgentError && err.code === 'agents.kb_search_limit_unset') {
          return {
            status: 'refuse' as const,
            reason: 'kb_search_limit_unset' as const,
            userMessageKey: 'agents.refused.kb_search_limit_unset' as const,
          };
        }
        throw err;
      }
      const res = await trpcQuery(fetchImpl, supportUrl, 'searchKb', { q: query, limit: page });
      if (!res.ok) return { status: 'unreachable' };
      const articles = parseArticles(unwrapTrpc(res.body));
      if (articles === null) return { status: 'unreachable' };
      return { status: 'ok', articles };
    },
    async getKb(id) {
      const res = await trpcQuery(fetchImpl, supportUrl, 'getKb', { id });
      if (!res.ok) return { status: 'unreachable' };
      const data = unwrapTrpc(res.body);
      if (data === null) return { status: 'ok', articles: [] };
      const parsed = supportKbArticleSchema.safeParse(data);
      if (!parsed.success) return { status: 'unreachable' };
      return { status: 'ok', articles: [articleFromContract(parsed.data.id, parsed.data.titleKey, parsed.data.bodyKey)] };
    },
    async readTicket(ticketId, headers) {
      const res = await trpcQuery(fetchImpl, supportUrl, 'get', { ticketId }, headers ?? {});
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'unreachable' };
      const parsed = supportTicketSchema.safeParse(unwrapTrpc(res.body));
      if (!parsed.success) return { status: 'unreachable' };
      if (parsed.data.id.trim() !== ticketId) return { status: 'missing' };
      return { status: 'ok', ticket: ticketFromContract(parsed.data) };
    },
    async readAccount(userId) {
      if (!identityUrl) return { status: 'unread' };
      let response: Response;
      try {
        const target = `${identityUrl}/internal/account/${encodeURIComponent(userId)}`;
        response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...signIdentity('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch {
        return { status: 'unreachable' };
      }
      if (!response.ok) return { status: 'unread' };
      const body = await response.json().catch(() => null);
      const parsed = accountStateSchema.safeParse(body);
      if (!parsed.success) return { status: 'unread' };
      if (parsed.data.userId !== userId) return { status: 'unread' };
      if (accountProjectionHasInventMoney(parsed.data)) return { status: 'unread' };
      return {
        status: 'ok',
        account: { userId: parsed.data.userId, status: parsed.data.status, kycTier: parsed.data.kycTier },
      };
    },
  };
}
