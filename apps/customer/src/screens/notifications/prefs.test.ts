import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  REFUSAL_COPY,
  addressAction,
  addressProblem,
  canToggleMute,
  categoryOf,
  channelState,
  deliveryWords,
  isSixDigits,
  refusalKey,
  registerNote,
  sortDeliveries,
  verifyNote,
  type ChannelFacts,
} from './prefs';

const facts = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({ ready: true, muted: false, target: { verified: true }, ...over });

describe('categoryOf', () => {
  it('maps the kinds the notify service writes to a topic', () => {
    expect(categoryOf('trade.fill')).toBe('trading');
    expect(categoryOf('trade.order.terminal')).toBe('trading');
    expect(categoryOf('trade.position.liquidated')).toBe('trading');
    expect(categoryOf('p2p.escrow.locked')).toBe('p2p');
    expect(categoryOf('identity.kyc.approved')).toBe('account');
    expect(categoryOf('identity.rank.updated')).toBe('account');
    expect(categoryOf('bank.margin_call')).toBe('money');
    expect(categoryOf('token.stake.created')).toBe('token');
    expect(categoryOf('agents.action.completed')).toBe('agents');
  });

  it('gives a kind it has not seen no topic, and every topic is reachable', () => {
    expect(categoryOf('something.new')).toBeNull();
    expect(categoryOf('')).toBeNull();
    for (const category of CATEGORIES)
      expect(['trade', 'p2p', 'identity', 'bank', 'token', 'agents'].some((p) => categoryOf(`${p}.x`) === category)).toBe(true);
  });
});

describe('channelState', () => {
  it('keeps the inbox always on', () => {
    expect(channelState('inapp', facts({ ready: false, target: null }))).toBe('always');
  });

  it('names the first thing in the way, in order: platform, address, confirmation, mute', () => {
    expect(channelState('email', facts({ ready: false }))).toBe('platformOff');
    expect(channelState('email', facts({ target: null }))).toBe('noTarget');
    expect(channelState('email', facts({ target: { verified: false } }))).toBe('unverified');
    expect(channelState('email', facts({ muted: true }))).toBe('muted');
    expect(channelState('email', facts())).toBe('on');
  });

  it('lets the mute switch move only for a channel the platform can send on, with a preference returned', () => {
    expect(canToggleMute(facts())).toBe(true);
    expect(canToggleMute(facts({ ready: false }))).toBe(false);
    expect(canToggleMute(facts({ muted: null }))).toBe(false);
  });
});

describe('addressAction', () => {
  it('adds when nothing is on file, verifies when unconfirmed, and does nothing when the platform cannot send', () => {
    expect(addressAction('email', facts({ target: null }))).toBe('add');
    expect(addressAction('sms', facts({ target: { verified: false } }))).toBe('verify');
    expect(addressAction('email', facts())).toBe('none');
    expect(addressAction('email', facts({ ready: false, target: null }))).toBe('none');
  });

  it('never offers to add a phone device from the web page', () => {
    expect(addressAction('push', facts({ target: null }))).toBe('none');
  });
});

describe('addresses', () => {
  it('accepts the shapes the service accepts', () => {
    expect(addressProblem('email', 'a@b.co')).toBeNull();
    expect(addressProblem('email', ' a@b.co ')).toBeNull();
    expect(addressProblem('sms', '+447700900000')).toBeNull();
  });

  it('refuses what it would refuse', () => {
    expect(addressProblem('email', 'nope')).toBe('invalidEmail');
    expect(addressProblem('email', 'a b@c.d')).toBe('invalidEmail');
    expect(addressProblem('sms', '07700900000')).toBe('invalidSms');
    expect(addressProblem('sms', '+0123456789')).toBe('invalidSms');
    expect(addressProblem('sms', '+123')).toBe('invalidSms');
  });

  it('wants exactly six digits for a code', () => {
    expect(isSixDigits('123456')).toBe(true);
    expect(isSixDigits('12345')).toBe(false);
    expect(isSixDigits('12345a')).toBe(false);
    expect(isSixDigits('1234567')).toBe(false);
  });
});

describe('refusals in plain words', () => {
  it('explains every code the service records and never shows a raw code for one it does not know', () => {
    for (const code of Object.keys(REFUSAL_COPY)) expect(refusalKey(code)).not.toBe('refusalUnknown');
    expect(refusalKey('channel.something_new')).toBe('refusalUnknown');
    expect(refusalKey(null)).toBe('refusalUnknown');
  });
});

describe('deliveries', () => {
  it('says "in your inbox" for the inbox and never says delivered for an outside channel', () => {
    expect(deliveryWords({ channel: 'inapp', status: 'accepted' })).toBe('deliveryInbox');
    expect(deliveryWords({ channel: 'email', status: 'accepted' })).toBe('deliveryHandedOff');
    expect(deliveryWords({ channel: 'sms', status: 'refused' })).toBe('deliveryRefused');
    expect(deliveryWords({ channel: 'push', status: 'failed' })).toBe('deliveryFailed');
    expect(deliveryWords({ channel: 'push', status: 'abandoned' })).toBe('deliveryAbandoned');
    expect(deliveryWords({ channel: 'email', status: 'pending' })).toBe('deliveryPending');
  });

  it('lists the inbox first, then email, phone and text', () => {
    const sorted = sortDeliveries([
      { channel: 'sms' as const },
      { channel: 'inapp' as const },
      { channel: 'push' as const },
      { channel: 'email' as const },
    ]);
    expect(sorted.map((row) => row.channel)).toEqual(['inapp', 'email', 'push', 'sms']);
  });
});

describe('outcomes', () => {
  it('reports what the service said when an address is registered', () => {
    expect(registerNote('sent')).toBe('codeSent');
    expect(registerNote('refused')).toBe('sendRefused');
    expect(registerNote('failed')).toBe('sendFailed');
  });

  it('treats a wrong, expired or used code as one answer, and a refusal as a limit', () => {
    expect(verifyNote({ verified: true, code: null })).toBe('verifiedNow');
    expect(verifyNote({ verified: false, code: null })).toBe('codeWrong');
    expect(verifyNote({ verified: false, code: 'channel.verify_rate_limited' })).toBe('verifyLimited');
  });
});
