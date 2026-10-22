/**
 * ACADEMY CURRICULUM CATALOG (§8.3, §XIII "structured paths", "playbooks + workbooks").
 *
 * Pure content registry — no database, no money, no progress tracking.
 * Paths match Blueprint `curriculumPath` (packages/contracts blueprint.ts):
 * foundations | markets | builder | sovereign.
 *
 * ── Thin slice (A-P5-2) ─────────────────────────────────────────────────────
 *
 * This ships the READ surface: list the spine, open one item's body.
 * Progress, certifications, paper-trading workbooks, and XP are NOT here —
 * those need identity.rank and academy.certs.
 *
 * The day-one spine below is PLATFORM-NATIVE seed content so the API is real
 * rather than empty. The full proprietary DERIV//DESK library import
 * (20 playbooks + 3 workbooks named by the tracker) is residual: that library
 * is not in this monorepo. Do not invent those titles as if the import landed.
 *
 * User-facing copy uses platform brand vocabulary only (Doctrine §0.7).
 *
 * ── Where the content lives ─────────────────────────────────────────────────
 *
 * The instructional material is `content.ts` — all of it, for every slug. This
 * file stays the registry: slugs, paths, ordering and the query surface, and no
 * prose at all. The split happened when the spine met the tracker's count
 * promise (20 playbooks + 3 workbooks) while nineteen of those items carried a
 * three-bullet stub of ~250 characters and the other six ran 427–634 — the count
 * gate could not see the difference, and a reviewer could not read a registry
 * and a library in one file.
 *
 * A row here declares metadata and nothing else. Bodies and teaching scaffolding
 * are looked up by slug and both lookups throw, so an entry that has no lesson
 * behind it fails at module load rather than serving an empty screen.
 */

import { AcademyError } from '../errors.js';
import { assertNoReservedSlugs } from './reserved-slugs.js';
import { CURRICULUM_BODIES, CURRICULUM_TEACHING, readingMinutes } from './content.js';
import type { CurriculumKeyTerm, CurriculumTeaching } from './content.js';

export type { CurriculumKeyTerm, CurriculumTeaching } from './content.js';

export type CurriculumPath = 'foundations' | 'markets' | 'builder' | 'sovereign';
export type CurriculumKind = 'playbook' | 'workbook' | 'lesson';

export interface CurriculumItemSummary {
  slug: string;
  title: string;
  kind: CurriculumKind;
  path: CurriculumPath;
  /** Stable sort order within a path (ascending). */
  order: number;
  summary: string;
  /** Editorial reading estimate derived from the body — see `readingMinutes` in content.ts. */
  estimatedMinutes: number;
}

export interface CurriculumItem extends CurriculumItemSummary, CurriculumTeaching {
  /** Markdown body. Every item carries real instructional content — see content.ts. */
  body: string;
}

/**
 * What a spine row declares by hand. Teaching scaffolding and the reading
 * estimate are derived, so neither can drift away from the body it describes.
 */
type CurriculumSeed = Omit<CurriculumItem, keyof CurriculumTeaching | 'estimatedMinutes'>;

/** Deep body lookup. A missing slug is a build-time bug, never an empty screen. */
function deepBody(slug: string): string {
  const body = CURRICULUM_BODIES[slug];
  if (!body) throw new Error(`curriculum: no body in content.ts for "${slug}"`);
  return body;
}

/**
 * Teaching scaffolding lookup. A catalog entry cannot ship without objectives,
 * key terms and self-check questions — this throws rather than serve an item
 * that looks complete and teaches nothing.
 */
function teachingFor(slug: string): CurriculumTeaching {
  const teaching = CURRICULUM_TEACHING[slug];
  if (!teaching) throw new Error(`curriculum: no teaching structure in content.ts for "${slug}"`);
  return teaching;
}

/**
 * Day-one spine + platform-native expansion (TRK-academy.curriculum).
 * Title counts (20 playbooks + 3 workbooks) are met via platform-native content.
 * Licensed third-party library import remains residual until product assets land.
 * Stage-3 polish: deep-links + i18n fallback — see deep-links.ts / i18n-strategy.ts.
 */
