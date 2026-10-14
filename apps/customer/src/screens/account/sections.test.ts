import { describe, expect, it } from 'vitest';
import { sectionFor, sections } from './sections';

describe('account sections', () => {
  it('maps each route to its section', () => {
    expect(sectionFor('/uc/account')).toBe('account');
    expect(sectionFor('/uc/safe')).toBe('security');
    expect(sectionFor('/verification')).toBe('verification');
    expect(sectionFor('/view')).toBe('display');
    expect(sectionFor('/verification?x=1')).toBe('verification');
  });
  it('links only to the four routes, once each', () => {
    expect(sections.map((section) => section.href)).toEqual(['/uc/account', '/uc/safe', '/verification', '/view']);
    expect(sections.map((section) => sectionFor(section.href))).toEqual(sections.map((section) => section.id));
  });
});
