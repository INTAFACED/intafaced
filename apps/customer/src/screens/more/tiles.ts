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
  type LucideIcon,
} from 'lucide-react';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import type { moreCopy } from './copy';

type Key = Parameters<typeof moreCopy.t>[0];

export type Section = 'Account' | 'Settings' | 'Help' | 'Explore' | 'Protocol';

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
  { id: 'display', href: '/view', icon: SlidersHorizontal, title: 'Display tile', line: 'Display line', section: 'Settings' },
  {
    id: 'notifications',
    href: '/notifications',
    icon: Bell,
    title: 'Notifications tile',
    line: 'Notifications line',
    section: 'Settings',
    feature: 'notifications',
  },
  { id: 'help', href: '/support', icon: CircleHelp, title: 'Help tile', line: 'Help line', section: 'Help', feature: 'help-support' },
  { id: 'bank', href: '/bank', icon: Landmark, title: 'Bank tile', line: 'Bank line', section: 'Explore' },
  { id: 'merchant', href: '/pay/merchant', icon: Building2, title: 'Merchant tile', line: 'Merchant line', section: 'Explore' },
  { id: 'academy', href: '/academy', icon: GraduationCap, title: 'Academy tile', line: 'Academy line', section: 'Explore' },
  { id: 'agents', href: '/agents', icon: Bot, title: 'Agents tile', line: 'Agents line', section: 'Explore' },
  { id: 'quant', href: '/quant', icon: FlaskConical, title: 'Quant tile', line: 'Quant line', section: 'Explore' },
  { id: 'launch', href: '/launch', icon: Rocket, title: 'Launch tile', line: 'Launch line', section: 'Explore' },
  { id: 'market', href: '/market', icon: Store, title: 'Market tile', line: 'Market line', section: 'Explore' },
  { id: 'predict', href: '/predict', icon: Target, title: 'Predict tile', line: 'Predict line', section: 'Explore' },
  { id: 'mining', href: '/mining', icon: Pickaxe, title: 'Mining tile', line: 'Mining line', section: 'Explore' },
  { id: 'token', href: '/token', icon: Coins, title: 'Token tile', line: 'Token line', section: 'Explore' },
  { id: 'blueprint', href: '/blueprint', icon: Fingerprint, title: 'Blueprint tile', line: 'Blueprint line', section: 'Explore' },
  { id: 'campaigns', href: '/campaigns', icon: Megaphone, title: 'Campaigns tile', line: 'Campaigns line', section: 'Explore' },
  { id: 'promotions', href: '/uc/promotion', icon: Gift, title: 'Promotions tile', line: 'Promotions line', section: 'Explore' },
  // Parked rooms are listed and open, with the named blockers on the page; their routes stay area `parked`.
  { id: 'chain', href: '/chain', icon: Link2, title: 'Chain tile', line: 'Parked line', section: 'Protocol' },
  { id: 'dex', href: '/dex', icon: ArrowLeftRight, title: 'DEX tile', line: 'Parked line', section: 'Protocol' },
  { id: 'protocol', href: '/protocol', icon: Network, title: 'Protocol tile', line: 'Parked line', section: 'Protocol' },
];

export const SECTIONS: readonly Section[] = ['Account', 'Settings', 'Help', 'Explore', 'Protocol'];

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
