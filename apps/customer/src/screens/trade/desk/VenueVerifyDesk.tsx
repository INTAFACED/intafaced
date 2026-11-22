import { useState } from 'react';
import { Button, Tab, TabList, TabPanel, TabSet } from '@intafaced/ui/lit';
import { DeskTemplate } from '@intafaced/ui/lit/templates';
import { refusalCopy } from '../../../data';
import { type VenueUp } from '../../../features/trade/venue-api';
import { TestMark, VenueHeader } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { deskCopy } from './copy';
import { AmountInput } from './deps';
import { spotVenueCopy } from './venue-copy';
import type { VenueOrderType, VenueSide } from './venue-desk';
import { KYC_REQUIRED } from './venue-access';
import { VenueWalletRow } from './VenueAccountPanel';

/** Why an unverified person's order button is off, with the way to Verify. */
export function VerifyNote() {
  const verify = refusalCopy(KYC_REQUIRED, {});
  return (
    <div data-testid="dk-note--bad" className="lt-callout lt-callout-bad" role="alert">
      <p className="lt-strong">{verify.title}</p>
      <p>{verify.body}</p>
      {verify.action ? (
        <a className="lt-link" href={verify.action.href}>
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
  const account = (
    <section className="lt-panel" aria-label={t('Venue account')} data-testid="venue-account" data-access="verify">
      <h2 className="lt-panel-title">
        {t('Venue account')} <TestMark test={status.test} />
      </h2>
      <p className="lt-note">{t('Venue account verify')}</p>
      <VenueWalletRow />
      <p className="lt-row">
        <Button tone="primary" disabled>
          {t('Deposit')}
        </Button>{' '}
        <Button tone="secondary" disabled>
          {t('Withdraw')}
        </Button>
      </p>
    </section>
  );
  const ticket = (
    <TabSet value={type} onValueChange={(value) => setType(value as VenueOrderType)} data-testid="dk-order" className="lt-panel">
      <div className="lt-panel-head">
        <TabList aria-label={t('Order type')}>
          <Tab value="limit">{d('Limit')}</Tab>
          <Tab value="market">{d('Market')}</Tab>
        </TabList>
      </div>
      <TabPanel value={type}>
        <div className="lt-stack">
          {(['buy', 'sell'] as const).map((side) => (
            <VerifySideForm key={side} side={side} type={type} base={base} quote={quote} />
          ))}
        </div>
      </TabPanel>
    </TabSet>
  );
  // Every control stays in reach: the order buttons are off with the way to Verify, so the desk is ready, not a gate.
  return (
    <div data-testid="if-desk" data-market={symbol} data-venue="on" data-access="verify">
      <DeskTemplate
        title={d('Spot desk')}
        mode="pro"
        state={{ kind: 'ready' }}
        instrument={null}
        arrangement={{ columns: [{ region: 'chart', width: 'minmax(0, 1fr)' }] }}
        chart={
          // The header heads the main column, not the instrument strip: no venue price was read for this person.
          <div className="lt-stack">
            <VenueHeader status={status} title={t('Spot on venue', { symbol })} feeLine={feeLine} />
            {account}
          </div>
        }
        ticket={ticket}
      />
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
      className="lt-stack"
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
      <Button type="submit" tone={side === 'buy' ? 'up' : 'down'} block disabled aria-describedby={`dk-reason-${side}`}>
        {side === 'buy' ? d('Buy asset', { asset: base }) : d('Sell asset', { asset: base })}
      </Button>
      <div id={`dk-reason-${side}`} aria-live="polite">
        <VerifyNote />
      </div>
    </form>
  );
}

/** Places a typed figure keeps on the unverified desk, where the venue's own steps were not read. */
const VERIFY_PLACES = 8;
