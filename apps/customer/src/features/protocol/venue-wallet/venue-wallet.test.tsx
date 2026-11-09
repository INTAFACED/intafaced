import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WithdrawalView, readFailedState, venueRefusal } from './VenueWalletRoom';
import { canonicalAmount, plainDecimal, toTokenUnits, venueWithdrawalKey, withDomainTypes } from './venue-account-api';
import { venueWalletCopy } from './venue-wallet-copy';

/** J-wallet-09: every refusal the venue room can meet reads in the room's own words, with its code as the reference. */
const { t } = venueWalletCopy.forLocale('en');
const failed = (code: string | undefined, message = '', reason: 'error' | 'unreachable' = 'error') =>
  ({ ok: false, reason, code, message }) as Parameters<typeof venueRefusal>[0];

describe('venue room refusals', () => {
  it('a listed wallet and a blank list are refused by name, with the code shown', () => {
    expect(venueRefusal(failed('protocol.wallet_sanctioned'), t)).toEqual({
      variant: 'refused',
      title: 'This wallet can’t be connected',
      body: 'This wallet is on the sanctions list, so it cannot be connected or used. Nothing was connected.',
      reference: 'protocol.wallet_sanctioned',
    });
    expect(venueRefusal(failed('protocol.wallet_sanctions_unset'), t).title).toBe('No wallet can be screened');
  });

  it('a blocked region names its reason, the owner’s words on the per-country switch', () => {
    const r = venueRefusal(failed('denied.region_blocked', 'Not served in US (sanctions screening, §24 Lane A)'), t);
    expect(r.title).toBe('Not available in your region');
    expect(r.body).toContain('Not served in US');
    expect(r.reference).toBe('denied.region_blocked');
  });

  it('a connections read refused for the region says the region refusal in words and keeps Connect; any other failure is a failed read', () => {
    const region = readFailedState(failed('denied.region_blocked', 'TEST region, not served at launch'), null, t);
    expect(region).toMatchObject({
      kind: 'ready',
      partial: { missing: { title: 'Not available in your region', reference: 'denied.region_blocked' } },
    });
    expect(JSON.stringify(region)).toContain('Connecting a wallet is not available where you are: TEST region, not served at launch.');
    expect(readFailedState(failed('protocol.something_new'), null, t)).toMatchObject({
      kind: 'refused',
      refusal: { title: 'Your wallet connections could not be read' },
    });
  });

  it('an expired connection asks the wallet to sign again; a code that leads the message is read too', () => {
    expect(venueRefusal(failed(undefined, 'protocol.venue_connection_expired: ended'), t)).toMatchObject({
      title: 'Your wallet must sign again',
      reference: 'protocol.venue_connection_expired',
    });
    expect(venueRefusal(failed('trade.user_venue_off'), t).title).toBe('There is no venue in this build');
  });

  it('anything else says nothing went through, and an unreachable service says so', () => {
    expect(venueRefusal(failed('protocol.something_new'), t).title).toBe('That did not go through');
    expect(venueRefusal(failed(undefined, '', 'unreachable'), t).variant).toBe('unreachable');
  });
});

describe('the venue account (J-wallet-09 #3, #5)', () => {
  it('a refused withdrawal, a signature that does not match, and a missing step-up each say nothing was sent', () => {
    expect(venueRefusal(failed('trade.venue.insufficient_balance'), t)).toMatchObject({
      title: 'Not enough on the venue',
      body: expect.stringContaining('Nothing was sent.'),
      reference: 'trade.venue.insufficient_balance',
    });
    expect(venueRefusal(failed('trade.venue.signature_mismatch'), t).title).toBe('The signature does not match this wallet');
    expect(venueRefusal(failed('identity.step_up_required'), t).title).toBe('Confirm it’s you first');
    expect(venueRefusal(failed('trade.venue.venue_down'), t).title).toBe('The venue is not answering');
    expect(venueRefusal(failed('trade.venue.something_new'), t)).toMatchObject({
      title: 'The venue refused this',
      reference: 'trade.venue.something_new',
    });
  });

  it('amounts stay decimal strings: token units exactly, the canonical form svc-trade hashes, no trailing zeros shown', () => {
    expect(toTokenUnits('25', 6)).toBe(25_000_000n);
    expect(toTokenUnits('0.000001', 6)).toBe(1n);
    expect(toTokenUnits('0.0000001', 6)).toBeNull();
    expect(toTokenUnits('0', 6)).toBeNull();
    expect(toTokenUnits('-1', 6)).toBeNull();
    expect(toTokenUnits('1e3', 6)).toBeNull();
    expect(canonicalAmount('010.500')).toBe('10.5');
    expect(canonicalAmount('7.')).toBeNull();
    expect(plainDecimal('25.000000')).toBe('25');
    expect(plainDecimal('14.75')).toBe('14.75');
    expect(plainDecimal('0')).toBe('0');
  });

  it('one withdrawal is one business key: the owner and the moment it was asked, never a random id', () => {
    expect(venueWithdrawalKey('0xABCDEF0000000000000000000000000000000001', 1_762_678_800_000)).toBe(
      'venue-withdraw:0xabcdef0000000000000000000000000000000001:1762678800000',
    );
  });

  it('the venue payload gets its domain declared for the wallet, and nothing else changes', () => {
    const typed = {
      domain: { name: 'INTAFACED TEST venue simulator', version: '1', chainId: 84532 },
      types: { Action: [{ name: 'kind', type: 'string' }] },
      primaryType: 'Action',
      message: { kind: 'withdraw' },
    };
    expect(withDomainTypes(typed)).toEqual({
      ...typed,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Action: typed.types.Action,
      },
    });
  });

  it('a withdrawal shows pending, then done, with the venue fee and the network fee, or "not known" (never 0)', () => {
    const base = {
      nonce: '1',
      asset: 'USDC',
      amount: '10',
      destination: '0xabcdef0000000000000000000000000000000001',
      status: 'pending' as const,
      fee: { known: true as const, value: '1' },
      networkFee: { known: false as const },
    };
    const pending = renderToStaticMarkup(<WithdrawalView amount="10" record={base} t={t} />);
    expect(pending).toContain('Pending');
    expect(pending).toMatch(/data-testid="venue-fee">1 TEST USDC</);
    expect(pending).toMatch(/data-testid="network-fee">not known</);
    const done = renderToStaticMarkup(
      <WithdrawalView amount="10" record={{ ...base, status: 'done', networkFee: { known: true, value: '0.25' } }} t={t} />,
    );
    expect(done).toContain('Done');
    expect(done).toMatch(/data-testid="network-fee">0.25 TEST USDC</);
    expect(renderToStaticMarkup(<WithdrawalView amount="10" record={null} t={t} />)).toContain('Not known: the venue is checking it');
  });
});
