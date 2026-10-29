/**
 * What a person typed into the explorer search, by its shape alone. Nothing here looks anything up: an address is a
 * 20-byte hex string, a transaction is a 32-byte hex hash, a block is a height. Anything else is text, which only the
 * token list could answer.
 */
export type ExplorerQuery =
  | { kind: 'empty' }
  | { kind: 'address'; value: string }
  | { kind: 'tx'; value: string }
  | { kind: 'block'; value: string }
  | { kind: 'text'; value: string };

export function classifyQuery(raw: string): ExplorerQuery {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return { kind: 'address', value };
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { kind: 'tx', value: value.toLowerCase() };
  if (/^\d{1,20}$/.test(value)) return { kind: 'block', value: value.replace(/^0+(?=\d)/, '') };
  return { kind: 'text', value };
}

/** Where a query of a known shape opens. A transaction hash is searched across networks first, so it has no single page. */
export function pathFor(query: ExplorerQuery): string | null {
  if (query.kind === 'address') return `/chain/address/${query.value}`;
  if (query.kind === 'block') return `/chain/blocks/${query.value}`;
  return null;
}
