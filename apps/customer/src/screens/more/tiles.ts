import {
  ArrowLeftRight,
  BadgeCheck,
  Bell,
  Bot,
  Building2,
  CircleHelp,
  Coins,
  Fingerprint,
  FlaskConical,
  Gift,
  GraduationCap,
  Landmark,
  Link2,
  Megaphone,
  Network,
  Pickaxe,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Target,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import { rooms, type Door, type Room } from '../../app/navigation';
import type { moreCopy } from './copy';

type Key = Parameters<typeof moreCopy.t>[0];

export type Section = 'Learn and build' | 'Markets and assets' | 'Money and pay' | 'Rewards' | 'Web3' | 'Help' | 'Account';

export interface Tile {
  id: string;
  /** A screen that opens, reached with no redirect (tiles.test.ts checks that against the route table). */
  href: string;
  icon: LucideIcon;
  title: Key;
  line: Key;
  section: Section;
  /** Registry feature that must be live too (the page's own route may not be in the registry at all). */
  feature?: string;
}

/**
 * Every tile More shows (UI-SPEC 5.11, founder order 2026-10-17: nothing is hidden). Each one opens its room, and a room that
 * cannot act yet shows its own refusal or empty state there. A tile is still dropped if its route is a hidden feature or its
 * named registry feature is not live; no registry row is hidden today.
 *
 * Help opens `/support`, the signed-in help screen (published answers plus the person's own requests). The public `/help` page
 * is not used here: it shows "Sign in" even to someone who is signed in.
 */
export const TILES: readonly Tile[] = [
  { id: 'academy', href: '/academy', icon: GraduationCap, title: 'Academy tile', line: 'Academy line', section: 'Learn and build' },
  { id: 'agents', href: '/agents', icon: Bot, title: 'Agents tile', line: 'Agents line', section: 'Learn and build' },
  { id: 'quant', href: '/quant', icon: FlaskConical, title: 'Quant tile', line: 'Quant line', section: 'Learn and build' },
  { id: 'blueprint', href: '/blueprint', icon: Fingerprint, title: 'Blueprint tile', line: 'Blueprint line', section: 'Learn and build' },
  { id: 'market', href: '/market', icon: Store, title: 'Market tile', line: 'Market line', section: 'Markets and assets' },
  { id: 'launch', href: '/launch', icon: Rocket, title: 'Launch tile', line: 'Launch line', section: 'Markets and assets' },
  { id: 'token', href: '/token', icon: Coins, title: 'Token tile', line: 'Token line', section: 'Markets and assets' },
  { id: 'mining', href: '/mining', icon: Pickaxe, title: 'Mining tile', line: 'Mining line', section: 'Markets and assets' },
  { id: 'bank', href: '/bank', icon: Landmark, title: 'Bank tile', line: 'Bank line', section: 'Money and pay' },
  { id: 'merchant', href: '/pay/merchant', icon: Building2, title: 'Merchant tile', line: 'Merchant line', section: 'Money and pay' },
  { id: 'p2p', href: '/p2p', icon: Users, title: 'P2P tile', line: 'P2P line', section: 'Money and pay' },
  { id: 'promotions', href: '/uc/promotion', icon: Gift, title: 'Promotions tile', line: 'Promotions line', section: 'Rewards' },
  { id: 'campaigns', href: '/campaigns', icon: Megaphone, title: 'Campaigns tile', line: 'Campaigns line', section: 'Rewards' },
  // The Web3 rooms open to their named blockers; their routes sit in area `web3`, behind the Web3 shell.
  { id: 'dex', href: '/dex', icon: ArrowLeftRight, title: 'DEX tile', line: 'DEX line', section: 'Web3' },
  { id: 'chain', href: '/chain', icon: Link2, title: 'Chain tile', line: 'Chain line', section: 'Web3' },
  { id: 'protocol', href: '/protocol', icon: Network, title: 'Protocol tile', line: 'Protocol line', section: 'Web3' },
  { id: 'predict', href: '/predict', icon: Target, title: 'Predict tile', line: 'Predict line', section: 'Web3' },
  { id: 'help', href: '/support', icon: CircleHelp, title: 'Help tile', line: 'Help line', section: 'Help', feature: 'help-support' },
  { id: 'account', href: '/uc/account', icon: User, title: 'Account tile', line: 'Account line', section: 'Account' },
  { id: 'security', href: '/uc/safe', icon: ShieldCheck, title: 'Security tile', line: 'Security line', section: 'Account' },
  {
    id: 'verification',
    href: '/verification',
    icon: BadgeCheck,
    title: 'Verification tile',
    line: 'Verification line',
    section: 'Account',
  },
  { id: 'display', href: '/view', icon: SlidersHorizontal, title: 'Display tile', line: 'Display line', section: 'Account' },
  {
    id: 'notifications',
    href: '/notifications',
    icon: Bell,
    title: 'Notifications tile',
    line: 'Notifications line',
    section: 'Account',
    feature: 'notifications',
  },
];

/** IA-SPEC 1.4 order. */
export const SECTIONS: readonly Section[] = [
  'Learn and build',
  'Markets and assets',
  'Money and pay',
  'Rewards',
  'Web3',
  'Help',
  'Account',
];

export interface Live {
  hidden: (path: string) => boolean;
  featureLive: (id: string) => boolean;
}
const registry: Live = { hidden: isHiddenPath, featureLive: isFeatureLive };

/** The sections to draw, each with only its live tiles; a section with none is dropped. */
export function visibleSections(live: Live = registry, tiles: readonly Tile[] = TILES): Array<{ section: Section; tiles: Tile[] }> {
  return SECTIONS.map((section) => ({
    section,
    tiles: tiles.filter((tile) => tile.section === section && !live.hidden(tile.href) && (!tile.feature || live.featureLive(tile.feature))),
  })).filter((group) => group.tiles.length > 0);
}

/** A group of the All services index: one of the app's doors, or the rooms that sit outside every door. */
export type ServiceGroupId = Door | 'Account' | 'Web3' | 'Information';
export interface ServiceGroup {
  id: ServiceGroupId;
  rooms: Room[];
}
const GROUP_ORDER: readonly ServiceGroupId[] = ['Home', 'Money', 'Trade', 'Pay', 'More', 'Web3', 'Account', 'Information'];
/** The rooms of a group that are real, signed-in pages or the public information pages: no alias, parameter route, detail page or founder desk. */
function groupOf(room: Room): ServiceGroupId | undefined {
  if (room.alias || room.hidden || room.area === 'team' || /[:*]/.test(room.path)) return undefined;
  // Business-only pages belong to the merchant portal's own menu; its Merchant home and Business bank are the way in.
  if (room.business && room.path !== '/pay/merchant' && room.path !== '/bank/business') return undefined;
  if (room.area === 'public') return 'Information';
  if (room.area === 'web3') return 'Web3';
  if (room.area === 'person') return 'Account';
  return room.door;
}

/**
 * "All services": every room of the route table, grouped, generated so a room added to `rooms` shows here with no edit to this
 * file (IA-SPEC 3.1 item 4). A room is only left out for being an alias, a parameter route, a founder desk, a merchant-portal
 * page (reached from Merchant) or a hidden feature.
 */
export function allServices(live: Live = registry, source: readonly Room[] = rooms): ServiceGroup[] {
  const groups = new Map<ServiceGroupId, Room[]>();
  const seen = new Set<string>();
  for (const room of source) {
    const id = groupOf(room);
    if (!id || seen.has(room.path) || live.hidden(room.path)) continue;
    seen.add(room.path);
    groups.set(id, [...(groups.get(id) ?? []), room]);
  }
  return GROUP_ORDER.flatMap((id) => (groups.has(id) ? [{ id, rooms: groups.get(id)! }] : []));
}
