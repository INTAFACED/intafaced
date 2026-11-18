import { describe, expect, it } from 'vitest';
import { asksForSourceRecords } from './SourceEntries';

describe('asksForSourceRecords', () => {
  it('is true only for a link that names a source or every source', () => {
    for (const source of ['wallet', 'venue', 'partner', 'all']) expect(asksForSourceRecords(`?source=${source}`)).toBe(true);
    // The asset list's history link and the ledger's own links name none: they ask for the ledger's entries.
    expect(asksForSourceRecords('')).toBe(false);
    expect(asksForSourceRecords('?account=main')).toBe(false);
    expect(asksForSourceRecords('?source=ledger')).toBe(false);
  });
});
