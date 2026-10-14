import { Clock, Grid3x3, Repeat, type LucideIcon } from 'lucide-react';
import type { SampleBotKind } from '../../../preview/fixtures/bots';
import { botsCopy } from './copy';

const kinds: ReadonlyArray<{ kind: SampleBotKind; icon: LucideIcon; name: 'Grid name' | 'Dca name' | 'Twap name'; line: 'Grid line' | 'Dca line' | 'Twap line' }> = [
  { kind: 'grid', icon: Grid3x3, name: 'Grid name', line: 'Grid line' },
  { kind: 'dca', icon: Repeat, name: 'Dca name', line: 'Dca line' },
  { kind: 'twap', icon: Clock, name: 'Twap name', line: 'Twap line' },
];

/** The three strategies as big choices. Picking one only changes the form on this page; it sends nothing. */
export function StrategyPicker({ value, onChange }: { value: SampleBotKind; onChange: (kind: SampleBotKind) => void }) {
  const { t } = botsCopy.useCopy();
  return (
    <section aria-labelledby="bots-strategy-h" className="bots-strategies">
      <h2 id="bots-strategy-h" className="bots-sr">
        {t('Strategy heading')}
      </h2>
      <div role="radiogroup" aria-label={t('Strategy heading')} className="bots-strategy-row">
        {kinds.map(({ kind, icon: Icon, name, line }) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value === kind}
            data-kind={kind}
            className="bots-strategy"
            onClick={() => onChange(kind)}
          >
            <span className="bots-strategy__icon" aria-hidden="true">
              <Icon size={22} strokeWidth={1.75} />
            </span>
            <span className="bots-strategy__text">
              <span className="bots-strategy__name">{t(name)}</span>
              <span className="bots-strategy__line">{t(line)}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
