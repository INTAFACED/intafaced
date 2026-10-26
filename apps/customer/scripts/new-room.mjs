#!/usr/bin/env node
// The room scaffold (Lit glass plan v2, lane B2): a new customer room is born on one of the eight templates.
//
//   pnpm --filter @intafaced/customer room:new -- --path /money/statements --template record-list --area money --name Statements [--dry-run]
//
// It writes the room's screen (rendering its template, parked until its data is wired: product law, no sample
// numbers), registers it as migrated in src/app/room-templates.ts, and prints the navigation entry and route line
// to add, which need the room's copy keys. It refuses a path that already exists or an unknown template.
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
      title="${title}"
      state={{
        kind: 'refused',
        refusal: {
          variant: 'parked',
          title: '${title} isn’t connected yet',
          body: 'This room is built, and its data isn’t wired yet.',
        },
      }}
      ${slots}
    />
  );
}
`;
}

/** The registry with the new room added as migrated, before the end of ROUTE_TEMPLATES. */
export function registryWith(registry, path, template, file) {
  const start = registry.indexOf('export const ROUTE_TEMPLATES');
  const end = registry.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('ROUTE_TEMPLATES not found in room-templates.ts');
  const line = `\n  '${path}': { template: '${template}', migrated: { file: '${file}' } },`;
  return registry.slice(0, end) + line + registry.slice(end);
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
  if (readFileSync(NAVIGATION, 'utf8').includes(`path: '${a.path}'`)) fail(`${a.path} is already a route`);
  const registry = readFileSync(REGISTRY, 'utf8');
  if (registry.includes(`'${a.path}':`)) fail(`${a.path} is already in room-templates.ts`);

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
  writeFileSync(REGISTRY, registryWith(registry, a.path, a.template, rel));
  console.log(`Wrote src/${rel}; registered ${a.path} on ${a.template} in src/app/room-templates.ts.`);
  console.log("Now add the route (it needs the room's copy keys in navigation-copy.ts):");
  console.log(`  navigation.ts rooms: { path: '${a.path}', title: '<key>', description: '<key>', area: '${a.area}' },`);
  console.log(`  ${a.area}'s routes file: render <${a.name}Room /> at ${a.path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
