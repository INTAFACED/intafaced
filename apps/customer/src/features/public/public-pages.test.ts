import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { PARTICIPATION_ROOMS, partnerEnquiryHref } from './public-pages';

describe('partnerEnquiryHref', () => {
  it('points at /partner on the configured invitation host', () => {
    expect(partnerEnquiryHref('https://join.example.org')).toBe('https://join.example.org/partner');
    expect(partnerEnquiryHref(' https://join.example.org/anything?x=1 ')).toBe('https://join.example.org/partner');
  });

  it('is null when nothing usable is configured', () => {
    expect(partnerEnquiryHref(undefined)).toBeNull();
    expect(partnerEnquiryHref('')).toBeNull();
    expect(partnerEnquiryHref('join.example.org')).toBeNull();
    expect(partnerEnquiryHref('http://join.example.org')).toBeNull();
    expect(partnerEnquiryHref('javascript:alert(1)')).toBeNull();
    expect(partnerEnquiryHref('https://user:pw@join.example.org')).toBeNull();
  });

  it('allows plain http only on this machine', () => {
    expect(partnerEnquiryHref('http://localhost:5199')).toBe('http://localhost:5199/partner');
  });
});

describe('participation rooms', () => {
  it('are all real rooms', () => {
    for (const entry of PARTICIPATION_ROOMS) expect(findRoom(entry.path)).toBeDefined();
  });
});
