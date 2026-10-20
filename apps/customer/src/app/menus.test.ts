import { describe, expect, it } from 'vitest';
import { tabSpecs } from './menus';

describe('dropdown icons', () => {
  it('gives margin, futures, options, loans and cards an icon no other row of their dropdown uses', () => {
    for (const mode of ['simple', 'pro'] as const) {
      for (const tab of tabSpecs(mode, true)) {
        for (const id of ['margin', 'futures', 'options', 'loans', 'cards']) {
          const row = tab.items.find((item) => item.id === id);
          if (!row) continue;
          const sharing = tab.items.filter((item) => item.id !== id && item.icon === row.icon).map((item) => item.id);
          expect(sharing, `${tab.door}/${id} icon "${row.icon}"`).toEqual([]);
        }
      }
    }
  });
});
