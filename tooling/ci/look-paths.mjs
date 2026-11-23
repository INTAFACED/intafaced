/**
 * What a pull request's look gate (look-pr.yml, #9325) runs on: a change to a Customer room or the kit draws, or to the
 * gate itself. Docs there draw nothing. CI's Look job (ci-affected.mjs), the merge seal's CI review rule
 * (review-marker.mjs) and the journeys pick (journey-touch.mjs) read it from here: a file with no imports, so the
 * journeys run's scripts read it without pulling in ci-affected.mjs.
 */
const LOOK_PATHS = ['apps/customer/', 'packages/ui/', 'tooling/ci/look-gate/', '.github/workflows/look-pr.yml'];

const posix = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
const isDoc = (f) => f.split('/')[0] === 'docs' || f.endsWith('.md');
const under = (f, p) => (p.endsWith('/') ? f === p.slice(0, -1) || f.startsWith(p) : f === p || f.startsWith(`${p}/`));

export const reachesLook = (files) => (files || []).map(posix).some((f) => !isDoc(f) && LOOK_PATHS.some((p) => under(f, p)));
