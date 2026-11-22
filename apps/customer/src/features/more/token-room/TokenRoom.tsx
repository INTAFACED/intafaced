import { useState } from 'react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { CatalogueTemplate, KeyValue, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { buybackRunsCopy } from '../buyback-runs-copy';
import { Details, Limit } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { downloadCsv, toCsv } from '../depth-csv';
import { useTokenReads, type TokenTab } from '../Token';
import { useTokenHoldings } from '../TokenHoldings';
import {
  STAKE_CSV_HEADER,
  STAKE_LOCK_DAYS,
  stakeRows,
  summariseStakes,
  unlockCalendar,
  validStakeAmount,
  type StakeRow,
} from '../token-holdings';
import { tokenHoldingsCopy } from '../token-holdings-copy';
import { preservePaperHref } from '../trade-context';
import { EmptyNote, KitRead, ScrollTable, Section } from '../volt-parts';

/** A tier arrives as a short code ("m3"); people read "3 months". An unknown tier is shown as sent. */
const tierLabel = (tier: string): string => (tier === 'flex' || tier === 'm3' || tier === 'm12' ? copyText(`token.tier.${tier}`) : tier);

/** Each section's own address; /token itself is staking. */
const SECTION_PATHS: Readonly<Record<Exclude<TokenTab, 'Staking'>, string>> = {
  Governance: '/token/governance',
  Economy: '/token/economy',
  Burn: '/token/burn',
};

/**
 * /token on the kit: my token access, my stakes, my holdings with the unlock calendar and export, and the stake ticket,
 * laid out in full and switched off with its reason. The same reads and words as the staking tab of the old room
 * (`../Token.tsx`), which the section addresses still draw; each other section's button opens its own address, keeping
 * the simulated view when this one is simulated.
 */
export function TokenRoom({ paper }: { paper: boolean }) {
  const { hideBalances } = usePreferences();
  const [status, setStatus] = useState('all'),
    [limit, setLimit] = useState(50);
  const { access, stakes } = useTokenReads(status, limit);
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.token')}
      description={copyText('moreroutes.exact.stake.records.access.and.governance')}
      state={{ kind: 'ready' }}
      filters={
        <SectionTabs<TokenTab>
          items={[
            { value: 'Staking', label: copyText('token.staking') },
            { value: 'Governance', label: copyText('token.governance') },
            { value: 'Economy', label: copyText('token.economy') },
            { value: 'Burn', label: buybackRunsCopy.t('tab') },
          ]}
          value="Staking"
          onChange={(tab) => {
            if (tab !== 'Staking') navigate(preservePaperHref(SECTION_PATHS[tab], paper));
          }}
          label={copyText('token.token.sections')}
        />
      }
      items={
        <div className="lt-grid lt-grid-main-side">
          <div className="lt-col-main">
            <Section title={copyText('token.your.token.access')}>
              <KitRead resource={access.resource} retry={access.reload}>
                {(a) => (
                  <Details
                    items={[
                      [
                        copyText('token.staked.amount'),
                        hideBalances
                          ? copyText('token.hidden.asset.identity.unavailable')
                          : copyText('token.asset.identity.unavailable.2', { amount: displayAmount(a.staked) }),
                      ],
                      [copyText('token.access.tier'), tierLabel(a.tier)],
                      [copyText('token.fee.discount'), copyText('token.basis.points', { bps: a.feeDiscountBps })],
                    ]}
                  />
                )}
              </KitRead>
            </Section>
            <Section title={copyText('token.your.stakes')}>
              <Select
                label={copyText('token.stake.status')}
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: copyText('token.filter.all') },
                  { value: 'active', label: copyText('token.status.active') },
                  { value: 'pending', label: copyText('token.status.pending') },
                  { value: 'closed', label: copyText('token.status.closed') },
                ]}
              />
              <KitRead resource={stakes.resource} retry={stakes.reload} empty={copyText('token.you.have.no.stakes')}>
                {(rows) => (
                  <>
                    <ScrollTable
                      headers={[
                        copyText('token.amount'),
                        copyText('token.term'),
                        copyText('token.status'),
                        copyText('token.unlock'),
                        copyText('token.action'),
                      ]}
                      label={copyText('token.your.token.stakes')}
                    >
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            {hideBalances ? '••••' : displayAmount(row.amount)}
                            <Text k="token.asset.identity.unavailable" />
                          </td>
                          <td>{copyText(`token.tier.${row.tier}`)}</td>
                          <td>{copyText(`token.status.${row.status}`)}</td>
                          <td>{row.unlocksAt ?? copyText('token.flexible')}</td>
                          <td>
                            <span className="lt-hint">
                              <Text k="token.unstake.unavailable.asset.identity.missing" />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </ScrollTable>
                    <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                  </>
                )}
              </KitRead>
            </Section>
            <Holdings />
          </div>
          <div className="lt-col-side">
            <Section title={copyText('token.staking.asset.identity')}>
              <p role="status">
                <Text k="token.staking.and.unstaking.are.unavailable.until.the" />
              </p>
              <p className="lt-hint">
                <Text k="token.the.token.asset.is.deployment.configurable.stake" />
              </p>
              <p className="lt-hint">
                <Text k="token.your.existing.stake.records.remain.readable.a" />
              </p>
            </Section>
          </div>
        </div>
      }
    />
  );
}

