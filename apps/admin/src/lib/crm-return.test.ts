import { describe, expect, it } from 'vitest';
import { enquiryIdFromSearch, enquiryPath, safeCrmPath, signInHref, signInReturnTarget } from './crm-return';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e9f0a1b';

describe('sign-in return path', () => {
  it('accepts the CRM home and an enquiry link, and keeps the query', () => {
    expect(safeCrmPath('/crm')).toBe('/crm');
    expect(safeCrmPath(`/crm?enquiry=${ID}`)).toBe(`/crm?enquiry=${ID}`);
    expect(safeCrmPath('/crm/anything?x=1')).toBe('/crm/anything?x=1');
  });
  it('drops a fragment', () => {
    expect(safeCrmPath('/crm?enquiry=a#frag')).toBe('/crm?enquiry=a');
  });
  it.each([
    ['another site', 'https://evil.example/crm'],
    ['a protocol-relative link', '//evil.example/crm'],
    ['a protocol-relative link with a backslash', '/\\evil.example/crm'],
    ['a backslash path', '\\\\evil.example'],
    ['a javascript link', 'javascript:alert(1)'],
    ['a data link', 'data:text/html,hi'],
    ['a relative path', 'crm'],
    ['an empty value', ''],
    ['another console page', '/accounts'],
    ['the login page', '/login'],
    ['a look-alike prefix', '/crmx'],
    ['a look-alike host trick', '/crm@evil.example'],
    ['a dot-segment escape', '/crm/../login'],
    ['an encoded dot-segment escape', '/crm/%2e%2e/login'],
    ['an encoded slash', '/crm%2f..%2flogin'],
    ['a tab hiding a second slash', '/\t/evil.example'],
    ['a newline hiding a second slash', '/\n/evil.example'],
    ['a carriage return', '/crm\r\nSet-Cookie: x=1'],
    ['a non-string', 42],
    ['null', null],
    ['a very long value', `/crm?${'a'.repeat(600)}`],
  ])('refuses %s', (_name, value) => {
    expect(safeCrmPath(value)).toBeNull();
  });
  it('builds the enquiry path only from a real id', () => {
    expect(enquiryPath(ID)).toBe(`/crm?enquiry=${ID}`);
    expect(enquiryPath('../../etc')).toBe('/crm');
    expect(enquiryPath(null)).toBe('/crm');
    expect(safeCrmPath(enquiryPath(ID))).toBe(`/crm?enquiry=${ID}`);
  });
  it('builds a sign-in link that carries the return path encoded', () => {
    expect(signInHref(ID)).toBe(`/login?next=${encodeURIComponent(`/crm?enquiry=${ID}`)}`);
    expect(signInHref()).toBe('/login?next=%2Fcrm');
    expect(signInHref('not-an-id')).toBe('/login?next=%2Fcrm');
  });
  it('reads the enquiry id from the page query', () => {
    expect(enquiryIdFromSearch(`?enquiry=${ID}`)).toBe(ID);
    expect(enquiryIdFromSearch('?enquiry=nope')).toBeNull();
    expect(enquiryIdFromSearch('')).toBeNull();
  });
  it('after sign-in: a safe "next" wins, then the kept enquiry, then the CRM home', () => {
    expect(signInReturnTarget(`?next=${encodeURIComponent(`/crm?enquiry=${ID}`)}`, null)).toBe(`/crm?enquiry=${ID}`);
    expect(signInReturnTarget('', ID)).toBe(`/crm?enquiry=${ID}`);
    expect(signInReturnTarget('', null)).toBe('/crm');
    expect(signInReturnTarget('?next=https%3A%2F%2Fevil.example', null)).toBe('/crm');
    expect(signInReturnTarget('?next=%2F%2Fevil.example', ID)).toBe(`/crm?enquiry=${ID}`);
    expect(signInReturnTarget('?next=%2Faccounts', null)).toBe('/crm');
    expect(signInReturnTarget('?next=%2Fcrm', ID)).toBe(`/crm?enquiry=${ID}`);
    expect(signInReturnTarget('?next=%2Fcrm', null)).toBe('/crm');
  });
});
