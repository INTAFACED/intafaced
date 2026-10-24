import { founderMutationHeaders } from '@/lib/founder-browser';
import type { KybDocumentFile, KybDocumentRow } from '@intafaced/contracts/kyb-documents';
import type { KybInformationRequest, KybRequestFileBytes } from '@intafaced/contracts/kyb-information-requests';

/**
 * Browser hops to `/api/merchants/kyb-documents` and `/api/merchants/kyb-requests`. The CSRF nonce is fetched per call;
 * no token is ever stored.
 */
export type KybReply<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string };

export type KybRequest =
  | { action: 'review'; applicationId: string; documentId: string; verdict: 'accepted' | 'rejected'; reason?: string }
  | { action: 'file'; applicationId: string; documentId: string };

export type KybInfoRequest =
  | { action: 'create'; merchantId: string; text: string; dueAt: string }
  | { action: 'close'; requestId: string; note: string }
  | { action: 'file'; requestId: string };

const fail = (title: string, body: string, next: string) => ({ ok: false as const, title, body, next });

type Answer = { row?: KybDocumentRow; file?: KybDocumentFile | KybRequestFileBytes; request?: KybInformationRequest };

async function post(request: KybRequest): Promise<KybReply<{ row?: KybDocumentRow; file?: KybDocumentFile }>> {
  return postTo('/api/merchants/kyb-documents', request) as Promise<KybReply<{ row?: KybDocumentRow; file?: KybDocumentFile }>>;
}

async function postTo(path: string, request: KybRequest | KybInfoRequest): Promise<KybReply<Answer>> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return fail(
      'You are signed out',
      error instanceof Error ? error.message : 'Your founder session is unavailable.',
      'Sign in again. Nothing was changed.',
    );
  }
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      row?: KybDocumentRow;
      file?: KybDocumentFile | KybRequestFileBytes;
      request?: KybInformationRequest;
      refusal?: { title?: string; body?: string; next?: string };
      code?: string;
    } | null;
    if (body?.ok === true)
      return {
        ok: true,
        data: {
          ...(body.row ? { row: body.row } : {}),
          ...(body.file ? { file: body.file } : {}),
          ...(body.request ? { request: body.request } : {}),
        },
      };
    if (body?.refusal)
      return fail(
        body.refusal.title ?? 'The service refused this',
        body.refusal.body ?? 'Nothing was changed.',
        body.refusal.next ?? 'Try again.',
      );
    if (typeof body?.code === 'string')
      return fail(
        res.status === 401 ? 'You are signed out' : 'Not allowed',
        'The console did not accept your founder session for this action.',
        'Sign out and in again. Nothing was changed.',
      );
    return fail(
      'Could not reach the console',
      'The request did not get through, so nothing was changed.',
      'Check your connection and try again.',
    );
  } catch {
    return fail(
      'Could not reach the console',
      'The request did not get through, so nothing was changed.',
      'Check your connection and try again.',
    );
  }
}

export async function reviewKybDocument(
  input: Omit<Extract<KybRequest, { action: 'review' }>, 'action'>,
): Promise<KybReply<KybDocumentRow>> {
  const reply = await post({ action: 'review', ...input });
  if (!reply.ok) return reply;
  return reply.data.row
    ? { ok: true, data: reply.data.row }
    : fail('The service gave no answer', 'Nothing was changed.', 'Reload and try again.');
}

export async function openKybDocument(input: Omit<Extract<KybRequest, { action: 'file' }>, 'action'>): Promise<KybReply<KybDocumentFile>> {
  const reply = await post({ action: 'file', ...input });
  if (!reply.ok) return reply;
  return reply.data.file
    ? { ok: true, data: reply.data.file }
    : fail('The service gave no file', 'Nothing was opened.', 'Reload and try again.');
}

/** Ask the merchant for more, or close a request. */
export async function sendKybRequest(
  input: Extract<KybInfoRequest, { action: 'create' | 'close' }>,
): Promise<KybReply<KybInformationRequest>> {
  const reply = await postTo('/api/merchants/kyb-requests', input);
  if (!reply.ok) return reply;
  return reply.data.request
    ? { ok: true, data: reply.data.request }
    : fail('The service gave no answer', 'Nothing was changed.', 'Reload and try again.');
}

export async function openKybRequestFile(requestId: string): Promise<KybReply<KybRequestFileBytes>> {
  const reply = await postTo('/api/merchants/kyb-requests', { action: 'file', requestId });
  if (!reply.ok) return reply;
  return reply.data.file && 'requestId' in reply.data.file
    ? { ok: true, data: reply.data.file }
    : fail('The service gave no file', 'Nothing was opened.', 'Reload and try again.');
}
