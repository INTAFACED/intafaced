import { describe, expect, it } from 'vitest';
import { storedText } from './testing.js';

describe('storedText', () => {
  it('masks the random values that held a secret by chance', () => {
    // A uuid that held a phone's digits and a hash that held a PIN's.
    const rows = [
      {
        id: '7d922733-8a82-4ab2-9586-979463af4219',
        payload_hash: 'e691a724987c4321'.padEnd(64, 'a'),
        at: new Date('2026-11-12T07:46:21Z'),
      },
    ];
    const text = storedText(rows, JSON.stringify({ nested: JSON.stringify(rows) }));
    expect(text).not.toContain('7946');
    expect(text).not.toContain('4321');
  });

  it('still finds a secret stored in the clear, alone or inside other text', () => {
    expect(storedText([{ pin: '4321' }])).toContain('4321');
    expect(storedText([{ note: 'pin 8642 set' }])).toContain('8642');
    expect(storedText([{ v: 'abc4321' }])).toContain('4321');
    expect(storedText({ phone: '+44 20 7946 0000' }, '442079460000')).toContain('7946');
  });
});
