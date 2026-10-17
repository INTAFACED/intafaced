/**
 * Markets room fixture (TEST). The market actions (halt, reduce-only, post-only, resume, delist) make no edge call:
 * the console refuses them itself with the matching_not_routed blocker, exactly as it will until svc-edge routes to
 * svc-matching. So there is nothing to answer here; this file exists so the room has its place in the preview.
 */
export default function routes(_state) {
  return [];
}
