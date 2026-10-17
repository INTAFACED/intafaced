import type { Delivery, Endpoint } from './schemas';

export type WebhookUrlProblem = 'empty' | 'invalid' | 'https' | 'credentials' | 'private';

const v4 = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
};

/** Hosts INTAFACED will never post to. The service checks again (and resolves the name); this keeps the obvious mistakes off the wire. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  const ip = v4(host);
  if (ip) {
    const [a, b] = ip as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('::ffff:') ||
      host.startsWith('ff')
    );
  }
  return false;
}

export function webhookUrlProblem(raw: string): WebhookUrlProblem | null {
  const value = raw.trim();
  if (!value) return 'empty';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid';
  }
  if (url.username || url.password) return 'credentials';
  if (url.protocol !== 'https:') return url.protocol === 'http:' ? 'https' : 'invalid';
  if (isPrivateHost(url.hostname)) return 'private';
  return null;
}

/** The address with any query string and fragment removed: a secret in a query must never be printed in a list. */
export function shownEndpointUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

export type IpProblem = 'empty' | 'invalid';
/** One exact address, v4 or v6. The service takes exact addresses only; ranges are refused. */
export function ipProblem(raw: string): IpProblem | null {
  const ip = raw.trim();
  if (!ip) return 'empty';
  if (v4(ip)) return null;
  if (/^[0-9a-fA-F:.]+$/.test(ip) && ip.includes(':')) {
    try {
      new URL(`http://[${ip}]`);
      return null;
    } catch {
      return 'invalid';
    }
  }
  return 'invalid';
}

/** Split a pasted list (commas, spaces, new lines) into unique addresses. */
export function splitIps(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export const keyScopes = ['pay:read', 'pay:write', 'pay:refund'] as const;
export const isPayKey = (scopes: readonly string[]) => scopes.some((scope) => scope.startsWith('pay:'));

/** Who may change webhooks: owner, admin and developer (services/svc-pay roles.ts: webhooks.manage). Everyone with a role may read. */
export const canManageWebhooks = (role: string | null) => role === 'owner' || role === 'admin' || role === 'developer';

export function endpointNeedsAttention(endpoint: Endpoint): boolean {
  return endpoint.status === 'active' && endpoint.consecutiveFailures > 0;
}

/** Only a failed or dead delivery can be sent again. */
export const canRetry = (delivery: Delivery) => delivery.status === 'failed' || delivery.status === 'dead';

export type SnippetLanguage = 'typescript' | 'python';

/** The signing recipe as code. The canonical string and headers are those the edge verifies (packages/sdk-ts/src/sign.ts). */
export const signingSnippets: Record<SnippetLanguage, string> = {
  typescript: `import { createHash, createHmac, randomBytes } from 'node:crypto';

export function signRequest(secret: string, method: string, path: string, body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000)); // unix seconds
  const nonce = randomBytes(16).toString('base64url');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = ['INTAFACED-REQ-V1', method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\\n');
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return {
    'x-intafaced-request-timestamp': timestamp,
    'x-intafaced-request-nonce': nonce,
    'x-intafaced-request-signature': signature,
  };
}`,
  python: `import hashlib, hmac, secrets, time

def sign_request(secret: str, method: str, path: str, body: bytes = b""):
    timestamp = str(int(time.time()))  # unix seconds
    nonce = secrets.token_urlsafe(16)
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\\n".join(["INTAFACED-REQ-V1", method.upper(), path, timestamp, nonce, body_hash])
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-intafaced-request-timestamp": timestamp,
        "x-intafaced-request-nonce": nonce,
        "x-intafaced-request-signature": signature,
    }`,
};

/** How to check an event we send you: HMAC-SHA256 over the timestamp, a dot and the raw body. */
export const verifySnippets: Record<SnippetLanguage, string> = {
  typescript: `import { createHmac, timingSafeEqual } from 'node:crypto';

export function eventIsGenuine(secret: string, headers: Headers, rawBody: string) {
  const timestamp = headers.get('x-intafaced-timestamp') ?? '';
  const received = headers.get('x-intafaced-signature') ?? '';
  const toleranceSeconds = 300; // your choice: how old an event may be before you refuse it
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex');
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}`,
  python: `import hashlib, hmac, time

def event_is_genuine(secret: str, headers, raw_body: str) -> bool:
    timestamp = headers.get("x-intafaced-timestamp", "")
    received = headers.get("x-intafaced-signature", "")
    tolerance_seconds = 300  # your choice: how old an event may be before you refuse it
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(received, expected)`,
};
