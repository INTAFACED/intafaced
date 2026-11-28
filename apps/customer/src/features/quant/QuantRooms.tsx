import { Tabs } from '@intafaced/ui/lit/templates';
import { preservePaperHref } from '../more';
import { algoCopy } from './algo-copy';

export type QuantRoomId =
  | 'home'
  | 'strategies'
  | 'shared'
  | 'library'
  | 'live'
  | 'limits'
  | 'studio'
  | 'backtest'
  | 'sandbox'
  | 'editor'
  | 'tester'
  | 'optimise'
  | 'data'
  | 'execution';

/** Every Algo dev room, always listed: the same room switch Trade uses, so moving between rooms behaves the same everywhere. */
/** Each room's link; `label` is its copy key, which is the id unless the id already names other copy. */
export const QUANT_ROOMS: readonly { id: QuantRoomId; href: string; label?: 'strategiesRoom' }[] = [
  { id: 'home', href: '/quant' },
  { id: 'strategies', href: '/quant/strategies', label: 'strategiesRoom' },
  { id: 'shared', href: '/quant/shared' },
  { id: 'library', href: '/quant/library' },
  { id: 'live', href: '/quant/live' },
  { id: 'limits', href: '/quant/limits' },
  { id: 'studio', href: '/quant/studio' },
  { id: 'backtest', href: '/quant/backtest' },
  { id: 'sandbox', href: '/quant/sandbox' },
  { id: 'editor', href: '/quant/editor' },
  { id: 'tester', href: '/quant/tester' },
  { id: 'optimise', href: '/quant/optimise' },
  { id: 'data', href: '/quant/data' },
  { id: 'execution', href: '/execution' },
];

/** The Algo dev rooms as the kit's section tab bar: the route's room lit, its detail pages under it (a strategy, a listing). */
export function QuantRooms({ paper = false }: { paper?: boolean }) {
  const { t } = algoCopy.useCopy();
  const items = QUANT_ROOMS.map((room) => ({ label: t(room.label ?? room.id), href: preservePaperHref(room.href, paper) }));
  return <Tabs label={t('rooms')} items={items} />;
}
