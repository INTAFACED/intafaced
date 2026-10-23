import { Button } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { DepthPanel, DisabledAction } from './DepthParts';
import {
  buildOfframpInput,
  cashOutBlock,
  destinationProblem,
  offrampAmountProblem,
  offrampMatches,
  rampGate,
  RAMP_STEPS,
  type RampStep,
} from './ramp-journey';
import { rampDepthCopy } from './ramp-depth-copy';
import { addMoneyCopy } from './add-money-copy';
import { positiveMoney, useBankRead, type ActionSpec } from './components';
import { assetSelectField, useHoldings } from './holdings';
import './bank-depth.css';

const STEP_KEYS = { amount: 'stepAmount', quote: 'stepQuote', review: 'stepReview', status: 'stepStatus' } as const;

function Steps({ active, off }: { active: RampStep; off: ReadonlySet<RampStep> }) {
  const { t } = rampDepthCopy.useCopy();
  return (
    <ol className="bd-steps">
      {RAMP_STEPS.map((step, index) => (
        <li key={step} aria-current={step === active ? 'step' : undefined} data-off={off.has(step) ? 'true' : undefined}>
          <span className="bd-steps__n">{index + 1}</span>
          {t(STEP_KEYS[step])}
        </li>
      ))}
    </ol>
  );
}

/** The two journeys of the cash room: add money (needs a payment partner) and cash out (needs a live rail). */
export function RampJourneys({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = rampDepthCopy.useCopy();
  const addMoney = addMoneyCopy.useCopy();
  const programme = useBankRead('ramps.programme', undefined);
  const fiat = useBankRead('ramps.fiatSettle', undefined);
  const held = useHoldings();
  const info = programme.resource.status === 'ready' ? programme.resource.data : null;
  const gate = rampGate(info);
  const loading = programme.resource.status === 'loading' || held.resource.status === 'loading';
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const fiatReady = fiat.resource.status === 'ready';
  const providerWord = gate === 'live' ? t('statusLive') : gate === 'simulated' ? t('statusTest') : t('statusOff');
  const block = cashOutBlock(gate, loading, assets.length);
  const blocked =
    block === 'loading'
      ? t('outBlockLoading')
      : block === 'none'
        ? t('outBlockNone')
        : block === 'simulated'
          ? t('outBlockTest')
          : block === 'noAssets'
            ? t('outBlockNoAssets')
            : block === 'stepUp'
              ? t('outBlockStepUp')
              : null;
  const cashOut = () => {
    if (blocked !== null) return;
    open({
      title: t('outTitle'),
      procedure: 'ramps.offramp',
      fields: [
        assetSelectField(t('outAsset'), t('outAssetHint'), assets),
        { ...positiveMoney(undefined, 'amount', t('outAmount')), hint: undefined },
        {
          name: 'destinationRef',
          label: t('outDestination'),
          hint: t('outDestinationHint'),
          validate: (value) => (destinationProblem(value) ? t('outDestinationBad') : null),
        },
      ],
      notes: [t('outNoteQuote'), t('outNoteSteps')],
      submit: t('outSubmit'),
      validate: (input) => {
        const asset = assets.find((row) => row.assetId === input.assetId);
        return asset && offrampAmountProblem(String(input.amount), asset.available) === 'exceeds'
          ? t('outExceeds', { available: displayAmount(asset.available), asset: asset.assetId })
          : null;
      },
      input: (values, requestId) => buildOfframpInput(requestId, values),
      verifyOutcome: offrampMatches,
    });
  };
  return (
    <div className="bd-stack">
      <DepthPanel title={t('providerTitle')} lead={t('providerLead')}>
        <dl className="bd-facts">
          <div className="bd-fact">
            <dt>{t('providerCrypto')}</dt>
            <dd>
              <span className="badge" data-state={gate}>
                {providerWord}
              </span>
            </dd>
          </div>
          <div className="bd-fact">
            <dt>{t('providerFiat')}</dt>
            <dd>
              <span className="badge" data-state={fiatReady ? 'live' : 'none'}>
                {fiatReady ? t('statusLive') : t('statusOff')}
              </span>
            </dd>
          </div>
        </dl>
        <p className="money-caption">{gate === 'simulated' ? t('providerTestNote') : gate === 'none' ? t('providerOffNote') : ''}</p>
        <p className="money-caption">{fiatReady ? t('fiatOnNote') : t('fiatOffNote')}</p>
      </DepthPanel>
      <div className="bd-grid">
        <DepthPanel title={t('addTitle')} lead={t('addLead')}>
          <div className="actions">
            <a className="button button--primary" href="/bank/ramps/new">
              {addMoney.t('open')}
            </a>
          </div>
        </DepthPanel>
        <DepthPanel title={t('outTitle')} lead={t('outLead')}>
          <Steps active="amount" off={new Set<RampStep>(['quote'])} />
          <p className="money-caption">{t('outNoteQuote')}</p>
          <div className="actions">
            <Button onClick={cashOut} disabled={blocked !== null} aria-describedby={blocked ? 'ramp-out-why' : undefined}>
              {t('outButton')}
            </Button>
          </div>
          {blocked && (
            <p id="ramp-out-why" className="money-caption" role="status">
              {blocked}
            </p>
          )}
          <h4 className="bd-subhead">{t('fiatOutTitle')}</h4>
          <DisabledAction label={t('fiatOutButton')} reason={t('fiatOutReason')} />
        </DepthPanel>
      </div>
    </div>
  );
}
