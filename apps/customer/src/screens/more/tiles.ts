import { Bell, BadgeCheck, CircleHelp, ShieldCheck, SlidersHorizontal, User, type LucideIcon } from 'lucide-react';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import type { moreCopy } from './copy';

type Key = Parameters<typeof moreCopy.t>[0];

export type Section = 'Account' | 'Settings' | 'Help';

export interface Tile {
  id: string;
  /** A live screen, reached with no redirect (tiles.test.ts checks that against the route table). */
  href: string;
  icon: LucideIcon;
  title: Key;
  line: Key;
  section: Section;
  /** Registry feature that must be live too (the page's own route may not be in the registry at all). */
  feature?: string;
}

/**
 * Every tile More could show (UI-SPEC 5.11). A tile renders only while its screen is live: its route is not a hidden feature
 * and, where it names one, its registry feature is live. Nothing hidden is linked.
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
];

export const SECTIONS: readonly Section[] = ['Account', 'Settings', 'Help'];

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
