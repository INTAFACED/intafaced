import { deskCopy } from './desk-copy';

const MODES = [
  { id: 'Spot', href: '/trade/spot/BTC-USDT' },
  { id: 'Margin', href: '/trade/margin' },
  { id: 'Futures', href: '/trade/futures' },
  { id: 'Options', href: '/trade/options' },
  { id: 'Copy', href: '/trade/copy' },
  { id: 'Bots', href: '/trade/bots' },
  { id: 'Execution', href: '/execution' },
  { id: 'Quote desk', href: '/otc' },
] as const;

/** The trading rooms, one click apart (Binance/OKX product switch). The other rooms belong to their own owners. */
export function ModeStrip({ active }: { active: 'Margin' | 'Futures' }) {
  const { t } = deskCopy.useCopy();
  return (
    <nav aria-label={t('Trading modes')} className="flex flex-wrap items-center gap-1 border-b border-line px-(--if-gutter) py-2">
      {MODES.map((mode) => (
        <a
          key={mode.id}
          href={mode.href}
          aria-current={mode.id === active ? 'page' : undefined}
          className="rounded-md px-3 py-1.5 text-sm text-fg-2 hover:bg-hover hover:text-fg aria-[current=page]:bg-raised aria-[current=page]:font-medium aria-[current=page]:text-fg"
        >
          {t(mode.id)}
        </a>
      ))}
    </nav>
  );
}