const SPINE_SEED: readonly CurriculumSeed[] = [
  {
    slug: 'foundations-risk-first',
    title: 'Risk first',
    kind: 'playbook',
    path: 'foundations',
    order: 10,
    summary: 'Position size, drawdown, and why capital preservation is the first skill.',
    body: deepBody('foundations-risk-first'),
  },
  {
    slug: 'foundations-order-types',
    title: 'Order types you will actually use',
    kind: 'lesson',
    path: 'foundations',
    order: 40,
    summary: 'Market, limit, and stop — plain language, no vendor names.',
    body: deepBody('foundations-order-types'),
  },
  {
    slug: 'markets-reading-the-book',
    title: 'Reading the book',
    kind: 'playbook',
    path: 'markets',
    order: 10,
    summary: 'Depth, spreads, and when a quote is not a promise.',
    body: deepBody('markets-reading-the-book'),
  },
  {
    slug: 'builder-first-automation',
    title: 'First automation, no live capital',
    kind: 'playbook',
    path: 'builder',
    order: 10,
    summary: 'Agent guardrails and paper runs before any live rail.',
    body: deepBody('builder-first-automation'),
  },
  {
    slug: 'sovereign-self-custody-posture',
    title: 'Self-custody posture',
    kind: 'lesson',
    path: 'sovereign',
    order: 10,
    summary: 'What you hold, what the platform holds, and how to check which is which.',
    body: deepBody('sovereign-self-custody-posture'),
  },
  {
    slug: 'foundations-paper-workbook',
    title: 'Paper practice drills',
    kind: 'workbook',
    path: 'foundations',
    order: 70,
    summary: 'Drills for sizing, cancelling and honouring an exit — paper only, nothing moves value.',
    body: deepBody('foundations-paper-workbook'),
  },
  // ── Stage-2 platform-native expansion (not licensed library invent) ───────
  {
    slug: 'foundations-position-sizing',
    title: 'Position sizing without inventing numbers',
    kind: 'playbook',
    path: 'foundations',
    order: 30,
    summary: 'Size from invalidation distance and account risk — never from a green candle.',
    body: deepBody('foundations-position-sizing'),
  },
  {
    slug: 'foundations-journal-discipline',
    title: 'Trade journal discipline',
    kind: 'playbook',
    path: 'foundations',
    order: 60,
    summary: 'What you write before and after a trade so the next one is not amnesia.',
    body: deepBody('foundations-journal-discipline'),
  },
  {
    slug: 'markets-spread-and-slippage',
    title: 'Spread and slippage honesty',
    kind: 'playbook',
    path: 'markets',
    order: 30,
    summary: 'When the book is thin, the fill is not the mid you stared at.',
    body: deepBody('markets-spread-and-slippage'),
  },
  {
    slug: 'markets-session-structure',
    title: 'Session structure',
    kind: 'playbook',
    path: 'markets',
    order: 40,
    summary: 'Open, mid, and close behaviours without inventing a regime label.',
    body: deepBody('markets-session-structure'),
  },
  {
    slug: 'builder-kill-switch-drill',
    title: 'Kill-switch drill',
    kind: 'playbook',
    path: 'builder',
    order: 30,
    summary: 'Prove you can stop a run from a surface you control.',
    body: deepBody('builder-kill-switch-drill'),
  },
  {
    slug: 'builder-logs-not-vibes',
    title: 'Logs not vibes',
    kind: 'playbook',
    path: 'builder',
    order: 50,
    summary: 'What an automation must record so a human can audit it later.',
    body: deepBody('builder-logs-not-vibes'),
  },
  {
    slug: 'sovereign-rail-map',
    title: 'Rail map',
    kind: 'playbook',
    path: 'sovereign',
    order: 30,
    summary: 'Custodial ledger vs self-custody rails — ask who holds the keys.',
    body: deepBody('sovereign-rail-map'),
  },
  {
    slug: 'sovereign-withdrawal-hygiene',
    title: 'Withdrawal hygiene',
    kind: 'playbook',
    path: 'sovereign',
    order: 50,
    summary: 'Address check, small test send, no urgency theatre.',
    body: deepBody('sovereign-withdrawal-hygiene'),
  },
  {
    slug: 'markets-tape-reading-workbook',
    title: 'Tape reading workbook',
    kind: 'workbook',
    path: 'markets',
    order: 60,
    summary: 'Drills for reading public prints without inventing volume or an aggressor side.',
    body: deepBody('markets-tape-reading-workbook'),
  },
  {
    slug: 'builder-automation-workbook',
    title: 'Automation checklist workbook',
    kind: 'workbook',
    path: 'builder',
    order: 60,
    summary: 'Drills that must each produce a written artifact before an automation is armed.',
    body: deepBody('builder-automation-workbook'),
  },
  // ── Stage-2 L3 platform-native expansion toward title promise (not licensed invent) ──
  {
    slug: 'foundations-invalidation-first',
    title: 'Invalidation before entry',
    kind: 'playbook',
    path: 'foundations',
    order: 20,
    summary: 'Name the level that proves you wrong before you name the target.',
    body: deepBody('foundations-invalidation-first'),
  },
  {
    slug: 'foundations-fees-are-real',
    title: 'Fees are real cost',
    kind: 'playbook',
    path: 'foundations',
    order: 50,
    summary: 'Fee drag is not optional flavour — it is part of the edge math.',
    body: deepBody('foundations-fees-are-real'),
  },
  {
    slug: 'markets-order-types-honest',
    title: 'Order types without magic',
    kind: 'playbook',
    path: 'markets',
    order: 20,
    summary: 'Limit, market, and cancel behaviour without inventing fills.',
    body: deepBody('markets-order-types-honest'),
  },
  {
    slug: 'markets-correlation-caution',
    title: 'Correlation caution',
    kind: 'playbook',
    path: 'markets',
    order: 50,
    summary: 'Two books can move together without becoming one idea.',
    body: deepBody('markets-correlation-caution'),
  },
  {
    slug: 'builder-preflight-checklist',
    title: 'Automation preflight',
    kind: 'playbook',
    path: 'builder',
    order: 20,
    summary: 'What must be true before a paper automation is armed.',
    body: deepBody('builder-preflight-checklist'),
  },
  {
    slug: 'builder-failure-modes',
    title: 'Failure modes of agents',
    kind: 'playbook',
    path: 'builder',
    order: 40,
    summary: 'How an agent fails closed when tools or data are dark.',
    body: deepBody('builder-failure-modes'),
  },
  {
    slug: 'sovereign-custody-posture',
    title: 'Custody posture in one page',
    kind: 'playbook',
    path: 'sovereign',
    order: 20,
    summary: 'What the platform holds vs what never leaves your control surface.',
    body: deepBody('sovereign-custody-posture'),
  },
  {
    slug: 'sovereign-limits-and-tiers',
    title: 'Limits and verification tiers',
    kind: 'playbook',
    path: 'sovereign',
    order: 40,
    summary: 'Why a limit refuses — and why inventing a bypass is forbidden.',
    body: deepBody('sovereign-limits-and-tiers'),
  },
  {
    slug: 'sovereign-incident-hygiene',
    title: 'Incident hygiene for operators',
    kind: 'playbook',
    path: 'sovereign',
    order: 60,
    summary: 'What to freeze, what to write, and what never to invent under load.',
    body: deepBody('sovereign-incident-hygiene'),
  },
] as const;

