/**
 * Pattern matching for route paths. `:name` captures one segment; a `*` segment matches
 * one segment, and a trailing `*` also accepts any deeper path.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (!pattern.endsWith('*') && expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of expected.entries()) {
    const segment = actual[index];
    if (part === '*') continue;
    if (part.startsWith(':')) {
      if (!segment) return undefined;
      params[part.slice(1)] = segment;
      continue;
    }
    if (part !== segment) return undefined;
  }
  return params;
}

export function hasPattern(path: string): boolean {
  return path.includes(':') || path.includes('*');
}
