import { describe, expect, it } from 'vitest';
import { contactChanges, contactGate, draftsFrom, readContactChannels, readContactSetRequest, type ContactChannels } from './contact';

const channels = (over: Partial<ContactChannels> = {}): ContactChannels => ({
  email: null,
  phone: null,
  chatHours: null,
  revision: 0,
  updatedAt: null,
  ...over,
});

describe('readContactChannels', () => {
  it('reads a record with every channel a value or null', () => {
    expect(
      readContactChannels({ email: 'a@b.test', phone: null, chatHours: null, revision: 2, updatedAt: '2026-10-20T01:00:00.000Z' }),
    ).toEqual({
      email: 'a@b.test',
      phone: null,
      chatHours: null,
      revision: 2,
      updatedAt: '2026-10-20T01:00:00.000Z',
    });
  });
  it('refuses an extra key, a missing key, an empty string, a bad revision and a bad time', () => {
    const ok = { email: null, phone: null, chatHours: null, revision: 0, updatedAt: null };
    expect(readContactChannels(ok)).not.toBeNull();
    expect(readContactChannels({ ...ok, extra: 1 })).toBeNull();
    expect(readContactChannels({ email: null, phone: null, revision: 0, updatedAt: null })).toBeNull();
    expect(readContactChannels({ ...ok, email: '' })).toBeNull();
    expect(readContactChannels({ ...ok, revision: -1 })).toBeNull();
    expect(readContactChannels({ ...ok, revision: 1.5 })).toBeNull();
    expect(readContactChannels({ ...ok, updatedAt: 'soon' })).toBeNull();
    expect(readContactChannels(null)).toBeNull();
    expect(readContactChannels([])).toBeNull();
  });
});

describe('contactChanges', () => {
  it('sends nothing when nothing differs, and ignores surrounding spaces', () => {
    const c = channels({ email: 'a@b.test' });
    expect(contactChanges(c, { ...draftsFrom(c) })).toBeNull();
    expect(contactChanges(c, { email: '  a@b.test ', phone: '', chatHours: '' })).toBeNull();
  });
  it('sets what differs, clears what was emptied and leaves the rest out', () => {
    const c = channels({ email: 'a@b.test', phone: '+49 30 1234' });
    expect(contactChanges(c, { email: 'new@b.test', phone: '', chatHours: 'Mon to Fri' })).toEqual({
      email: 'new@b.test',
      phone: null,
      chatHours: 'Mon to Fri',
    });
  });
  it('an empty field that was never set is not a change', () => {
    expect(contactChanges(channels(), { email: ' ', phone: '', chatHours: '' })).toBeNull();
  });
});

describe('contactGate', () => {
  const c = channels({ email: 'a@b.test' });
  const drafts = { email: 'new@b.test', phone: '', chatHours: '' };
  it('needs a change and a reason', () => {
    expect(contactGate(c, draftsFrom(c), 'why', false)).toEqual({ ok: false, why: 'Nothing has changed.' });
    expect(contactGate(c, drafts, '  ', false)).toEqual({ ok: false, why: 'Say why you are changing it.' });
    expect(contactGate(c, drafts, 'x'.repeat(501), false).ok).toBe(false);
    expect(contactGate(c, drafts, 'new inbox', false)).toEqual({ ok: true });
  });
  it('is closed while a send is in progress', () => {
    expect(contactGate(c, drafts, 'new inbox', true).ok).toBe(false);
  });
});

describe('readContactSetRequest', () => {
  it('reads a request and trims the reason', () => {
    expect(readContactSetRequest({ changes: { email: 'a@b.test', phone: null }, expectedRevision: 3, reason: ' moved ' })).toEqual({
      changes: { email: 'a@b.test', phone: null },
      expectedRevision: 3,
      reason: 'moved',
    });
  });
  it('refuses no changes, an unknown field, a non-string value, a bad revision and a missing reason', () => {
    const base = { changes: { email: 'a@b.test' }, expectedRevision: 0, reason: 'r' };
    expect(readContactSetRequest(base)).not.toBeNull();
    expect(readContactSetRequest({ ...base, changes: {} })).toBeNull();
    expect(readContactSetRequest({ ...base, changes: { fax: 'x' } })).toBeNull();
    expect(readContactSetRequest({ ...base, changes: { email: 4 } })).toBeNull();
    expect(readContactSetRequest({ ...base, expectedRevision: -1 })).toBeNull();
    expect(readContactSetRequest({ ...base, expectedRevision: '0' })).toBeNull();
    expect(readContactSetRequest({ ...base, reason: ' ' })).toBeNull();
    expect(readContactSetRequest({ ...base, changes: [] })).toBeNull();
  });
});