/**
 * The spine as served: every seed row joined to its teaching scaffolding, with
 * the reading estimate derived from the body. `teachingFor` throws on a slug
 * that has no scaffolding, so an item that teaches nothing cannot reach a
 * caller — it fails at module load, where a human sees it.
 */
const SPINE: readonly CurriculumItem[] = SPINE_SEED.map((seed) => ({
  ...seed,
  ...teachingFor(seed.slug),
  estimatedMinutes: readingMinutes(seed.body),
}));

// AC-articles-02: a shipped slug equal to a reserved tab slug stops the service at load, naming the slug.
assertNoReservedSlugs(SPINE.map((item) => item.slug));

const BY_SLUG = new Map(SPINE.map((item) => [item.slug, item]));

export function listCurriculum(filter: { path?: CurriculumPath; kind?: CurriculumKind } = {}): CurriculumItemSummary[] {
  return SPINE.filter((item) => (filter.path ? item.path === filter.path : true) && (filter.kind ? item.kind === filter.kind : true))
    .slice()
    .sort((a, b) => (a.path === b.path ? a.order - b.order : a.path.localeCompare(b.path)))
    .map(({ body: _body, objectives: _objectives, keyTerms: _keyTerms, selfCheck: _selfCheck, ...summary }) => summary);
}

export function getCurriculumItem(slug: string): CurriculumItem | null {
  return BY_SLUG.get(slug) ?? null;
}

/** Stable set of paths the catalog recognises — matches Blueprint curriculumPath. */
export const CURRICULUM_PATHS: readonly CurriculumPath[] = ['foundations', 'markets', 'builder', 'sovereign'];

/**
 * L3 — inventory of seeded spine only. Never invents DERIV//DESK residual titles.
 * Empty path → zero counts (honest emptiness, not a fabricated library).
 */
export type CurriculumInventory = {
  readonly total: number;
  readonly byPath: Readonly<Record<CurriculumPath, number>>;
  readonly byKind: Readonly<Record<CurriculumKind, number>>;
};

export function inventoryCurriculum(): CurriculumInventory {
  const byPath: Record<CurriculumPath, number> = {
    foundations: 0,
    markets: 0,
    builder: 0,
    sovereign: 0,
  };
  const byKind: Record<CurriculumKind, number> = {
    playbook: 0,
    workbook: 0,
    lesson: 0,
  };
  for (const item of SPINE) {
    byPath[item.path] += 1;
    byKind[item.kind] += 1;
  }
  return { total: SPINE.length, byPath, byKind };
}

/**
 * L3 — slug existence on spine only. Unknown → false (never invent residual titles).
 */
export function hasCurriculumSlug(slug: string): boolean {
  return BY_SLUG.has(slug.trim());
}

/**
 * L3 — sorted spine slugs only. Never invents residual library titles.
 */
export function listCurriculumSlugs(): readonly string[] {
  return [...BY_SLUG.keys()].sort();
}

/**
 * L3 — count items on one path. Unknown path key still returns 0 via filter.
 */
export function countCurriculumByPath(path: CurriculumPath): number {
  return SPINE.filter((item) => item.path === path).length;
}

/**
 * L3 — count items by kind on spine only. Never invent residual titles.
 */
export function countCurriculumByKind(kind: CurriculumKind): number {
  return SPINE.filter((item) => item.kind === kind).length;
}

/**
 * L3 — true when slug exists and is a workbook. Unknown/non-workbook → false.
 */
export function isWorkbookSlug(slug: string): boolean {
  const item = BY_SLUG.get(slug.trim());
  return item?.kind === 'workbook';
}

/**
 * L3 — true when slug exists and is a playbook. Unknown/non-playbook → false.
 */
export function isPlaybookSlug(slug: string): boolean {
  const item = BY_SLUG.get(slug.trim());
  return item?.kind === 'playbook';
}

/**
 * L3 — true when slug exists and is a lesson. Unknown/non-lesson → false.
 */
export function isLessonSlug(slug: string): boolean {
  const item = BY_SLUG.get(slug.trim());
  return item?.kind === 'lesson';
}

