import { Field } from '@intafaced/ui';
import { SelectField } from '../../components';
import { useUrlParam } from '../../hooks';
import { analyticsCopy as c } from './copy';
import { windowFor, type Preset } from './model';

export type AnalyticsState = ReturnType<typeof useAnalyticsState>;
/** Every choice lives in the address, so a view can be shared and survives a reload. */
export function useAnalyticsState(now: number) {
  const [range, setRange] = useUrlParam('range', '30d');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [bucket, setBucket] = useUrlParam('bucket', 'day');
  const [asset, setAsset] = useUrlParam('asset');
  const preset = (['today', '7d', '30d', 'custom'].includes(range) ? range : '30d') as Preset;
  const window = windowFor(preset, now, { from, to });
  return { preset, setRange, from, setFrom, to, setTo, bucket: (bucket === 'week' ? 'week' : 'day') as 'day' | 'week', setBucket, asset, setAsset, window };
}

export function AnalyticsControls({ state, assets }: { state: AnalyticsState; assets: readonly string[] }) {
  const { t } = c.useCopy();
  const badCustom = state.preset === 'custom' && !state.window && (state.from || state.to);
  return (
    <div className="pp-filterbar" role="search" aria-label={t('controls')}>
      <div className="pp-filter-row">
        <SelectField
          label={t('range')}
          value={state.preset}
          onChange={state.setRange}
          options={[
            ['today', t('today')],
            ['7d', t('last7')],
            ['30d', t('last30')],
            ['custom', t('custom')],
          ]}
        />
        <SelectField
          label={t('bucket')}
          value={state.bucket}
          onChange={state.setBucket}
          options={[
            ['day', t('byDay')],
            ['week', t('byWeek')],
          ]}
        />
        {(assets.length > 1 || state.asset) && (
          <SelectField
            label={t('asset')}
            value={state.asset}
            onChange={state.setAsset}
            options={[['', t('allAssets')], ...assets.map((a) => [a, a] as const), ...(state.asset && !assets.includes(state.asset) ? ([[state.asset, state.asset]] as const) : [])]}
          />
        )}
      </div>
      {state.preset === 'custom' && (
        <div className="pp-filter-row">
          <Field label={t('from')} type="date" value={state.from} onChange={(e) => state.setFrom(e.target.value)} />
          <Field label={t('to')} type="date" value={state.to} onChange={(e) => state.setTo(e.target.value)} error={badCustom ? t('errCustom') : undefined} />
        </div>
      )}
    </div>
  );
}
