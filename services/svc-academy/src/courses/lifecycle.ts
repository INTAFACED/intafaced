/**
 * AC-course-structure-01 — course lifecycle rules (pure).
 *
 * draft → published → concluded → archived; any live state → deleted;
 * deleted → undelete back to the state it had, inside the owner's undelete
 * window. Anything else refuses `academy.item_transition_illegal`.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';

export type CourseState = 'draft' | 'published' | 'concluded' | 'archived' | 'deleted';
export type LifecycleMove = 'publish' | 'conclude' | 'archive' | 'delete' | 'undelete';
export type PriceChoice = 'free' | 'paid';

/** IA-SPEC 2.9 tab slugs: never a course slug. */
export const RESERVED_SLUGS: readonly string[] = ['learning', 'certificates', 'rooms', 'videos', 'programmes', 'progress'];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertCourseSlug(slug: string): void {
  if (RESERVED_SLUGS.includes(slug)) {
    throw new AcademyError(`slug "${slug}" is a reserved academy tab`, 'academy.slug_reserved');
  }
  if (!SLUG.test(slug) || slug.length > 96) {
    throw new AcademyError('slug must be lowercase words joined by hyphens', 'academy.course_invalid');
  }
}

/** Parses an optional price into scaled bigint. Free never carries a price; zero or negative refuses. */
export function parseCoursePrice(choice: PriceChoice, price: string | null | undefined): Amount | null {
  if (price === null || price === undefined || price.trim() === '') return null;
  if (choice === 'free') throw new AcademyError('a free course carries no price', 'academy.course_invalid');
  let amount: Amount;
  try {
    amount = parseAmount(price);
  } catch {
    throw new AcademyError('price must be a decimal string', 'academy.course_invalid');
  }
  if (amount <= 0n) throw new AcademyError('price must be above zero', 'academy.course_invalid');
  return amount;
}

const NEXT: Readonly<Record<Exclude<LifecycleMove, 'delete' | 'undelete'>, { from: CourseState; to: CourseState }>> = {
  publish: { from: 'draft', to: 'published' },
  conclude: { from: 'published', to: 'concluded' },
  archive: { from: 'concluded', to: 'archived' },
};

export interface CourseSnapshot {
  readonly state: CourseState;
  readonly stateBeforeDelete: CourseState | null;
  readonly priceChoice: PriceChoice;
  readonly price: Amount | null;
  readonly deletedAt: Date | null;
}

export interface MoveContext {
  /** Owner undelete window in seconds; null = not set. Only read for delete/undelete. */
  readonly undeleteWindowSeconds: number | null;
  readonly now: Date;
}

/** Decides a move. Returns the target state, or throws a typed refusal. */
export function decideMove(course: CourseSnapshot, move: LifecycleMove, ctx: MoveContext): CourseState {
  if (move === 'delete' || move === 'undelete') {
    if (ctx.undeleteWindowSeconds === null) {
      throw new AcademyError('undelete window is not set', 'academy.undelete_window_unset');
    }
  }
  if (move === 'delete') {
    if (course.state === 'deleted') throw illegal(course.state, move);
    return 'deleted';
  }
  if (move === 'undelete') {
    if (course.state !== 'deleted' || course.stateBeforeDelete === null || course.deletedAt === null) {
      throw illegal(course.state, move);
    }
    const ageMs = ctx.now.getTime() - course.deletedAt.getTime();
    if (ageMs > (ctx.undeleteWindowSeconds as number) * 1000) throw illegal(course.state, move);
    return course.stateBeforeDelete;
  }
  const step = NEXT[move];
  if (course.state !== step.from) throw illegal(course.state, move);
  if (move === 'publish' && course.priceChoice === 'paid' && course.price === null) {
    throw new AcademyError('a paid course has no price', 'academy.price_unset');
  }
  return step.to;
}

/** Learners keep read access on concluded and archived courses, but cannot submit. */
export function learnerAccess(state: CourseState): 'none' | 'read_write' | 'read_only' {
  if (state === 'published') return 'read_write';
  if (state === 'concluded' || state === 'archived') return 'read_only';
  return 'none';
}

function illegal(state: CourseState, move: LifecycleMove): AcademyError {
  return new AcademyError(`cannot ${move} a ${state} course`, 'academy.item_transition_illegal');
}