/**
 * L3 — sorted slugs for one kind. Empty kind → [].
 */
export function listCurriculumSlugsByKind(kind: CurriculumKind): readonly string[] {
  return SPINE.filter((item) => item.kind === kind)
    .map((item) => item.slug)
    .sort();
}

/**
 * L3 — paths that have at least one spine item (sorted). Empty catalog → [].
 */
export function listPathsWithContent(): readonly CurriculumPath[] {
  const set = new Set<CurriculumPath>();
  for (const item of SPINE) set.add(item.path);
  return CURRICULUM_PATHS.filter((p) => set.has(p));
}

/**
 * L3 — Blueprint paths with zero spine items (sorted). Full coverage → [].
 */
export function listEmptyCurriculumPaths(): readonly CurriculumPath[] {
  const inv = inventoryCurriculum();
  return CURRICULUM_PATHS.filter((p) => inv.byPath[p] === 0);
}

/**
 * L3 — kinds present on spine (sorted fixed order playbook/workbook/lesson).
 */
export function listKindsWithContent(): readonly CurriculumKind[] {
  const order: CurriculumKind[] = ['playbook', 'workbook', 'lesson'];
  const inv = inventoryCurriculum();
  return order.filter((k) => inv.byKind[k] > 0);
}

/**
 * L3 — total spine items. Seed spine never empty on tip; still pure.
 */
export function curriculumSpineSize(): number {
  return SPINE.length;
}

/**
 * L3 — sorted titles for one path. Empty path → [].
 */
export function listCurriculumTitlesByPath(path: CurriculumPath): readonly string[] {
  return SPINE.filter((item) => item.path === path)
    .map((item) => item.title)
    .sort();
}

/** L3 — alias of hasCurriculumSlug (spine existence only). */
export function isSpineSlug(slug: string): boolean {
  return hasCurriculumSlug(slug);
}

/**
 * L3 — true when path has at least one spine item. Empty path → false.
 */
export function hasCurriculumPath(path: CurriculumPath): boolean {
  return countCurriculumByPath(path) > 0;
}

/** L3 — total spine items (same as inventory total). */
export function spineItemCount(): number {
  return inventoryCurriculum().total;
}

/**
 * L3 — sorted lesson slugs on spine only. None → [].
 */
export function listLessonSlugs(): readonly string[] {
  return listCurriculumSlugsByKind('lesson');
}

/**
 * L3 — playbook count on spine.
 */
export function playbookCount(): number {
  return countCurriculumByKind('playbook');
}

/** L3 — spine workbook count. */
export function workbookCount(): number {
  return inventoryCurriculum().byKind.workbook;
}

/** L3 — spine lesson count. */
export function lessonCount(): number {
  return inventoryCurriculum().byKind.lesson;
}

/** L3 — how many Blueprint paths have ≥1 spine item. */
export function pathCountWithContent(): number {
  return listPathsWithContent().length;
}

/**
 * L3 — sorted playbook slugs on spine. None → [].
 */
export function listPlaybookSlugs(): readonly string[] {
  return listCurriculumSlugsByKind('playbook');
}

/**
 * L3 — sorted workbook slugs on spine. None → [].
 */
export function listWorkbookSlugs(): readonly string[] {
  return listCurriculumSlugsByKind('workbook');
}

/** L3 — how many curriculum kinds have ≥1 spine item. */
export function kindCountWithContent(): number {
  return listKindsWithContent().length;
}

/** L3 — how many Blueprint paths have zero spine items. */
export function emptyPathCount(): number {
  return listEmptyCurriculumPaths().length;
}

/**
 * L3 — sorted titles for one kind. None → [].
 */
export function listCurriculumTitlesByKind(kind: CurriculumKind): readonly string[] {
  return SPINE.filter((item) => item.kind === kind)
    .map((item) => item.title)
    .sort();
}

/** L3 — true when spine has at least one playbook. */
export function hasPlaybook(): boolean {
  return playbookCount() > 0;
}

/** L3 — true when spine has at least one workbook. */
export function hasWorkbook(): boolean {
  return workbookCount() > 0;
}

/** L3 — true when spine has at least one lesson. */
export function hasLesson(): boolean {
  return lessonCount() > 0;
}

/** L3 — true when spine is non-empty. */
export function catalogSpineNonEmpty(): boolean {
  return curriculumSpineSize() > 0;
}

/** L3 — foundations path item count. */
export function foundationsItemCount(): number {
  return countCurriculumByPath('foundations');
}

/** L3 — markets path item count. */
export function marketsItemCount(): number {
  return countCurriculumByPath('markets');
}

/** L3 — builder path item count. */
export function builderItemCount(): number {
  return countCurriculumByPath('builder');
}

/** L3 — sovereign path item count. */
export function sovereignItemCount(): number {
  return countCurriculumByPath('sovereign');
}

/** L3 — true when foundations path has content. */
export function hasFoundationsPath(): boolean {
  return hasCurriculumPath('foundations');
}

/** L3 — true when markets path has content. */
export function hasMarketsPath(): boolean {
  return hasCurriculumPath('markets');
}

/** L3 — true when builder path has content. */
export function hasBuilderPath(): boolean {
  return hasCurriculumPath('builder');
}

