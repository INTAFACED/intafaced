import type { GridPlan } from './model';
import { botsCopy } from './copy';

const WIDTH = 396;
const HEIGHT = 148;
const PAD = 10;

/** The grid lines of the bot being set up: green below the sample price (buys), red above (sells). Drawn from the plan, no chart library. */
export function GridChart({ plan, priceText }: { plan: GridPlan; priceText: string }) {
  const { t } = botsCopy.useCopy();
  const y = (position: number) => HEIGHT - PAD - Math.max(0, Math.min(1, position)) * (HEIGHT - 2 * PAD);
  return (
    <figure className="bots-chart" data-testid="bots-grid-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('Grid chart label')} className="bots-chart__svg">
        {plan.levels.map((level, index) => (
          <line
            key={index}
            x1={0}
            x2={WIDTH}
            y1={y(level.position)}
            y2={y(level.position)}
            className={level.side === 'buy' ? 'bots-line bots-line--buy' : level.side === 'sell' ? 'bots-line bots-line--sell' : 'bots-line'}
          />
        ))}
        {plan.pricePosition !== null ? (
          <g>
            <line x1={0} x2={WIDTH} y1={y(plan.pricePosition)} y2={y(plan.pricePosition)} className="bots-line bots-line--price" />
            <text x={WIDTH - 4} y={Math.max(14, y(plan.pricePosition) - 5)} textAnchor="end" className="bots-chart__label">
              {t('Sample price line', { price: priceText })}
            </text>
          </g>
        ) : null}
      </svg>
    </figure>
  );
}
