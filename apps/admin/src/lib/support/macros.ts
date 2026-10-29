import type { SupportMacro } from './types';

/** Strict reader for svc-support's `macrosList`. Anything else is unreadable, never an empty library. */
export function readMacroList(raw: unknown): { macros: SupportMacro[]; shortcodeMin: number | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { macros?: unknown; shortcodeMin?: unknown };
  if (!Array.isArray(r.macros) || !(r.shortcodeMin === null || Number.isInteger(r.shortcodeMin))) return null;
  const macros: SupportMacro[] = [];
  for (const m of r.macros) {
    if (!m || typeof m !== 'object') return null;
    const x = m as Record<string, unknown>;
    if (
      typeof x.id !== 'string' ||
      typeof x.ownerId !== 'string' ||
      typeof x.shared !== 'boolean' ||
      typeof x.title !== 'string' ||
      typeof x.shortcode !== 'string' ||
      typeof x.body !== 'string' ||
      typeof x.updatedAt !== 'string' ||
      !Array.isArray(x.placeholders) ||
      !x.placeholders.every((p) => typeof p === 'string')
    )
      return null;
    macros.push({
      id: x.id,
      ownerId: x.ownerId,
      shared: x.shared,
      title: x.title,
      shortcode: x.shortcode,
      body: x.body,
      placeholders: x.placeholders as string[],
      updatedAt: x.updatedAt,
    });
  }
  return { macros, shortcodeMin: r.shortcodeMin as number | null };
}