/** L3 — true when sovereign path has content. */
export function hasSovereignPath(): boolean {
  return hasCurriculumPath('sovereign');
}

/** L3 — empty paths count alias surface. */
export function emptyCurriculumPathCount(): number {
  return emptyPathCount();
}

/** L3 — true when all four Blueprint paths have content. */
export function allPathsHaveContent(): boolean {
  return pathCountWithContent() === CURRICULUM_PATHS.length;
}

/** L3 — first spine slug (sorted). Empty spine → null. */
export function firstCurriculumSlug(): string | null {
  const slugs = listCurriculumSlugs();
  return slugs[0] ?? null;
}

/** L3 — last spine slug (sorted). Empty → null. */
export function lastCurriculumSlug(): string | null {
  const slugs = listCurriculumSlugs();
  return slugs.length ? slugs[slugs.length - 1]! : null;
}

/** L3 — true when spine size is at least n. */
export function hasAtLeastSpineItems(n: number): boolean {
  if (!Number.isFinite(n) || n < 0) return false;
  return curriculumSpineSize() >= Math.floor(n);
}

/** L3 — lesson titles sorted. None → []. */
export function listLessonTitles(): readonly string[] {
  return listCurriculumTitlesByKind('lesson');
}

/** L3 — playbook titles sorted. None → []. */
export function listPlaybookTitles(): readonly string[] {
  return listCurriculumTitlesByKind('playbook');
}

/** L3 — spine size label. */
export function spineSizeLabel(): string {
  return String(curriculumSpineSize());
}

/** L3 — comma-joined lesson slugs. Empty → "". */
export function lessonSlugsJoined(): string {
  return listLessonSlugs().join(',');
}

/** L3 — comma-joined playbook slugs. Empty → "". */
export function playbookSlugsJoined(): string {
  return listPlaybookSlugs().join(',');
}

/** L3 — workbook titles sorted. None → []. */
export function listWorkbookTitles(): readonly string[] {
  return listCurriculumTitlesByKind('workbook');
}

/** L3 — workbook slugs joined. Empty → "". */
export function workbookSlugsJoined(): string {
  return listWorkbookSlugs().join(',');
}

/** L3 — all spine slugs joined. Empty → "". */
export function curriculumSlugsJoined(): string {
  return listCurriculumSlugs().join(',');
}

/** L3 — paths with content joined. Empty → "". */
export function pathsWithContentJoined(): string {
  return listPathsWithContent().join(',');
}

/** L3 — kinds with content joined. Empty → "". */
export function kindsWithContentJoined(): string {
  return listKindsWithContent().join(',');
}

/** L3 — path count with content label. */
export function pathCountWithContentLabel(): string {
  return String(pathCountWithContent());
}

/** L3 — kind count with content label. */
export function kindCountWithContentLabel(): string {
  return String(kindCountWithContent());
}

/** L3 — empty path count label. */
export function emptyPathCountLabel(): string {
  return String(emptyPathCount());
}

/** L3 — first curriculum slug label or empty. */
export function firstCurriculumSlugLabel(): string {
  return firstCurriculumSlug() ?? '';
}

/** L3 — kind count snapshot. */
export function curriculumKindSnapshot(): {
  readonly lesson: number;
  readonly playbook: number;
  readonly workbook: number;
  readonly total: number;
} {
  return {
    lesson: lessonCount(),
    playbook: playbookCount(),
    workbook: workbookCount(),
    total: curriculumSpineSize(),
  };
}

/** L3 — true when kind counts sum to spine size. */
export function curriculumKindCountsConsistent(): boolean {
  const s = curriculumKindSnapshot();
  return s.total === s.lesson + s.playbook + s.workbook;
}

/** L3 — path content snapshot counts. */
export function curriculumPathSnapshot(): {
  readonly foundations: number;
  readonly markets: number;
  readonly builder: number;
  readonly sovereign: number;
} {
  return {
    foundations: foundationsItemCount(),
    markets: marketsItemCount(),
    builder: builderItemCount(),
    sovereign: sovereignItemCount(),
  };
}

/** L3 — true when path counts sum to spine size. */
export function curriculumPathCountsConsistent(): boolean {
  const s = curriculumPathSnapshot();
  return curriculumSpineSize() === s.foundations + s.markets + s.builder + s.sovereign;
}

/** L3 — catalog board headline. */
export function catalogBoardHeadline(): {
  readonly spine: number;
  readonly lessons: number;
  readonly playbooks: number;
  readonly workbooks: number;
  readonly pathsWithContent: number;
  readonly emptyPaths: number;
  readonly nonEmpty: boolean;
} {
  return {
    spine: curriculumSpineSize(),
    lessons: lessonCount(),
    playbooks: playbookCount(),
    workbooks: workbookCount(),
    pathsWithContent: pathCountWithContent(),
    emptyPaths: emptyPathCount(),
    nonEmpty: catalogSpineNonEmpty(),
  };
}