/** Holdings summary, unlock calendar, stake ticket and export. */
function Holdings() {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenHoldingsCopy.useCopy();
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState<StakeRow['tier']>('flex');
  const [exported, setExported] = useState<boolean | null>(null);
  const stakes = useTokenHoldings();
  const show = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  return (
    <Section title={t('holdingsTitle')}>
      <p className="lt-hint">
        <Copy k="assetNote" />
      </p>
      <KitRead resource={stakes.resource} retry={stakes.reload}>
        {(rows) => {
          const now = Date.now();
          const summary = summariseStakes(rows, now);
          const calendar = unlockCalendar(rows, now);
          return (
            <>
              <KeyValue
                rows={[
                  { label: t('sActive'), value: show(summary.active) },
                  { label: t('sLocked'), value: show(summary.locked) },
                  { label: t('sFree'), value: show(summary.free) },
                  { label: t('sPending'), value: show(summary.pending) },
                  { label: t('sUnstaking'), value: show(summary.unstaking) },
                  { label: t('sClosed'), value: show(summary.closed) },
                  { label: t('sCount'), value: summary.count },
                ]}
              />
              <p className="lt-hint">
                <Copy k="loadedNote" />
              </p>
              <h3>
                <Copy k="calendarTitle" />
              </h3>
              {calendar.length ? (
                <ScrollTable headers={[t('colAmount'), t('colTerm'), t('colUnlocks'), t('colLeft')]} label={t('calendarTitle')}>
                  {calendar.map((unlock) => (
                    <tr key={unlock.id}>
                      <td>{show(unlock.amount)}</td>
                      <td>{t(`term_${unlock.tier}`)}</td>
                      <td>
                        <time dateTime={unlock.unlocksAt}>{unlock.unlocksAt.slice(0, 10)}</time>
                      </td>
                      <td>{unlock.daysLeft}</td>
                    </tr>
                  ))}
                </ScrollTable>
              ) : (
                <EmptyNote title={t('calendarEmpty')} />
              )}
              <Button
                tone="secondary"
                disabled={!rows.length}
                onClick={() => setExported(downloadCsv('token-stakes.csv', toCsv(STAKE_CSV_HEADER, stakeRows(rows))))}
              >
                <Copy k="export" />
              </Button>
              {exported !== null ? (
                <p role="status">
                  <Copy k={exported ? 'exported' : 'exportFail'} />
                </p>
              ) : null}
            </>
          );
        }}
      </KitRead>
      <h3>
        <Copy k="ticketTitle" />
      </h3>
      <div className="lt-toolbar">
        <Field
          label={t('ticketAmount')}
          inputMode="decimal"
          value={amount}
          error={amount && !validStakeAmount(amount) ? t('ticketInvalid') : undefined}
          onChange={(event) => setAmount(event.target.value.trim())}
        />
        <Select
          label={t('ticketTerm')}
          value={term}
          onChange={(value) => setTerm(value as StakeRow['tier'])}
          options={(['flex', 'm3', 'm12'] as const).map((value) => ({ value, label: t(`term_${value}`) }))}
        />
      </div>
      <p className="lt-hint">
        {t('ticketLock')}: {STAKE_LOCK_DAYS[term] ? t('lockDays', { days: STAKE_LOCK_DAYS[term] }) : t('noLock')}
      </p>
      {/* A control that cannot run: shown disabled, with the reason next to it. */}
      <div>
        <Button tone="primary" disabled aria-disabled="true">
          {t('ticketReview')}
        </Button>
        <p className="lt-hint" role="note">
          {t('ticketBlocked')}
        </p>
      </div>
    </Section>
  );
}
