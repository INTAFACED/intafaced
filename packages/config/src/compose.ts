/**
 * One docker compose service, sliced out of the compose file's text.
 *
 * A service block is its `  <name>:` line under `services:` and every line after it that is blank or indented deeper
 * than two spaces. It ends at the first other line: the next service, a comment at the services' own indent, or a
 * top-level key such as `volumes:` (any line at column 0). The last service of a file ends at the end of the text.
 *
 * Pure text in, text out: callers read the file themselves. Never hand-write the slice: JavaScript has no `\Z`, so
 * `(?=^  [a-z]|\Z)` waits for a literal capital Z and a last service never ends (garden/use-shared-helper).
 */
export function composeServiceBlock(compose: string, service: string): string {
  const lines = compose.split('\n');
  const header = `  ${service}:`;
  const start = lines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) throw new Error(`${service} service block missing from the compose file`);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === '' || lines[end]!.startsWith('   '))) end += 1;
  // Trailing blank lines belong to the gap between services, not to this one.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end -= 1;
  // A last line with no newline after it in the text gets none here either.
  return lines.slice(start, end).join('\n') + (end < lines.length ? '\n' : '');
}