/** L3 — one slug card. Missing → null kind. */
export function curriculumSlugCard(slug: string): {
  readonly slug: string;
  readonly present: boolean;
  readonly kind: CurriculumKind | null;
  readonly isLesson: boolean;
  readonly isPlaybook: boolean;
  readonly isWorkbook: boolean;
} {
  const s = slug.trim();
  const item = getCurriculumItem(s);
  if (!item) {
    return { slug: s, present: false, kind: null, isLesson: false, isPlaybook: false, isWorkbook: false };
  }
  return {
    slug: s,
    present: true,
    kind: item.kind,
    isLesson: item.kind === 'lesson',
    isPlaybook: item.kind === 'playbook',
    isWorkbook: item.kind === 'workbook',
  };
}

/** L3 — path content card. */
export function curriculumPathCard(path: CurriculumPath): {
  readonly path: CurriculumPath;
  readonly count: number;
  readonly hasContent: boolean;
} {
  return {
    path,
    count: countCurriculumByPath(path),
    hasContent: hasCurriculumPath(path),
  };
}

/** L3 — true when slug card is present. */
export function curriculumSlugPresent(slug: string): boolean {
  return curriculumSlugCard(slug).present;
}

/** L3 — search spine slugs by substring. Empty needle → []. */
export function searchCurriculumSlugs(needle: string): readonly string[] {
  const n = needle.trim();
  if (!n) return [];
  return listCurriculumSlugs().filter((s) => s.includes(n));
}

/** L3 — search spine titles by substring. Empty needle → []. */
export function searchCurriculumTitles(needle: string): readonly string[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  return SPINE.filter((item) => item.title.toLowerCase().includes(n))
    .map((item) => item.title)
    .sort();
}

/** L3 — slug cards for one kind. None → []. */
export function listCurriculumSlugCardsByKind(kind: CurriculumKind): readonly {
  readonly slug: string;
  readonly present: boolean;
  readonly kind: CurriculumKind | null;
  readonly isLesson: boolean;
  readonly isPlaybook: boolean;
  readonly isWorkbook: boolean;
}[] {
  return listCurriculumSlugsByKind(kind).map((slug) => curriculumSlugCard(slug));
}

/** L3 — path cards for all Blueprint paths. */
export function listAllCurriculumPathCards(): readonly {
  readonly path: CurriculumPath;
  readonly count: number;
  readonly hasContent: boolean;
}[] {
  return CURRICULUM_PATHS.map((path) => curriculumPathCard(path));
}

/** Owner-published page size. Blank / non-finite / <1 refuses. Never invent all.length. */
export function assertCurriculumPageLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AcademyError('Curriculum list limit is unset — pass limit (never invent all.length)', 'academy.curriculum_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AcademyError('Curriculum list limit is unset — pass limit (never invent all.length)', 'academy.curriculum_list_limit_unset');
  }
  return Math.min(200, n);
}

/** L3 — page spine slugs (sorted). Limit must be published. Empty → []. */
export function pageCurriculumSlugs(options: { offset?: number; limit?: number } = {}): readonly string[] {
  const all = listCurriculumSlugs();
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = assertCurriculumPageLimit(options.limit);
  return all.slice(offset, offset + limit);
}

/** L3 — page lesson slugs. Limit must be published. Empty → []. */
export function pageLessonSlugs(options: { offset?: number; limit?: number } = {}): readonly string[] {
  const all = listLessonSlugs();
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = assertCurriculumPageLimit(options.limit);
  return all.slice(offset, offset + limit);
}

/** L3 — spine page count. */
export function curriculumSpinePageCount(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return 0;
  const n = curriculumSpineSize();
  if (n === 0) return 0;
  return Math.ceil(n / Math.floor(pageSize));
}

/** L3 — reverse sorted spine slugs. Empty → []. */
export function reverseCurriculumSlugs(): readonly string[] {
  return [...listCurriculumSlugs()].reverse();
}

/** L3 — slugs only in kind A vs kind B sets. */
export function curriculumSlugsOnlyInKind(kind: CurriculumKind, excludeKind: CurriculumKind): readonly string[] {
  const exclude = new Set(listCurriculumSlugsByKind(excludeKind));
  return listCurriculumSlugsByKind(kind).filter((s) => !exclude.has(s));
}

/** L3 — path count delta (left path - right path). */
export function curriculumPathCountDelta(left: CurriculumPath, right: CurriculumPath): number {
  return countCurriculumByPath(left) - countCurriculumByPath(right);
}

/** L3 — true when two kinds have same count. */
export function curriculumKindsSameSize(a: CurriculumKind, b: CurriculumKind): boolean {
  return countCurriculumByKind(a) === countCurriculumByKind(b);
}

/** L3 — true when two paths have same count. */
export function curriculumPathsSameSize(a: CurriculumPath, b: CurriculumPath): boolean {
  return countCurriculumByPath(a) === countCurriculumByPath(b);
}

/** L3 — safe page spine slugs with clamped bounds. */
export function safePageCurriculumSlugs(offset: number, limit: number): readonly string[] {
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) return [];
  const all = listCurriculumSlugs();
  const o = Math.max(0, Math.min(all.length, Math.floor(offset)));
  const l = Math.max(0, Math.min(all.length - o, Math.floor(limit)));
  return all.slice(o, o + l);
}

/** L3 — clamp curriculum page index. */
export function clampCurriculumPageIndex(pageIndex: number, pageSize: number): number {
  const pages = curriculumSpinePageCount(pageSize);
  if (pages === 0) return 0;
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.max(0, Math.min(pages - 1, Math.floor(pageIndex)));
}

