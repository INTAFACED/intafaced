import { useState } from 'react';
import { Check, Circle, FileText } from 'lucide-react';
import { SegmentedControl, StatusTag } from '@intafaced/ui';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import { p2pFixture, type P2pTradeState } from '../../../preview/fixtures/p2p';
import { p2pCopy } from './copy';
import { coinText, fiatText } from './format';

const { trade, appeal, advertisers, fiats } = p2pFixture.rows;
const seller = advertisers.find((advertiser) => advertiser.id === trade.advertiserId)!;
const fiat = fiats.find((f) => f.id === trade.fiat)!;

export function TradePanel({ onBackToOffers }: { onBackToOffers: () => void }) {
  const { t } = p2pCopy.useCopy();
  const [state, setState] = useState<P2pTradeState>('awaiting-payment');
  const currentStep = trade.stepFor[state];
  const currentIndex = trade.steps.findIndex((step) => step.id === currentStep);
  const finished = state === 'released';
  const [draft, setDraft] = useState('');

  return (
    <section className="pv-p2p__trade" aria-labelledby="pv-p2p-trade-title" data-testid="p2p-trade" data-state={state}>
      <div className="pv-p2p__panel pv-p2p__trade-main">
        <div className="pv-p2p__panel-head">
          <h2 id="pv-p2p-trade-title" className="pv-p2p__h2">
            {t('Trade title')} <PreviewChip />
          </h2>
          <div className="pv-p2p__state">
            <span className="pv-p2p__label">{t('State label')}</span>
            <SegmentedControl
              aria-label={t('State label')}
              size={32}
              value={state}
              onValueChange={(next) => setState(next as P2pTradeState)}
              items={[
                { value: 'awaiting-payment', label: t('State awaiting') },
                { value: 'payment-sent', label: t('State sent') },
                { value: 'released', label: t('State done') },
                { value: 'appeal', label: t('State appeal') },
              ]}
            />
          </div>
        </div>

        <p className="pv-p2p__trade-with">{t('Trade with', { coin: trade.asset, name: seller.name })}</p>
        <dl className="pv-p2p__facts">
          <div>
            <dt>{t('You pay')}</dt>
            <dd className="pv-p2p__big">{fiatText(fiat, trade.fiatAmount, '0.01')}</dd>
          </div>
          <div>
            <dt>{t('Price')}</dt>
            <dd>{fiatText(fiat, trade.price, trade.priceTick)}</dd>
          </div>
          <div>
            <dt>{t('You receive')}</dt>
            <dd>
              {coinText(trade.amount)} {trade.asset}
            </dd>
          </div>
          {state === 'awaiting-payment' ? (
            <div>
              <dt>{t('Pay within')}</dt>
              <dd>{t('Pay within value', { minutes: trade.payWindowMinutes })}</dd>
            </div>
          ) : null}
        </dl>
        {state !== 'released' ? (
          <p className="pv-p2p__escrow" data-testid="p2p-escrow">
            {t('Escrow held', { amount: coinText(trade.amount), coin: trade.asset })}
          </p>
        ) : null}

        <h3 className="pv-p2p__h3">{t('Steps title')}</h3>
        <ol className="pv-p2p__steps">
          {trade.steps.map((step, index) => {
            const done = finished || index < currentIndex;
            const here = !finished && index === currentIndex;
            return (
              <li key={step.id} className="pv-p2p__step" data-done={done} data-here={here} aria-current={here ? 'step' : undefined}>
                <span className="pv-p2p__dot" aria-hidden="true">
                  {done ? <Check size={12} strokeWidth={3} /> : <Circle size={8} strokeWidth={3} />}
                </span>
                <span>
                  <span className="pv-p2p__strong">{step.title}</span>
                  <span className="pv-p2p__stats">{here ? t('Step here') : step.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {state === 'awaiting-payment' ? (
          <>
            <h3 className="pv-p2p__h3">{t('Pay to title')}</h3>
            <p className="pv-p2p__stats">{t('Pay to note')}</p>
            <dl className="pv-p2p__facts pv-p2p__facts--pay">
              {trade.payTo.map((line) => (
                <div key={line.label}>
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}

        {state === 'appeal' ? (
          <div className="pv-p2p__appeal" data-testid="p2p-appeal">
            <div className="pv-p2p__appeal-head">
              <h3 className="pv-p2p__h3">
                {t('Appeal title')} <PreviewChip />
              </h3>
              <StatusTag status="pending" label={appeal.status} />
            </div>
            <dl className="pv-p2p__facts pv-p2p__facts--wide">
              <div>
                <dt>{t('Appeal reason')}</dt>
                <dd>{appeal.reason}</dd>
              </div>
            </dl>
            <h4 className="pv-p2p__h4">{t('Appeal steps')}</h4>
            <ol className="pv-p2p__steps pv-p2p__steps--small">
              {appeal.steps.map((step, index) => (
                <li key={step.id} className="pv-p2p__step" data-done={index < appeal.doneSteps} data-here={index === appeal.doneSteps}>
                  <span className="pv-p2p__dot" aria-hidden="true">
                    {index < appeal.doneSteps ? <Check size={12} strokeWidth={3} /> : <Circle size={8} strokeWidth={3} />}
                  </span>
                  <span>
                    <span className="pv-p2p__strong">{step.title}</span>
                    <span className="pv-p2p__stats">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <h4 className="pv-p2p__h4">{t('Appeal evidence')}</h4>
            <ul className="pv-p2p__evidence">
              {appeal.evidence.map((item) => (
                <li key={item.name}>
                  <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>
                    <span className="pv-p2p__strong">{item.name}</span>
                    <span className="pv-p2p__stats">{item.note}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="pv-p2p__stats">{appeal.escrowNote}</p>
          </div>
        ) : null}

        <div className="pv-p2p__actions">
          {state === 'awaiting-payment' ? (
            <>
              <PreviewActionButton product="p2p" variant="primary" size={40}>
                {t('I have paid')}
              </PreviewActionButton>
              <PreviewActionButton product="p2p" variant="secondary" size={40}>
                {t('Cancel order')}
              </PreviewActionButton>
            </>
          ) : null}
          {state === 'payment-sent' ? (
            <PreviewActionButton product="p2p" variant="secondary" size={40}>
              {t('Open appeal')}
            </PreviewActionButton>
          ) : null}
          {state === 'released' ? (
            <>
              <PreviewActionButton product="p2p" variant="primary" size={40}>
                {t('Rate seller')}
              </PreviewActionButton>
              <button type="button" className="pv-p2p__link" onClick={onBackToOffers}>
                {t('Tab offers')}
              </button>
            </>
          ) : null}
          {state === 'appeal' ? (
            <>
              <PreviewActionButton product="p2p" variant="primary" size={40}>
                {t('Add evidence')}
              </PreviewActionButton>
              <PreviewActionButton product="p2p" variant="secondary" size={40}>
                {t('Message reviewer')}
              </PreviewActionButton>
            </>
          ) : null}
        </div>
      </div>

      <aside className="pv-p2p__panel pv-p2p__chat" aria-labelledby="pv-p2p-chat-title" data-testid="p2p-chat">
        <h2 id="pv-p2p-chat-title" className="pv-p2p__h2">
          {t('Chat title')} <PreviewChip />
        </h2>
        <ul className="pv-p2p__messages">
          {trade.chat[state].map((line, index) => (
            <li key={`${state}-${index}`} className={`pv-p2p__msg pv-p2p__msg--${line.from}`}>
              <span className="pv-p2p__msg-from">
                {line.from === 'you' ? t('You') : line.from === 'them' ? seller.name : t('System')} <span>{line.when}</span>
              </span>
              <span className="pv-p2p__msg-text">{line.text}</span>
            </li>
          ))}
        </ul>
        <div className="pv-p2p__composer">
          <input
            className="pv-p2p__input"
            aria-label={t('Chat input label')}
            placeholder={t('Chat placeholder')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <PreviewActionButton product="p2p" variant="secondary" size={40}>
            {t('Send')}
          </PreviewActionButton>
        </div>
      </aside>
    </section>
  );
}
