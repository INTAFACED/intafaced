#!/usr/bin/env node
// The room scaffold (Lit glass redesign): a new customer room is born on one of the eight templates.
//
//   pnpm --filter @intafaced/customer room:new -- --path /money/statements --template record-list --area money --name Statements [--dry-run]
//
// The route must already be in navigation.ts `rooms` (its title and description are copy keys, so it is added with
// its copy). The scaffold writes the room's screen on its template (parked until its data is wired: product law, no
// sample numbers) and records the route as migrated in src/app/room-templates.ts, replacing its unmigrated entry, so
// the registry test stays green. Then render the new room at that path in the area's routes file. It refuses an
// unknown route or template, a route already migrated, and an existing file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(APP, 'src');
const CONTRACTS = join(APP, '..', '..', 'packages', 'ui', 'src', 'lit', 'contracts.ts');
const REGISTRY = join(SRC, 'app', 'room-templates.ts');
const NAVIGATION = join(SRC, 'app', 'navigation.ts');

const COMPONENT = {
  overview: ['OverviewTemplate', 'hero={null}'],
  'record-list': ['RecordListTemplate', 'list={null}'],
  monitor: ['MonitorTemplate', 'figures={[]}'],
  flow: ['FlowTemplate', 'step={null}'],
  settings: ['SettingsTemplate', 'sections={null}'],
  catalogue: ['CatalogueTemplate', 'items={null}'],
  desk: ['DeskTemplate', 'instrument={null} chart={null} ticket={null}'],
  reading: ['ReadingTemplate', 'body={null}'],
};

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** The eight template ids, read from the frozen contracts so the scaffold can't drift from them. */
export function templateIds(contracts = readFileSync(CONTRACTS, 'utf8')) {
  const block = contracts.slice(contracts.indexOf('export const templates = {'));
  const body = block.slice(0, block.indexOf('} as const'));
  return [...body.matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]);
}

export function screenSource({ name, template, title }) {
  const [component, slots] = COMPONENT[template];
  return `import { ${component} } from '@intafaced/ui/lit/templates';

/**
 * ${title}: built on the ${template} template (room scaffold). Parked until its data is wired; replace the state
 * and fill the slots from the room's reads. Never sample numbers: an illustrative figure says TEST.
 */
export function ${name}Room() {
  return (
    <${component}
      title={${JSON.stringify(title)}}
      state={{
        kind: 'refused',
        refusal: {
          variant: 'parked',
          title: ${JSON.stringify(`${title} isn’t connected yet`)},
          body: 'This room is built, and its data isn’t wired yet.',
        },
      }}
      ${slots}
    />
  );
}
`;
}

/**
 * The registry with the route recorded as migrated: its existing (unmigrated) entry is replaced in place, or the
 * entry is added before the end of ROUTE_TEMPLATES. A route already migrated throws.
 */
export function registryWith(registry, path, template, file) {
  const start = registry.indexOf('export const ROUTE_TEMPLATES');
  const end = registry.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('ROUTE_TEMPLATES not found in room-templates.ts');
  const entry = `'${path}': { template: '${template}', migrated: { file: '${file}' } },`;
  const lines = registry.slice(start, end).split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(`'${path}':`));
  if (at >= 0) {
    if (lines[at].includes('migrated')) throw new Error(`${path} is already on its template`);
    if (!lines[at].trimEnd().endsWith('},')) throw new Error(`${path}: its entry spans lines; edit it by hand`);
    lines[at] = lines[at].slice(0, lines[at].indexOf("'")) + entry;
    return registry.slice(0, start) + lines.join('\n') + registry.slice(end);
  }
  return registry.slice(0, end) + `\n  ${entry}` + registry.slice(end);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const fail = (m) => {
    console.error(`room:new: ${m}`);
    process.exit(1);
  };
  if (!a.path?.startsWith('/') || !a.template || !a.area || !a.name) {
    fail('needs --path /x/y --template <id> --area <feature area> --name <PascalName>');
  }
  const ids = templateIds();
  if (!ids.includes(a.template)) fail(`unknown template "${a.template}"; one of ${ids.join(', ')}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(a.name)) fail('--name is PascalCase, e.g. Statements');
  if (!/^[a-z][a-z0-9-]*$/.test(a.area)) fail('--area is a feature folder name, e.g. money');
  if (!/^\/[A-Za-z0-9/:_-]*$/.test(a.path)) fail(`${a.path} is not a route path`);
  if (!readFileSync(NAVIGATION, 'utf8').includes(`path: '${a.path}'`)) {
    fail(`${a.path} is not in navigation.ts rooms yet; add it there with its copy keys first`);
  }
  const registry = readFileSync(REGISTRY, 'utf8');
  let next;
  try {
    next = registryWith(registry, a.path, a.template, '__FILE__');
  } catch (e) {
    fail(e.message);
  }

  const file = join(
    SRC,
    'features',
    a.area,
    a.name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()),
    `${a.name}Room.tsx`,
  );
  const rel = relative(SRC, file);
  if (existsSync(file)) fail(`${rel} exists`);
  const title = a.title ?? a.name.replace(/([a-z])([A-Z])/g, '$1 $2');

  if (a.dryRun) {
    console.log(`would write src/${rel} and register ${a.path} as ${a.template}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, screenSource({ name: a.name, template: a.template, title }));
  writeFileSync(REGISTRY, next.replace('__FILE__', rel));
  console.log(`Wrote src/${rel}; recorded ${a.path} on ${a.template} in src/app/room-templates.ts.`);
  console.log(`Now render <${a.name}Room /> at ${a.path} in ${a.area}'s routes file.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
