import { describe, expect, it } from 'vitest';
import { P2pError } from './p2p-service.js';
import { toTrpcError } from './router.js';
import { brokenRuleClass, parseAdContentRules } from './ad-content-rules.js';

/** P-ads-merchant-05: compliance's content rules for ad terms, refused by rule class. */
describe('ad content rules', () => {
  const rules = parseAdContentRules(
    JSON.stringify({ messenger: ['telegram', 'WhatsApp', 'signal'], link: ['https://', 'www.'], contact: ['call me on'] }),
  );

  it('names the rule class a phrase breaks, whatever its case or width', () => {
    expect(brokenRuleClass(rules, 'TEST terms: message me on telegram before you pay')).toBe('messenger');
    expect(brokenRuleClass(rules, 'Ｗｈａｔｓａｐｐ only')).toBe('messenger');
    expect(brokenRuleClass(rules, 'see https://example.test for details')).toBe('link');
    expect(brokenRuleClass(rules, 'Call me on arrival')).toBe('contact');
  });

  it('reads through doubled spaces, line breaks and invisible characters, and a digit glued to a word', () => {
    expect(brokenRuleClass(rules, 'Call  me on arrival')).toBe('contact');
    expect(brokenRuleClass(rules, 'call\nme on arrival')).toBe('contact');
    expect(brokenRuleClass(rules, 'tele\u200Bgram')).toBe('messenger');
    expect(brokenRuleClass(rules, 'telegram1 please')).toBe('messenger');
  });

  it('matches a word phrase only as a whole word, and a sign phrase anywhere', () => {
    expect(brokenRuleClass(rules, 'no signalling, pay from your own account')).toBeNull();
    expect(brokenRuleClass(rules, 'pay from your own account.')).toBeNull();
    expect(brokenRuleClass(rules, 'telegram.')).toBe('messenger');
    expect(brokenRuleClass(rules, 'go to www.example')).toBe('link');
    expect(brokenRuleClass(rules, 'xwww.example')).toBeNull();
  });

  it('is off when nothing is published, and refuses to read a list that is not whole', () => {
    expect(parseAdContentRules(undefined)).toEqual({ status: 'absent' });
    expect(parseAdContentRules('  ')).toEqual({ status: 'absent' });
    expect(brokenRuleClass(parseAdContentRules(undefined), 'telegram')).toBeNull();
    for (const raw of ['[]', '{}', 'nope', '{"messenger":[]}', '{"Messenger":["x1"]}', '{"messenger":["t"]}', '{"messenger":[1]}', '"x"'])
      expect(parseAdContentRules(raw)).toEqual({ status: 'invalid' });
  });

  it('treats the phrase as text, never as a pattern', () => {
    const literal = parseAdContentRules(JSON.stringify({ link: ['a.b(c)*'] }));
    expect(brokenRuleClass(literal, 'aXb(c)')).toBeNull();
    expect(brokenRuleClass(literal, 'see a.b(c)* here')).toBe('link');
  });

  it('reaches the caller as a request the person can fix, and a broken list as the operator’s', () => {
    const violation = new P2pError('x', 'p2p.content_rule_violation', { until: null, ruleClass: 'messenger' });
    expect(toTrpcError(violation).code).toBe('BAD_REQUEST');
    expect(toTrpcError(new P2pError('x', 'p2p.content_rules_invalid')).code).toBe('PRECONDITION_FAILED');
  });
});
