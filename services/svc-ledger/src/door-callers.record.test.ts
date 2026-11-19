import { expect, it } from 'vitest';
import { LEDGER_HISTORY_PAGE } from '@intafaced/contracts/ledger-history-page';
import { READERS } from './door-callers.js';

it('the historyPage record names exactly the ledger readers the grant table derives', () => {
  expect([...LEDGER_HISTORY_PAGE.access.callers].sort()).toEqual([...READERS].sort());
});
