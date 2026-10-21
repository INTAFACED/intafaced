import { describe, expect, it } from 'vitest';
import { mergeSupportContact } from './support-contact';

const set = (over: Partial<{ email: string | null; phone: string | null; chatHours: string | null }> = {}) => ({
  ok: true as const,
  email: null,
  phone: null,
  chatHours: null,
  ...over,
});

describe('mergeSupportContact', () => {
  it('the owner-set address wins over the build address', () => {
    expect(mergeSupportContact(set({ email: 'owner@example.test' }), 'build@example.test').email).toBe('owner@example.test');
  });
  it('the build address is used only when the service holds none, and nothing is invented when neither is set', () => {
    expect(mergeSupportContact(set(), 'build@example.test')).toEqual({
      status: 'ready',
      email: 'build@example.test',
      phone: null,
      chatHours: null,
    });
    expect(mergeSupportContact(set(), null)).toEqual({ status: 'ready', email: null, phone: null, chatHours: null });
  });
  it('a stored value that is not an address is "not set", never a mailto', () => {
    expect(mergeSupportContact(set({ email: 'a b@c' }), null).email).toBeNull();
  });
  it('an address that could carry a mailto parameter is refused even though it looks like an address', () => {
    for (const bad of ['a@b.co?bcc=x@y.co', 'a@b.co#frag', 'a@b.co&x=1'])
      expect(mergeSupportContact(set({ email: bad }), null).email).toBeNull();
  });
  it('carries the phone and the chat hours as stored', () => {
    const merged = mergeSupportContact(set({ phone: '+1 555 010 0199', chatHours: 'Weekdays' }), null);
    expect(merged).toMatchObject({ phone: '+1 555 010 0199', chatHours: 'Weekdays' });
  });
  it('an unreadable service leaves only the build address and says so', () => {
    expect(mergeSupportContact({ ok: false }, 'build@example.test')).toEqual({
      status: 'unread',
      email: 'build@example.test',
      phone: null,
      chatHours: null,
    });
    expect(mergeSupportContact({ ok: false }, null).email).toBeNull();
  });
});
