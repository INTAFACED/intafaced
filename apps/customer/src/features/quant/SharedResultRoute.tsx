import { SharedResult } from './ReportShare';

/** The token in a share link's path (`/quant/share/<token>`, AL-report-03), or null for any other path. */
export function shareToken(path: string): string | null {
  const segment = /^\/quant\/share\/([^/]+)$/.exec(path)?.[1];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    // A link copied with a broken escape is sent as it is, and reads not found.
    return segment;
  }
}

/** What a share link opens, signed in or not: a public page, so a signed-out reader never meets a sign-in wall. */
export default function SharedResultRoute({ path }: { path: string }) {
  const token = shareToken(path);
  return token ? <SharedResult key={token} token={token} /> : null;
}
