'use client';
/** Writes retain their request identity until a confirmed, validated receipt. */
export type PendingCrmWrite = { inputKey: string; requestId: string };
export async function crmJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Your founder session is unavailable. Sign in again.');
    if (response.status === 409 || response.status === 412)
      throw new Error('The record changed or this action was refused. Refresh and review before retrying.');
    throw new Error('We could not confirm the request. Keep your entries and retry the same action.');
  }
  return (await response.json()) as T;
}
export function workflowUrl(view: string, input: Record<string, unknown> = {}): string {
  const query = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return `/api/crm/workflows?${query}`;
}
export async function crmWrite<T>(
  csrf: string,
  pending: Map<string, PendingCrmWrite>,
  action: string,
  input: Record<string, unknown>,
): Promise<T> {
  const inputKey = JSON.stringify(input),
    previous = pending.get(action);
  const requestId = previous?.inputKey === inputKey ? previous.requestId : crypto.randomUUID();
  pending.set(action, { inputKey, requestId });
  const result = await crmJson<T>('/api/crm/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
    body: JSON.stringify({ action, input: { ...input, requestId } }),
  });
  pending.delete(action);
  return result;
}
export const crmLabel = (value: string) => value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
export const crmDate = (value: string) => new Date(value).toLocaleString();
export const crmLocalDate = (value: string) =>
  new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