/** L3 — spine slugs at clamped page. */
export function curriculumSlugsAtPage(pageIndex: number, pageSize: number): readonly string[] {
  if (!Number.isFinite(pageSize) || pageSize < 1) return [];
  const idx = clampCurriculumPageIndex(pageIndex, pageSize);
  const size = Math.floor(pageSize);
  return safePageCurriculumSlugs(idx * size, size);
}

/** L3 — true when curriculum page is valid. */
export function isValidCurriculumPage(pageIndex: number, pageSize: number): boolean {
  const pages = curriculumSpinePageCount(pageSize);
  if (pages === 0) return false;
  if (!Number.isFinite(pageIndex)) return false;
  const i = Math.floor(pageIndex);
  return i >= 0 && i < pages;
}

/** L3 — export lines: slug,kind,path. Empty → []. */
export function curriculumExportLines(): readonly string[] {
  return listCurriculumSlugs().map((slug) => {
    const item = getCurriculumItem(slug)!;
    return `${item.slug},${item.kind},${item.path}`;
  });
}

/** L3 — curriculum export header. */
export function curriculumExportHeader(): string {
  return 'slug,kind,path';
}

/** L3 — full curriculum export text. */
export function curriculumExportText(): string {
  return [curriculumExportHeader(), ...curriculumExportLines()].join('\n');
}

/** L3 — export line count including header. */
export function curriculumExportLineCount(): number {
  return 1 + curriculumSpineSize();
}

/**
 * L3 — parse "slug,kind,path". Invalid → null.
 */
export function parseCurriculumExportLine(
  line: string,
): { readonly slug: string; readonly kind: CurriculumKind; readonly path: CurriculumPath } | null {
  const t = line.trim();
  if (!t || t === curriculumExportHeader()) return null;
  const parts = t.split(',');
  if (parts.length !== 3) return null;
  const slug = parts[0]!.trim();
  const kind = parts[1]!.trim();
  const path = parts[2]!.trim();
  if (!slug) return null;
  if (kind !== 'lesson' && kind !== 'playbook' && kind !== 'workbook') return null;
  if (path !== 'foundations' && path !== 'markets' && path !== 'builder' && path !== 'sovereign') return null;
  return { slug, kind, path };
}

/** L3 — count valid curriculum export data lines. */
export function countCurriculumExportDataLines(text: string): number {
  return text
    .split('\n')
    .map((l) => parseCurriculumExportLine(l))
    .filter((r) => r !== null).length;
}

/** L3 — true when curriculum export has header. */
export function curriculumExportHasHeader(text: string): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === curriculumExportHeader();
}

/** L3 — round-trip curriculum export line count. */
export function curriculumExportRoundTripOk(): boolean {
  return curriculumExportLineCount() === 1 + countCurriculumExportDataLines(curriculumExportText());
}

/** L3 — one-line catalog status. */
export function catalogStatusLine(): string {
  const h = catalogBoardHeadline();
  return `spine=${h.spine} lessons=${h.lessons} playbooks=${h.playbooks} workbooks=${h.workbooks}`;
}

/** L3 — true when catalog status shows empty spine. */
export function catalogStatusLineIsEmpty(): boolean {
  return catalogStatusLine().startsWith('spine=0');
}

/** L3 — detailed catalog status with paths. */
export function catalogStatusLineDetailed(): string {
  const h = catalogBoardHeadline();
  return `${catalogStatusLine()} paths=${h.pathsWithContent} emptyPaths=${h.emptyPaths}`;
}

/** L3 — token count on detailed catalog status. */
export function catalogStatusLineTokenCount(): number {
  return catalogStatusLineDetailed().split(/\s+/).filter(Boolean).length;
}

/** L3 — parse catalog status line. Invalid → null. */
export function parseCatalogStatusLine(line: string): {
  readonly spine: number;
  readonly lessons: number;
  readonly playbooks: number;
  readonly workbooks: number;
} | null {
  const m = line.trim().match(/^spine=(\d+) lessons=(\d+) playbooks=(\d+) workbooks=(\d+)$/);
  if (!m) return null;
  return { spine: Number(m[1]), lessons: Number(m[2]), playbooks: Number(m[3]), workbooks: Number(m[4]) };
}

/** L3 — true when status line matches live catalog. */
export function catalogStatusLineMatches(): boolean {
  const p = parseCatalogStatusLine(catalogStatusLine());
  if (!p) return false;
  return (
    p.spine === curriculumSpineSize() && p.lessons === lessonCount() && p.playbooks === playbookCount() && p.workbooks === workbookCount()
  );
}

/** L3 — parse detailed catalog status. Invalid → null. */
export function parseCatalogStatusLineDetailed(line: string): {
  readonly spine: number;
  readonly lessons: number;
  readonly playbooks: number;
  readonly workbooks: number;
  readonly paths: number;
  readonly emptyPaths: number;
} | null {
  const m = line.trim().match(/^spine=(\d+) lessons=(\d+) playbooks=(\d+) workbooks=(\d+) paths=(\d+) emptyPaths=(\d+)$/);
  if (!m) return null;
  return {
    spine: Number(m[1]),
    lessons: Number(m[2]),
    playbooks: Number(m[3]),
    workbooks: Number(m[4]),
    paths: Number(m[5]),
    emptyPaths: Number(m[6]),
  };
}

