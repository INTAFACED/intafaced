/** Who a developer section is for. The home page groups the section index under these. */
export type Audience = 'exchange' | 'institutional' | 'embedded' | 'broker' | 'practice';

export const AUDIENCES: readonly Audience[] = ['exchange', 'institutional', 'embedded', 'broker', 'practice'];

/**
 * A section either has its page in this build (`page`), links to a page published elsewhere (`published`), or waits for the
 * slice that builds it (`waitsFor`, a slice id from docs/roadmap/slices.json). Every section names one of the three.
 */
export const PAGE_SECTION_IDS = [
  'permissions',
  'rest',
  'reference',
  'changelog',
  'data-terms',
  'connectivity',
  'quickstart',
  'openapi',
  'status',
] as const;
/** A section whose page is written in this portal. DevelopersRoutes keeps one component per id (a typed record). */
export type PageSectionId = (typeof PAGE_SECTION_IDS)[number];

export type Section =
  | { id: PageSectionId; audience: Audience; page: true; published?: never; waitsFor?: never }
  | { id: string; audience: Audience; page?: never; published: { href: string }; waitsFor?: never }
  | { id: string; audience: Audience; page?: never; published?: never; waitsFor: string };

/**
 * Every section of the developer portal (the section routes listed in `developer-portal.md`). A section whose page is not
 * written stays visible, with its audience and the slice it waits for: no room is hidden. Merchant payments already
 * have documentation at `/pay/developer/*`, so those sections link to it.
 */
export const SECTIONS: readonly Section[] = [
  { id: 'permissions', audience: 'exchange', page: true },
  { id: 'authentication', audience: 'exchange', waitsFor: 'DV-auth-01' },
  { id: 'rest', audience: 'exchange', page: true },
  { id: 'reference', audience: 'exchange', page: true },
  { id: 'websocket', audience: 'exchange', waitsFor: 'DV-websocket-01' },
  { id: 'rate-limits', audience: 'exchange', waitsFor: 'DV-limits-01' },
  { id: 'errors', audience: 'exchange', waitsFor: 'DV-errors-01' },
  { id: 'idempotency', audience: 'exchange', waitsFor: 'DV-auth-03' },
  { id: 'versioning', audience: 'exchange', waitsFor: 'DV-versioning-01' },
  { id: 'changelog', audience: 'exchange', page: true },
  { id: 'data-terms', audience: 'exchange', page: true },
  { id: 'connectivity', audience: 'institutional', page: true },
  { id: 'fix', audience: 'institutional', waitsFor: 'DV-fix-01' },
  { id: 'protocols', audience: 'institutional', waitsFor: 'DV-websocket-01' },
  { id: 'webhooks', audience: 'embedded', published: { href: '/pay/developer/webhooks' } },
  { id: 'sandbox', audience: 'embedded', published: { href: '/pay/developer/sandbox' } },
  { id: 'apps', audience: 'broker', published: { href: '/developers/apps' } },
  { id: 'quickstart', audience: 'practice', page: true },
  { id: 'sdks', audience: 'practice', waitsFor: 'DV-tools-01' },
  { id: 'cli', audience: 'practice', waitsFor: 'DV-tools-02' },
  { id: 'mcp', audience: 'practice', waitsFor: 'DV-tools-02' },
  { id: 'explorer', audience: 'practice', waitsFor: 'DV-console-01' },
  { id: 'openapi', audience: 'practice', page: true },
  { id: 'support', audience: 'practice', waitsFor: 'DV-portal-03' },
  { id: 'status', audience: 'practice', page: true },
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

export type HostRow = ReturnType<typeof hostTable>[number];

/** One row per host, in the order the base-address table shows them. The page and its markdown both draw this. */
export const hostRows = (rows: readonly HostRow[] = hostTable()) =>
  PROTOCOLS.flatMap((protocol) =>
    ENVIRONMENTS.map((environment) => rows.find((row) => row.protocol === protocol && row.environment === environment)!),
  );

export type ConnectivityOption = 'internet' | 'redundant' | 'low_latency' | 'colocation';
export type ConnectivityState = 'available' | 'host_unset' | 'parked_hardware';

/**
 * The connectivity options (RC-developer-04). Internet is available once a production host is set, the redundant endpoint
 * once a regional one is; until then each reads `host not set`. A low-latency path and colocation need a physical
 * cross-connect and rack space we do not own, so they stay parked on the `hardware` blocker.
 */
export function connectivityOptions(rows: readonly HostRow[] = hostTable()): { option: ConnectivityOption; state: ConnectivityState }[] {
  const set = (environment: Environment) => rows.some((row) => row.environment === environment && row.cell.state === 'set');
  return [
    { option: 'internet', state: set('production') ? 'available' : 'host_unset' },
    { option: 'redundant', state: set('regional') ? 'available' : 'host_unset' },
    { option: 'low_latency', state: 'parked_hardware' },
    { option: 'colocation', state: 'parked_hardware' },
  ];
}

/** The market data products the terms table lists (RC-developer-05). No term is read yet, so each reads `not set`. */
export const DATA_PRODUCTS = ['ticker', 'depth_l1', 'depth_l2', 'candles', 'trades', 'index'] as const;
export const DATA_TERMS = ['entitlement', 'redistribution', 'retention', 'privacy', 'commercial'] as const;

/** What the address names: the home page, the hosts table, a section, or an address that is none of these. */
export function developersRoute(
  path: string,
):
  | { kind: 'home' }
  | { kind: 'hosts' }
  | { kind: 'status' }
  | { kind: 'changelog' }
  | { kind: 'upcoming' }
  | { kind: 'apps' }
  | { kind: 'section'; id: string }
  | { kind: 'errors-auth' }
  | { kind: 'unknown' } {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '');
  if (clean === '/developers') return { kind: 'home' };
  if (clean === '/developers/changelog/upcoming') return { kind: 'upcoming' };
  if (clean === '/developers/errors/auth') return { kind: 'errors-auth' };
  const match = /^\/developers\/([^/]+)$/.exec(clean);
  if (!match) return { kind: 'unknown' };
  const id = match[1]!;
  if (id === 'hosts') return { kind: 'hosts' };
  if (id === 'status') return { kind: 'status' };
  if (id === 'changelog') return { kind: 'changelog' };
  if (id === 'apps') return { kind: 'apps' };
  return sectionById(id) ? { kind: 'section', id } : { kind: 'unknown' };
}
