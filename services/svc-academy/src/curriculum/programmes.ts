/**
 * Programme definitions for the four Blueprint paths.
 *
 * Prerequisites are whatever the owner has written here. None are authored:
 * every programme ships an empty list. A slug that is not itself a programme
 * fails catalog validation at load, and again if a test injects a bad list.
 */

export type ProgrammeSlug = 'foundations' | 'markets' | 'builder' | 'sovereign';

export type ProgrammeDefinition = {
  readonly slug: ProgrammeSlug;
  readonly prerequisites: readonly string[];
};

export const PROGRAMME_SLUGS: readonly ProgrammeSlug[] = ['foundations', 'markets', 'builder', 'sovereign'];

export const PROGRAMME_CATALOG: readonly ProgrammeDefinition[] = [
  { slug: 'foundations', prerequisites: [] },
  { slug: 'markets', prerequisites: [] },
  { slug: 'builder', prerequisites: [] },
  { slug: 'sovereign', prerequisites: [] },
];

export class ProgrammeCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgrammeCatalogError';
  }
}

export function assertProgrammeCatalog(defs: readonly ProgrammeDefinition[]): void {
  const slugs = new Set(defs.map((d) => d.slug));
  if (slugs.size !== defs.length) {
    throw new ProgrammeCatalogError('duplicate programme slug');
  }
  for (const required of PROGRAMME_SLUGS) {
    if (!slugs.has(required)) {
      throw new ProgrammeCatalogError(`programme catalog missing ${required}`);
    }
  }
  for (const def of defs) {
    for (const pre of def.prerequisites) {
      if (!slugs.has(pre as ProgrammeSlug)) {
        throw new ProgrammeCatalogError(`unknown prerequisite slug: ${pre}`);
      }
    }
  }
}

assertProgrammeCatalog(PROGRAMME_CATALOG);

export function programmeBySlug(defs: readonly ProgrammeDefinition[], slug: string): ProgrammeDefinition | undefined {
  return defs.find((d) => d.slug === slug);
}

/** Prerequisite slugs the caller does not hold an active enrolment for. */
export function unmetPrerequisites(def: ProgrammeDefinition, activePathSlugs: ReadonlySet<string>): string[] {
  return def.prerequisites.filter((slug) => !activePathSlugs.has(slug));
}
