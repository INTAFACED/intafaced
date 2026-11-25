import { describe, expect, it } from 'vitest';
import { grouped, limitText, type LimitWords } from './limit-words';

const words: LimitWords = {
  seconds: (n) => `${n} s`,
  oneSecond: '1 second',
  bytes: (n) => `${n} B`,
  kb: (n) => `${n} KB`,
  mb: (n) => `${n} MB`,
  characters: (n) => `${n} chars`,
};

describe('limitText', () => {
  it('reads time in seconds, exact', () => {
    expect(limitText('5000', 'milliseconds', words)).toBe('5 s');
    expect(limitText('2500', 'milliseconds', words)).toBe('2.5 s');
    expect(limitText('250', 'milliseconds', words)).toBe('0.25 s');
    expect(limitText('1000', 'milliseconds', words)).toBe('1 second');
  });
  it('reads sizes in KB or MB, exact, and small sizes in bytes', () => {
    expect(limitText('1000000', 'bytes', words)).toBe('1 MB');
    expect(limitText('10000000', 'bytes', words)).toBe('10 MB');
    expect(limitText('1500000', 'bytes', words)).toBe('1.5 MB');
    expect(limitText('200000', 'bytes', words)).toBe('200 KB');
    expect(limitText('512', 'bytes', words)).toBe('512 B');
    expect(limitText('0', 'bytes', words)).toBe('0 B');
  });
  it('groups counts and characters by thousands', () => {
    expect(limitText('50000', 'count', words)).toBe('50,000');
    expect(limitText('8000', 'characters', words)).toBe('8,000 chars');
    expect(grouped('1234567')).toBe('1,234,567');
  });
  it('shows a value that is not a whole number as it is', () => {
    expect(limitText('1e6', 'bytes', words)).toBe('1e6');
  });
});
