import { effectiveFeeRate } from './format';
import { uiCopy } from './copy';

type PerAsset = { assetCode: string; total: string };

/**
 * The effective fee rate per asset: fees taken ÷ gross, exact decimal math (see `effectiveFeeRate`), never a mix of
 * assets. Both lists come from reads the page already made, so nothing here is an extra call.
 */
export function EffectiveFeeRates({ gross, fees }: { gross: readonly PerAsset[]; fees: readonly PerAsset[] }) {
  const { t } = uiCopy.useCopy();
  return (
    <div>
      <ul className="pp-lines" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('rateLabel')}>
        {gross.map((g) => {
          const rate = effectiveFeeRate(fees.find((f) => f.assetCode === g.assetCode)?.total ?? '0', g.total);
          return (
            <li key={g.assetCode} className="pp-line">
              <strong className="numeric">{rate ?? '—'}</strong>{' '}
              <span className="pp-unit" lang="zxx">
                {g.assetCode}
              </span>
              {rate === null && <span className="muted"> · {t('rateNone')}</span>}
            </li>
          );
        })}
      </ul>
      <p className="muted pp-note">{t('rateHow')}</p>
    </div>
  );
}
