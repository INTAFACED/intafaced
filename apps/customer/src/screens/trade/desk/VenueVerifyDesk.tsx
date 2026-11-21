import { useState } from 'react';
import { Button as KitButton } from '../../../shared/ui';
import { type VenueUp } from '../../../features/trade/venue-api';
import { TestMark, VenueHeader } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { deskCopy } from './copy';
import { AmountInput, Button, refusalCopy, Tabs, TabsList, TabsPanel, TabsTab } from './deps';
import { spotVenueCopy } from './venue-copy';
import type { VenueOrderType, VenueSide } from './venue-desk';
import { KYC_REQUIRED } from './venue-access';
import { VenueWalletRow } from './VenueAccountPanel';

/** Why an unverified person's order button is off, with the way to Verify. */
export function VerifyNote() {
  const verify = refusalCopy(KYC_REQUIRED, {});
  return (
    <div data-testid="dk-note--bad" className="dk-note dk-note--bad" role="alert">
      <p className="dk-note-title">{verify.title}</p>
      <p>{verify.body}</p>
      {verify.action ? (
        <a className="dk-link" href={verify.action.href}>
          {verify.action.label}
        </a>
      ) : null}
    </div>
  );
}

/** The spot desk for a person not verified for trading: every control, no venue figure, each order button off with Verify. */
export function VenueVerifyDesk({ status, symbol }: { status: VenueUp; symbol: string }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const d = deskCopy.useCopy().t;
  const [type, setType] = useState<VenueOrderType>('limit');
  const [base = symbol, quote = ''] = symbol.split('-');
  const feeLine = v('Fee line spot', {
    symbol,
    maker: v('Not known'),
    taker: v('Not known'),
    builder: status.builder ? v('Fee bps', { bps: status.builder.feeBps }) : v('Builder fee blank spot'),
  });
  return (
    <div data-testid="if-desk" className="if-desk" data-market={symbol} data-venue="on" data-access="verify">
      <VenueHeader status={status} title={t('Spot on venue', { symbol })} feeLine={feeLine} />
      <section className="dk-panel form-stack" aria-label={t('Venue account')} data-testid="venue-account" data-access="verify">
        <h2 className="dk-tab-title">
          {t('Venue account')} <TestMark test={status.test} />
        </h2>
        <p className="muted">{t('Venue account verify')}</p>
        <VenueWalletRow />
        <p>
          <KitButton disabled>{t('Deposit')}</KitButton>{' '}
          <KitButton variant="secondary" disabled>
            {t('Withdraw')}
          </KitButton>
        </p>
      </section>
      <Tabs value={type} onValueChange={(value) => setType(value as VenueOrderType)} data-testid="dk-order" className="dk-panel dk-order">
        <div className="dk-order-head">
          <TabsList className="dk-tabs" aria-label={t('Order type')}>
            <TabsTab value="limit">{d('Limit')}</TabsTab>
            <TabsTab value="market">{d('Market')}</TabsTab>
          </TabsList>
        </div>
        <TabsPanel value={type} className="dk-order-body">
          <div className="dk-forms">
            {(['buy', 'sell'] as const).map((side) => (
              <VerifySideForm key={side} side={side} type={type} base={base} quote={quote} />
            ))}
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function VerifySideForm({ side, type, base, quote }: { side: VenueSide; type: VenueOrderType; base: string; quote: string }) {
  const d = deskCopy.useCopy().t;
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  return (
    <form
      data-testid="dk-form"
      className="dk-form"
      data-side={side}
      aria-label={side === 'buy' ? d('Buy form', { asset: base }) : d('Sell form', { asset: base })}
      onSubmit={(event) => event.preventDefault()}
    >
      <AmountInput
        label={d('Price')}
        value={type === 'limit' ? price : ''}
        onValueChange={setPrice}
        precision={VERIFY_PLACES}
        readOnly={type === 'market'}
        disabled={type === 'market'}
        unit={quote}
        placeholder={type === 'market' ? d('Market price word') : undefined}
        aria-label={d('Price')}
      />
      <AmountInput
        label={d('Amount')}
        value={amount}
        onValueChange={setAmount}
        precision={VERIFY_PLACES}
        unit={base}
        placeholder="0"
        aria-label={d('Amount')}
      />
      <Button type="submit" variant={side} shape="rounded" size={40} fullWidth disabled aria-describedby={`dk-reason-${side}`}>
        {side === 'buy' ? d('Buy asset', { asset: base }) : d('Sell asset', { asset: base })}
      </Button>
      <div className="dk-reason" id={`dk-reason-${side}`} aria-live="polite">
        <VerifyNote />
      </div>
    </form>
  );
}

/** Places a typed figure keeps on the unverified desk, where the venue's own steps were not read. */
const VERIFY_PLACES = 8;
