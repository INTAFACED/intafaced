// The customer-words check render.compare.tsx runs on every drawn room: it finds each kind it is meant to stop, passes
// plain words, and reads only what a person sees.
import { describe, expect, it } from 'vitest';
import { rawCustomerText, visibleText } from './customer-words';

describe('no customer room shows a raw id, an internal code or a placeholder address', () => {
  const at = (html: string) => rawCustomerText('/uc/promotion', html);
  it('finds a raw id, a dotted internal code, a placeholder host and a loopback or documentation address', () => {
    expect(at('<p>Personal account · <span>8a96885b-cd8f-4a1e-9b1c-0123456789ab</span></p>')).toEqual([
      '8a96885b-cd8f-4a1e-9b1c-0123456789ab',
    ]);
    expect(at('<p>Paid plans need a plan fee (bank.plan_fee_unwired).</p>')).toEqual(['bank.plan_fee_unwired']);
    expect(at('<li>official-test.invalid</li><li>http://127.0.0.1:3210/help</li>')).toEqual(['official-test.invalid', '127.0.0.1']);
    expect(at('<code>198.51.100.1:3999</code>')).toEqual(['198.51.100.1']);
  });
  it('passes plain words, attributes, a closed disclosure and the page’s own origin', () => {
    expect(
      at('<p title="8a96885b-cd8f-4a1e-9b1c-0123456789ab" data-code="bank.plan_fee_unwired">Reference 8A96885B · 1.5 BTC</p>'),
    ).toEqual([]);
    expect(at('<details><summary>Details</summary>id 8a96885b-cd8f-4a1e-9b1c-0123456789ab</details>')).toEqual([]);
    expect(at('<p>http://localhost:3000/pay/send?to=friend · beta.intafaced.com</p>')).toEqual([]);
    expect(visibleText('<b>a</b><svg><text>8a96885b-cd8f-4a1e-9b1c-0123456789ab</text></svg>')).toBe(' a ');
  });
  it('leaves what step words name, and the developer rooms', () => {
    expect(rawCustomerText('/trade/risk', '<code>risk.approvals_source_unset</code>')).toEqual([]);
    expect(rawCustomerText('/uc/account', '<p>00000000-0000-4000-8000-000000000001</p>')).toEqual([]);
    expect(rawCustomerText('/uc/promotion', '<p>00000000-0000-4000-8000-000000000001</p>')).toHaveLength(1);
    expect(rawCustomerText('/developers/errors/auth', '<code>auth.api_key_denied</code>')).toEqual([]);
  });
});
