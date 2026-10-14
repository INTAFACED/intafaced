import {
  Activity,
  Bell,
  ChartNoAxesColumn,
  ChevronDown,
  CircleHelp,
  House,
  LayoutGrid,
  type LucideIcon,
  Repeat2,
  Search,
  SlidersHorizontal,
  SquareArrowDown,
  SquareArrowUp,
  User,
  Wallet,
  ArrowUpFromLine,
  TrendingUp,
  Coins,
  HandCoins,
  Scale,
  CalendarClock,
  Layers,
  Copy,
  Bot,
  Sparkles,
  Users,
  CreditCard,
  Gem,
} from 'lucide-react';

export type ShellIconName =
  | 'home'
  | 'wallet'
  | 'activity'
  | 'markets'
  | 'spot'
  | 'buy'
  | 'convert'
  | 'send'
  | 'receive'
  | 'help'
  | 'settings'
  | 'grid'
  | 'search'
  | 'bell'
  | 'user'
  | 'chevron'
  | 'earn'
  | 'loans'
  | 'margin'
  | 'futures'
  | 'options'
  | 'copy'
  | 'bots'
  | 'agents'
  | 'p2p'
  | 'card'
  | 'ifc';

const icons: Record<ShellIconName, LucideIcon> = {
  home: House,
  wallet: Wallet,
  activity: Activity,
  markets: ChartNoAxesColumn,
  spot: TrendingUp,
  buy: ArrowUpFromLine,
  convert: Repeat2,
  send: SquareArrowUp,
  receive: SquareArrowDown,
  help: CircleHelp,
  settings: SlidersHorizontal,
  grid: LayoutGrid,
  search: Search,
  bell: Bell,
  user: User,
  chevron: ChevronDown,
  earn: Coins,
  loans: HandCoins,
  margin: Scale,
  futures: CalendarClock,
  options: Layers,
  copy: Copy,
  bots: Bot,
  agents: Sparkles,
  p2p: Users,
  card: CreditCard,
  ifc: Gem,
};

export function ShellIcon({ name, size = 20 }: { name: ShellIconName; size?: number }) {
  const Icon = icons[name];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}
