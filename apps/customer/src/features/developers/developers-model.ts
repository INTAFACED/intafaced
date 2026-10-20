/** Who a developer section is for. The home page groups the section index under these. */
export type Audience = 'exchange' | 'institutional' | 'embedded' | 'broker' | 'practice';

export const AUDIENCES: readonly Audience[] = ['exchange', 'institutional', 'embedded', 'broker', 'practice'];

/** A section with a page published in this build links there; every other section says it has no published page. */
export type Section = { id: string; audience: Audience; published?: { href: string } };

/**
 * Every section of the developer portal (the section routes listed in `developer-portal.md`). A section whose page is not
 * written stays visible, with its audience and the plain statement that nothing is published for it: no room is hidden.
 * Merchant payments already have documentation at `/pay/developer/*`, so those sections link to it.
 */
export const SECTIONS: readonly Section[] = [
  { id: 'permissions', audience: 'exchange' },
  { id: 'authentication', audience: 'exchange' },
  { id: 'rest', audience: 'exchange' },
  { id: 'reference', audience: 'exchange' },
  { id: 'websocket', audience: 'exchange' },
  { id: 'rate-limits', audience: 'exchange' },
  { id: 'errors', audience: 'exchange' },
  { id: 'idempotency', audience: 'exchange' },
  { id: 'versioning', audience: 'exchange' },
  { id: 'changelog', audience: 'exchange' },
  { id: 'fix', audience: 'institutional' },
  { id: 'protocols', audience: 'institutional' },
  { id: 'webhooks', audience: 'embedded', published: { href: '/pay/developer/webhooks' } },
  { id: 'sandbox', audience: 'embedded', published: { href: '/pay/developer/sandbox' } },
  { id: 'apps', audience: 'broker' },
  { id: 'quickstart', audience: 'practice' },
  { id: 'sdks', audience: 'practice' },
  { id: 'cli', audience: 'practice' },
  { id: 'mcp', audience: 'practice' },
  { id: 'explorer', audience: 'practice' },
  { id: 'openapi', audience: 'practice' },
  { id: 'support', audience: 'practice' },
  { id: 'status', audience: 'practice' },
];

export const sectionById = (id: string): Section | undefined => SECTIONS.find((section) => section.id === id);

export type Protocol = 'rest' | 'websocket' | 'fix';
export type Environment = 'production' | 'sandbox' | 'regional';

export const PROTOCOLS: readonly Protocol[] = ['rest', 'websocket', 'fix'];
export const ENVIRONMENTS: readonly Environment[] = ['production', 'sandbox', 'regional'];

/**
 * What the portal knows of a host. No read for the owner's host settings is connected, so every row is `unset`: the table
 * shows `host not set` and no address is written down or guessed. A published host would arrive as `{ state: 'set', host }`.
 */
export type HostCell = { state: 'unset' } | { state: 'set'; host: string };

export function hostTable(read: (protocol: Protocol, environment: Environment) => string | null = () => null) {
  return PROTOCOLS.flatMap((protocol) =>
    ENVIRONMENTS.map((environment) => {
      const host = read(protocol, environment)?.trim() ?? '';
      const cell: HostCell = host ? { state: 'set', host } : { state: 'unset' };
      return { protocol, environment, cell };
    }),
  );
}

/** What the address names: the home page, the hosts table, a section, or an address that is none of these. */
export function developersRoute(
  path: string,
): { kind: 'home' } | { kind: 'hosts' } | { kind: 'section'; id: string } | { kind: 'unknown' } {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '');
  if (clean === '/developers') return { kind: 'home' };
  const match = /^\/developers\/([^/]+)$/.exec(clean);
  if (!match) return { kind: 'unknown' };
  const id = match[1]!;
  if (id === 'hosts') return { kind: 'hosts' };
  return sectionById(id) ? { kind: 'section', id } : { kind: 'unknown' };
}
