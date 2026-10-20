import {
  Activity,
  Bell,
  Building2,
  ChartNoAxesColumn,
  ChevronDown,
  CircleHelp,
  GraduationCap,
  House,
  Landmark,
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
  CalendarClock,
  CreditCard,
  HandCoins,
  Layers,
  Sigma,
  TrendingUp,
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
  | 'academy'
  | 'merchant'
  | 'bank'
  | 'margin'
  | 'futures'
  | 'options'
  | 'loans'
  | 'cards';

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
  academy: GraduationCap,
  merchant: Building2,
  bank: Landmark,
  margin: Layers,
  futures: CalendarClock,
  options: Sigma,
  loans: HandCoins,
  cards: CreditCard,
};

export function ShellIcon({ name, size = 20 }: { name: ShellIconName; size?: number }) {
  const Icon = icons[name];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}
