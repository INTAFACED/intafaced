import { useMemo, useState } from 'react';
import { Hammer } from 'lucide-react';
import { AmountInput, StatusTag, type StatusKind } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { add, compareDecimal, dec, str, sub, times } from '../../../data/decimal';
import { fmtAmount } from '../../../data/format';
import { PreviewActionButton, PreviewChip, PreviewScreen } from '../../../preview';
import { ifcFixture, type IfcProposal, type ProposalStatus } from '../../../preview/fixtures/ifc';
import './ifc.css';
import { ifcCopy } from './copy';
import { barPct } from './format';

const { balance, stakeOptions, tiers, proposals, uses, activity, notPromises, mining } = ifcFixture.rows;

const held = str(add(dec(balance.available)!, dec(balance.staked)!));
const currentIndex = tiers.reduce((best, tier, index) => (compareDecimal(held, tier.hold)! >= 0 ? index : best), 0);
const currentTier = tiers[currentIndex]!;
const nextTier = tiers[currentIndex + 1];

const statusKind: Record<ProposalStatus, StatusKind> = { voting: 'working', passed: 'filled', rejected: 'cancelled', draft: 'working' };

/** Sample reward for an amount: amount x (reward per 1,000) / 1,000, in scaled integers. Drawn as a labelled sample, never as a promise. */
function sampleReward(amount: string, per1000: string): string | null {
  const a = dec(amount === '' || amount === '.' ? null : amount);
  const r = dec(per1000);
  if (a === null || r === null || a <= 0n) return null;
  return str(times(a, r) / 1000n);
}