/** L3 — true when kinds sum to spine. */
export function catalogStatusLineConsistent(line: string): boolean {
  const p = parseCatalogStatusLine(line);
  if (!p) return false;
  return p.spine === p.lessons + p.playbooks + p.workbooks;
}

/** L3 — true when spine size is within [min,max]. Invalid → false. */
export function spineSizeInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = curriculumSpineSize();
  return n >= min && n <= max;
}

/** L3 — true when lesson count is at least n. */
export function lessonCountAtLeast(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return lessonCount() >= n;
}

/** L3 — clamp curriculum page size into [1, spine] (empty → 1). */
export function clampCurriculumPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1;
  const total = Math.max(1, curriculumSpineSize());
  return Math.max(1, Math.min(total, Math.floor(pageSize)));
}

/** L3 — true when empty path count is at most n. */
export function emptyPathCountAtMost(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return emptyPathCount() <= n;
}

// ── Depth surface (TRK-academy.curriculum) ──────────────────────────────────
//
// The count gate in import-pipeline.ts answers "are there 20 playbooks and 3
// workbooks". Depth answers "is any of it worth reading" against
// CURRICULUM_MIN_BODY_CHARS (900). Import validation uses the same floor so a
// thin body cannot re-enter. Both surfaces name thinSlugs rather than asserting
// that none fall short.

/**
 * The body length below which an item is reported thin.
 *
 * An editorial floor, not a quality measurement: a body under this is too short
 * to carry mechanics, an example and the mistakes, so it is worth a reviewer's
 * attention. Passing it proves nothing on its own.
 */
export const CURRICULUM_MIN_BODY_CHARS = 900;

/**
 * What a reader needs around the body: what they should be able to do, the
 * vocabulary assumed, and the questions that reveal whether they got it.
 *
 * Nothing here is graded — grading and XP belong to `academy.certs`. This is
 * the structure a screen lays out, so `/academy` can be a page rather than one
 * undifferentiated wall of markdown.
 */
export interface CurriculumStudyGuide {
  readonly slug: string;
  readonly title: string;
  readonly kind: CurriculumKind;
  readonly path: CurriculumPath;
  readonly estimatedMinutes: number;
  readonly objectives: readonly string[];
  readonly keyTerms: readonly CurriculumKeyTerm[];
  readonly selfCheck: readonly string[];
  /** Characters of markdown behind the guide — lets a caller show depth honestly. */
  readonly bodyChars: number;
}

/** Study guide for one slug. Unknown slug → null; we never invent a guide. */
export function curriculumStudyGuide(slug: string): CurriculumStudyGuide | null {
  const item = BY_SLUG.get(slug.trim());
  if (!item) return null;
  return {
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    path: item.path,
    estimatedMinutes: item.estimatedMinutes,
    objectives: item.objectives,
    keyTerms: item.keyTerms,
    selfCheck: item.selfCheck,
    bodyChars: item.body.length,
  };
}

/** Study guides for every item on a path, in the path's display order. */
export function listCurriculumStudyGuides(path?: CurriculumPath): readonly CurriculumStudyGuide[] {
  return listCurriculum(path ? { path } : {})
    .map((summary) => curriculumStudyGuide(summary.slug))
    .filter((guide): guide is CurriculumStudyGuide => guide !== null);
}

export interface CurriculumDepthReport {
  readonly total: number;
  /** Items whose body clears CURRICULUM_MIN_BODY_CHARS. */
  readonly deep: number;
  /** Items below the floor — named, not hidden. */
  readonly thin: number;
  readonly thinSlugs: readonly string[];
  readonly minBodyChars: number;
  /** Shortest body on the spine, so the floor can be checked against reality. */
  readonly shortestBodyChars: number;
  readonly totalBodyChars: number;
  /** True only when no item is below the floor. */
  readonly allDeep: boolean;
}

/**
 * Honest depth inventory. Reports what is thin instead of asserting that
 * nothing is — the same reason `curriculumInventory` reports residual counts.
 */
export function curriculumDepthReport(): CurriculumDepthReport {
  const thinSlugs = SPINE.filter((item) => item.body.length < CURRICULUM_MIN_BODY_CHARS)
    .map((item) => item.slug)
    .sort();
  const lengths = SPINE.map((item) => item.body.length);
  return {
    total: SPINE.length,
    deep: SPINE.length - thinSlugs.length,
    thin: thinSlugs.length,
    thinSlugs,
    minBodyChars: CURRICULUM_MIN_BODY_CHARS,
    shortestBodyChars: lengths.length ? Math.min(...lengths) : 0,
    totalBodyChars: lengths.reduce((sum, n) => sum + n, 0),
    allDeep: thinSlugs.length === 0,
  };
}

/** One-line depth status for operators. */
export function curriculumDepthLine(): string {
  const d = curriculumDepthReport();
  return `total=${d.total} deep=${d.deep} thin=${d.thin} floor=${d.minBodyChars} shortest=${d.shortestBodyChars}`;
}
