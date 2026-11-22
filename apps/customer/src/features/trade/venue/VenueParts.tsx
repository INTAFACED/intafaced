/**
 * The venue parts a Volt room draws (Convert in venue mode), drawn only from the kit: the TEST label, the wallet frame, the
 * wallet bar and the balances table. VenueKit.tsx re-exports them, so every desk that imports them from there draws the
 * same parts.
 */
import { useCallback, type ReactNode } from 'react';
import { TestLabel } from '@intafaced/ui/lit';
import { usePreferences } from '../../../shared/preferences';
import { displayAmount } from '../../../shared/money';
import { WalletProvider } from '../../protocol';
import type { AsOf, VenueBalance } from '../venue-api';
import type { VenueMode } from '../use-venue-mode';
import { venueCopy } from './venue-copy';

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function TestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <TestLabel data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </TestLabel>
  );
}

export function useAsOfText(): (iso: string) => string {
  const { timeZone } = usePreferences();
  const { t } = venueCopy.useCopy();
  return useCallback(
    (iso: string) => {
      let text: string;
      try {
        text = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
      } catch {
        text = iso;
      }
      return t('As of', { time: text });
    },
    [timeZone, t],
  );
}

export function AsOfLine({ asOf }: { asOf: string | null }) {
  const text = useAsOfText();
  if (!asOf) return null;
  return (
    <p className="lt-hint" data-testid="venue-as-of">
      {text(asOf)}
    </p>
  );
}

/**
 * The venue frame: the person's wallet on the network the venue signs on (its status names it; the app's own chain
 * otherwise), the venue named with its TEST label and the trading-mode line. Every desk in venue mode sits inside it.
 */
export function VenueFrame({ mode, children }: { mode: Extract<VenueMode, { mode: 'on' }>; children: ReactNode }) {
  const status = mode.status;
  const chainId = status.available && status.chainId ? status.chainId : undefined;
  return (
    <WalletProvider chainId={chainId} scope="venue-desk">
      {children}
    </WalletProvider>
  );
}

export function BalancesPanel({ balances, test }: { balances: AsOf<VenueBalance[]> | null; test: boolean }) {
  const { t } = venueCopy.useCopy();
  return (
    <section aria-label={t('Balances')} data-testid="venue-balances">
      <h2>
        {t('Balances')} <TestMark test={test} />
      </h2>
      {balances && balances.value.length > 0 ? (
        <div role="region" aria-label={t('Balances')} tabIndex={0}>
          <table className="lt-table">
            <caption className="lt-sr">{t('Balances')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('Asset')}</th>
                <th scope="col" data-align="end">
                  {t('Free')}
                </th>
                <th scope="col" data-align="end">
                  {t('Used')}
                </th>
                <th scope="col" data-align="end">
                  {t('Total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {balances.value.map((b) => (
                <tr key={b.asset} data-asset={b.asset}>
                  <td data-label={t('Asset')}>{b.asset}</td>
                  <td className="lt-mono" data-label={t('Free')} data-align="end" data-cell="free">
                    {displayAmount(b.free)}
                  </td>
                  <td className="lt-mono" data-label={t('Used')} data-align="end" data-cell="used">
                    {displayAmount(b.locked)}
                  </td>
                  <td className="lt-mono" data-label={t('Total')} data-align="end" data-cell="total">
                    {displayAmount(b.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : balances ? (
        <p className="lt-hint">{t('No balances')}</p>
      ) : null}
      <AsOfLine asOf={balances?.asOf ?? null} />
    </section>
  );
}
