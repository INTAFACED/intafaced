import { SubNav } from '@intafaced/ui';
import { preservePaperHref } from '../more/trade-context';
import { algoCopy } from './algo-copy';

export type QuantRoomId = 'home' | 'strategies' | 'studio' | 'backtest' | 'sandbox' | 'execution';

/** Every Algo dev room, always listed: the same room switch Trade uses, so moving between rooms behaves the same everywhere. */
/** Each room's link; `label` is its copy key, which is the id unless the id already names other copy. */
export const QUANT_ROOMS: readonly { id: QuantRoomId; href: string; label?: 'strategiesRoom' }[] = [
  { id: 'home', href: '/quant' },
  { id: 'strategies', href: '/quant/strategies', label: 'strategiesRoom' },
  { id: 'studio', href: '/quant/studio' },
  { id: 'backtest', href: '/quant/backtest' },
  { id: 'sandbox', href: '/quant/sandbox' },
  { id: 'execution', href: '/execution' },
];

export function QuantRooms({ active, paper = false }: { active: QuantRoomId; paper?: boolean }) {
  const { t } = algoCopy.useCopy();
  return (
    <SubNav
      aria-label={t('rooms')}
      active={active}
      className="px-0"
      items={QUANT_ROOMS.map((room) => ({
        id: room.id,
        label: t(room.label ?? room.id),
        href: preservePaperHref(room.href, paper),
      }))}
    />
  );
}
