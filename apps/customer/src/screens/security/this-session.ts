/**
 * The id of the session a sign-in token belongs to (its `sid` claim), or null when the token can't be read. It only decides
 * whether a row in the session list gets a "This device" tag; nothing is sent, trusted or stored because of it.
 */
export function thisSessionId(token: string | undefined | null): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=');
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
    const sid = typeof claims === 'object' && claims !== null ? (claims as { sid?: unknown }).sid : undefined;
    return typeof sid === 'string' && /^[0-9a-f-]{36}$/i.test(sid) ? sid.toLowerCase() : null;
  } catch {
    return null;
  }
}