function Proposal({ proposal }: { proposal: IfcProposal }) {
  const { t } = ifcCopy.useCopy();
  const label: Record<ProposalStatus, string> = {
    voting: t('Status voting'),
    passed: t('Status passed'),
    rejected: t('Status rejected'),
    draft: t('Status draft'),
  };
  return (
    <li className="pv-ifc__proposal" data-status={proposal.status} data-testid="ifc-proposal">
      <div className="pv-ifc__proposal-top">
        <span className="pv-ifc__label">{proposal.number}</span>
        <StatusTag status={statusKind[proposal.status]} label={label[proposal.status]} />
      </div>
      <p className="pv-ifc__strong">{proposal.title}</p>
      <p className="pv-ifc__label">{proposal.summary}</p>
      {proposal.forPct === null || proposal.againstPct === null ? null : (
        <>
          <div
            className="pv-ifc__split"
            role="img"
            aria-label={`${t('For label', { pct: proposal.forPct })}, ${t('Against label', { pct: proposal.againstPct })}`}
          >
            <span style={{ width: `${proposal.forPct}%` }} />
          </div>
          <div className="pv-ifc__split-labels">
            <span>{t('For label', { pct: proposal.forPct })}</span>
            <span>{t('Against label', { pct: proposal.againstPct })}</span>
          </div>
        </>
      )}
      <div className="pv-ifc__proposal-foot">
        <span className="pv-ifc__label">
          {proposal.timing}
          {proposal.yourVote === null ? '' : `. ${proposal.yourVote === 'for' ? t('You voted for') : t('You voted against')}`}
        </span>
        {proposal.status === 'voting' && proposal.yourVote === null ? (
          <span className="pv-ifc__vote">
            <PreviewActionButton product="ifc" variant="primary" size={28}>
              {t('Vote for')}
            </PreviewActionButton>
            <PreviewActionButton product="ifc" variant="secondary" size={28}>
              {t('Vote against')}
            </PreviewActionButton>
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** IFC Preview: balance, staking, fee-discount tiers, governance and a mining "In build" card. Sample data; no price, yield or buyback claims. */
export default function IfcPreview(_props: ScreenProps) {
  const { t } = ifcCopy.useCopy();
  const [optionId, setOptionId] = useState(stakeOptions[0]!.id);
  const [amount, setAmount] = useState('1000');
  const option = stakeOptions.find((o) => o.id === optionId) ?? stakeOptions[0]!;
  const reward = useMemo(() => sampleReward(amount, option.sampleRewardPer1000), [amount, option]);
  const gap = nextTier ? str(sub(dec(nextTier.hold)!, dec(held)!)) : null;
  const nextLine =
    nextTier && gap ? t('Next tier', { amount: fmtAmount(gap, { places: 0 }), tier: nextTier.label, pct: nextTier.discountPct }) : '';

  return (
    <PreviewScreen product="ifc">
      <div className="pv-ifc">
        <div className="pv-ifc__grid">
          <section className="pv-ifc__panel" aria-labelledby="pv-ifc-balance" data-testid="ifc-balance">
            <h2 id="pv-ifc-balance" className="pv-ifc__h2">
              {t('Balance title')} <PreviewChip />
            </h2>
            <p className="pv-ifc__label">{t('Total held')}</p>
            <p className="pv-ifc__big">
              {fmtAmount(held, { places: 2, fixed: true })} <span>IFC</span>
            </p>
            <p className="pv-ifc__label">{t('No price')}</p>
            <dl className="pv-ifc__stats">
              <div>
                <dt>{t('Available')}</dt>
                <dd>{fmtAmount(balance.available, { places: 2, fixed: true })} IFC</dd>
              </div>
              <div>
                <dt>{t('Staked')}</dt>
                <dd>{fmtAmount(balance.staked, { places: 2, fixed: true })} IFC</dd>
              </div>
              <div>
                <dt>{t('Pending rewards')}</dt>
                <dd>{fmtAmount(balance.pendingRewards, { places: 2, fixed: true })} IFC</dd>
              </div>
            </dl>
            <div className="pv-ifc__actions">
              <PreviewActionButton product="ifc" variant="primary" size={40}>
                {t('Stake')}
              </PreviewActionButton>
              <PreviewActionButton product="ifc" variant="secondary" size={40}>
                {t('Unstake')}
              </PreviewActionButton>
              <PreviewActionButton product="ifc" variant="secondary" size={40}>
                {t('Claim rewards')}
              </PreviewActionButton>
            </div>
          </section>

          <section className="pv-ifc__panel" aria-labelledby="pv-ifc-tier" data-testid="ifc-tier">
            <h2 id="pv-ifc-tier" className="pv-ifc__h2">
              {t('Tier title')} <PreviewChip />
            </h2>
            <p className="pv-ifc__big pv-ifc__big--tier">{t('Tier discount', { pct: currentTier.discountPct })}</p>
            <p className="pv-ifc__label">
              {currentTier.discountPct === '0' ? t('No discount') : t('Current tier', { tier: currentTier.label })}
            </p>
            {nextTier && gap ? (
              <>
                <div className="pv-ifc__bar" role="img" aria-label={nextLine}>
                  <span style={{ width: `${barPct(held, nextTier.hold)}%` }} />
                </div>
                <p className="pv-ifc__note">{nextLine}</p>
              </>
            ) : (
              <p className="pv-ifc__note">{t('Top tier')}</p>
            )}
          </section>
        </div>

        <section className="pv-ifc__panel" aria-labelledby="pv-ifc-tiers">
          <h2 id="pv-ifc-tiers" className="pv-ifc__h2">
            {t('Tiers title')} <PreviewChip />
          </h2>
          <table className="pv-ifc__table">
            <thead>
              <tr>
                <th scope="col">{t('Column tier')}</th>
                <th scope="col" className="pv-ifc__right">
                  {t('Column hold')}
                </th>
                <th scope="col" className="pv-ifc__right">
                  {t('Column discount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier, index) => (
                <tr key={tier.id} data-current={index === currentIndex} data-testid="ifc-tier-row">
                  <th scope="row">
                    {tier.label}
                    {index === currentIndex ? <span className="pv-ifc__you">{t('Your tier')}</span> : null}
                  </th>
                  <td className="pv-ifc__right pv-ifc__num">{fmtAmount(tier.hold, { places: 0 })} IFC</td>
                  <td className="pv-ifc__right pv-ifc__num">{tier.discountPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pv-ifc__note">{t('Tiers note')}</p>
        </section>

        <div className="pv-ifc__grid">
          <section className="pv-ifc__panel" aria-labelledby="pv-ifc-stake" data-testid="ifc-staking">
            <h2 id="pv-ifc-stake" className="pv-ifc__h2">
              {t('Staking title')} <PreviewChip />
            </h2>
            <p className="pv-ifc__note pv-ifc__note--first">{t('Staking lede')}</p>
            <div className="pv-ifc__options" role="group" aria-label={t('Staking title')}>
              {stakeOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="pv-ifc__option"
                  aria-pressed={item.id === optionId}
                  onClick={() => setOptionId(item.id)}
                >
                  <span className="pv-ifc__strong">{item.label}</span>
                  <span className="pv-ifc__label">{item.lock}</span>
                  <span className="pv-ifc__label">
                    {t('Sample reward label')}:{' '}
                    {t('Sample reward line', { amount: fmtAmount(item.sampleRewardPer1000, { places: 2, fixed: true }) })}
                  </span>
                </button>
              ))}
            </div>
            <div className="pv-ifc__stake-form">
              <AmountInput label={t('Amount label')} unit="IFC" value={amount} onValueChange={setAmount} precision={2} placeholder="0.00" />
              <PreviewActionButton product="ifc" variant="primary" size={40}>
                {t('Stake')}
              </PreviewActionButton>
            </div>
            <p className="pv-ifc__note" data-testid="ifc-sample-reward">
              {reward === null ? option.detail : t('Your sample reward', { amount: fmtAmount(reward, { places: 2, fixed: true }) })}{' '}
              <span className="pv-ifc__flag">{t('Not a promise')}</span>
            </p>
          </section>

          <section className="pv-ifc__panel pv-ifc__panel--quiet" aria-labelledby="pv-ifc-not" data-testid="ifc-not-promises">
            <h2 id="pv-ifc-not" className="pv-ifc__h2">
              {t('Not promises title')} <PreviewChip />
            </h2>
            <ul className="pv-ifc__list">
              {notPromises.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <h3 className="pv-ifc__h3">{t('Used for title')}</h3>
            <ul className="pv-ifc__uses">
              {uses.map((use) => (
                <li key={use.id}>
                  <span className="pv-ifc__strong">{use.title}</span>
                  <span className="pv-ifc__label">{use.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="pv-ifc__panel" aria-labelledby="pv-ifc-gov" data-testid="ifc-governance">
          <div className="pv-ifc__head">
            <h2 id="pv-ifc-gov" className="pv-ifc__h2">
              {t('Governance title')} <PreviewChip />
            </h2>
            <span className="pv-ifc__label">{t('Voting power', { amount: fmtAmount(balance.staked, { places: 2, fixed: true }) })}</span>
          </div>
          <p className="pv-ifc__note pv-ifc__note--first">{t('Governance lede')}</p>
          <ul className="pv-ifc__proposals">
            {proposals.map((proposal) => (
              <Proposal key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        </section>

        <div className="pv-ifc__grid">
          <section className="pv-ifc__panel pv-ifc__panel--build" aria-labelledby="pv-ifc-mining" data-testid="ifc-mining">
            <h2 id="pv-ifc-mining" className="pv-ifc__h2">
              <Hammer size={16} strokeWidth={1.75} aria-hidden="true" />
              {mining.title} <PreviewChip />
            </h2>
            <span className="pv-ifc__build">{t('Mining state')}</span>
            <p className="pv-ifc__note">{mining.detail}</p>
          </section>
          <section className="pv-ifc__panel" aria-labelledby="pv-ifc-activity">
            <h2 id="pv-ifc-activity" className="pv-ifc__h2">
              {t('Activity title')} <PreviewChip />
            </h2>
            <ul className="pv-ifc__activity">
              {activity.map((item) => (
                <li key={item.id}>
                  <span>
                    <span className="pv-ifc__strong">{item.label}</span>
                    <span className="pv-ifc__label">{item.when}</span>
                  </span>
                  <span className="pv-ifc__num">+{fmtAmount(item.amount, { places: 2, fixed: true })} IFC</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </PreviewScreen>
  );
}
