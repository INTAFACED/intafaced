// The Volt ratchet: n never falls and no new room starts off the kit. `volt-off-kit.json` lists the rooms
// allowed off the kit; it only shrinks (tooling/design/volt-lists.test.mjs fails a list that gains a room). A stale entry
// (a listed room now on the kit) passes on every PR, into main as anywhere (intafaced issue 9796), so no batch edits the
// list; `node tooling/design/prune-lists.mjs`, in its own PR, drops stale entries. A room on the kit where the change
// forked from main that is off it now fails, listed or not, so a stale entry never lets a room fall back off the kit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, forkPoint, mainRef } from '../../../../tooling/lint/kit-ceilings.mjs';
import {
  APP_SOURCE,
  offKitFindings,
  placeholderOnly,
  prunedOffKit,
  ratchet,
  staleOffKit,
  voltCount,
  type VoltCount,
  type VoltSource,
} from './volt-count';
import allowedOffKit from './volt-off-kit.json';

const count = voltCount();

/** The count over the customer app's source as it stood at `ref`, today's room tables aside. */
function countAt(ref: string): VoltCount {
  const dir = mkdtempSync(join(tmpdir(), 'volt-fork-'));
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', ref, 'apps/customer/src'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    return voltCount({ ...APP_SOURCE, src: join(dir, 'apps/customer/src') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('customer rooms in Volt', () => {
  it('counts every room once', () => {
    const keys = count.rooms.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(count.N).toBe(keys.length);
    console.info(`Customer rooms in Volt: ${count.n} of ${count.N}`);
  });

  it("starts no room off the kit, and lets no room on the kit at main's fork point fall off it", () => {
    const ref = mainRef();
    if (!ref) throw new Error("cannot fetch main: main's count is what a change's is judged against");
    const problems = ratchet(count, allowedOffKit, countAt(forkPoint(ref)));
    expect(
      problems,
      'a room off the kit that volt-off-kit.json does not allow, or that was on the kit on main (build it on its template from the kit)',
    ).toEqual([]);
    const stale = staleOffKit(count, allowedOffKit);
    if (stale.length)
      console.info(`volt-off-kit.json: ${stale.length} stale entries, which pass; node tooling/design/prune-lists.mjs drops them`);
  }, 120_000); // a fetch of main, and a second count over main's copy of the source

  it('counts no room that shows only a placeholder: the three stubs counted on 22 Nov 2026', () => {
    const placeholders = count.rooms.filter((r) => r.state === 'placeholder').map((r) => r.key);
    for (const key of ['/mining/workers/:workerId', '/token/governance/:proposalId', '/chain/validators/:validatorId'])
      expect(placeholders, key).toContain(key);
    console.info(`Rooms on the kit that show only a placeholder: ${placeholders.length} (${placeholders.join(', ')})`);
  });

  it('names every reason a room is out', () => {
    for (const room of count.rooms) {
      expect(room.reason, room.key).not.toBe('');
      if (room.state === 'off-kit') expect(room.findings.length, room.key).toBeGreaterThan(0);
    }
  });
});

describe('the off-kit rule', () => {
  const plant = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'volt-room-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it('passes a room drawn only from the kit', () => {
    const dir = plant({
      'room/Room.tsx': `import { FlowTemplate, Button } from '@intafaced/ui/lit/templates';\nimport { Part } from './Part';\nimport { useThing } from '../hooks';\nexport const Room = () => <FlowTemplate><Part /><Button className="lt-row-link" /></FlowTemplate>;\n`,
      'room/Part.tsx': `import type { X } from '../Other';\nexport const Part = () => <p className={'lt-sr'} />;\n`,
      'hooks.tsx': `export const useThing = () => 1;\n`,
    });
    expect(offKitFindings(join(dir, 'room/Room.tsx'))).toEqual([]);
  });

  it('names each way a planted room draws off the kit', () => {
    const dir = plant({
      'room/Room.tsx': [
        `import { FlowTemplate } from '@intafaced/ui/lit/templates';`,
        `import { Button } from '@intafaced/ui';`,
        `import {`,
        `  Page,`,
        `} from '../shared/ui';`,
        `import { Card } from '../Card';`,
        `import { Inner } from './Inner';`,
        `export const Room = () => <FlowTemplate><Card /><Inner /></FlowTemplate>;`,
      ].join('\n'),
      'room/Inner.tsx': `import './room.css';\nexport const Inner = () => <div style={{ color: 'red' }} className={\`field \${x}\`} />;\n`,
      'room/room.css': '',
      'shared/ui.tsx': `export const Page = () => null;\n`,
      'Card.tsx': `export const Card = () => <div className="card" />;\n`,
    });
    const kinds = offKitFindings(join(dir, 'room/Room.tsx')).map((f) => `${f.kind} ${f.at.split('/').slice(-1)[0]}`);
    expect(kinds.sort()).toEqual(
      [
        'old-kit Room.tsx:2',
        'old-kit Room.tsx:3',
        'outside-component Room.tsx:6',
        'stylesheet Inner.tsx:1',
        'inline-style Inner.tsx:2',
        'own-class Inner.tsx:2',
      ].sort(),
    );
  });

  it('reads data-style as data, and still finds a style= beside it', () => {
    const dir = plant({
      'room/Room.tsx': [
        `import { DeskTemplate } from '@intafaced/ui/lit/templates';`,
        `export const Room = ({ s }) => <DeskTemplate><div data-style={s} /></DeskTemplate>;`,
        `export const Off = () => <div style={{ color: 'red' }} />;`,
      ].join('\n'),
    });
    expect(offKitFindings(join(dir, 'room/Room.tsx')).map((f) => `${f.kind} ${f.at.split('/').slice(-1)[0]}`)).toEqual([
      'inline-style Room.tsx:3',
    ]);
  });

  it('passes a part from outside the folder that is drawn only from the kit, and fails one that is not', () => {
    const dir = plant({
      'room/Room.tsx': [
        `import { DeskTemplate } from '@intafaced/ui/lit/templates';`,
        `import { Clean } from '../parts/Clean';`,
        `import { Dirty } from '../parts/Dirty';`,
        `export const Room = () => <DeskTemplate><Clean /><Dirty /></DeskTemplate>;`,
      ].join('\n'),
      'parts/Clean.tsx': `import { Tag } from '@intafaced/ui/lit';\nimport { Inner } from './Inner';\nexport const Clean = () => <Tag className="lt-chip"><Inner /></Tag>;\n`,
      'parts/Inner.tsx': `import { Room } from '../room/Room';\nexport const Inner = () => <span className="lt-sr" />;\n`,
      'parts/Dirty.tsx': `import { Helper } from './Helper';\nexport const Dirty = () => <Helper />;\n`,
      'parts/Helper.tsx': `export const Helper = () => <div className="flex gap-2" />;\n`,
    });
    const found = offKitFindings(join(dir, 'room/Room.tsx'));
    expect(found.map((f) => `${f.kind} ${f.at.split('/').slice(-1)[0]}`)).toEqual(['outside-component Room.tsx:3']);
    expect(found[0]!.text).toMatch(/^Dirty from \.\.\/parts\/Dirty, which draws off the kit: own-class at .*Helper\.tsx:1$/);
  });
});

describe('a room that shows only a placeholder', () => {
  const plant = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'volt-placeholder-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return join(dir, 'room/Room.tsx');
  };
  const head = `import { MonitorTemplate } from '@intafaced/ui/lit/templates';\nimport { EmptyState } from '@intafaced/ui/lit';\nimport { roomCopy } from './copy';\n`;
  const copy = { 'room/copy.ts': `export const roomCopy = { useCopy: () => ({ t: (k) => k }) };\n` };

  it("names a room whose template state is always empty, or whose only panel is the kit's EmptyState", () => {
    const always = plant({
      ...copy,
      'room/Room.tsx': `${head}export const Room = () => { const { t } = roomCopy.useCopy(); return <MonitorTemplate title={t('a')} state={{ kind: 'empty', title: t('b') }} figures={[]} />; };\n`,
    });
    expect(placeholderOnly(always)).toMatch(/shows only a placeholder/);
    const blocker = plant({
      'room/Room.tsx': `${head}export const Room = ({ ok }) => <MonitorTemplate state={{ kind: 'ready' }} panels={ok ? <EmptyState title="parked" /> : <EmptyState title="not found" />} />;\n`,
    });
    expect(placeholderOnly(blocker)).toMatch(/shows only a placeholder/);
    // Reached inside its folder: the empty state drawn by a part of its own still counts.
    const part = plant({
      'room/Room.tsx': `${head}import { Part } from './Part';\nexport const Room = () => <MonitorTemplate state={{ kind: 'ready' }} panels={<Part />} />;\n`,
      'room/Part.tsx': `import { EmptyState } from '@intafaced/ui/lit';\nexport const Part = () => <EmptyState title="nothing" />;\n`,
    });
    expect(placeholderOnly(part)).toMatch(/shows only a placeholder/);
  });

  it('passes a room that reads its records, lists something, or draws no empty state', () => {
    const reads = plant({
      'room/Room.tsx': `${head}import { useWorker } from '../reads';\nexport const Room = () => { const w = useWorker(); return <MonitorTemplate state={w ? { kind: 'ready' } : { kind: 'empty', title: 'none' }} />; };\n`,
    });
    expect(placeholderOnly(reads)).toBeNull();
    const lists = plant({
      'room/Room.tsx': `${head}const ITEMS = ['a'];\nexport const Room = () => <MonitorTemplate state={{ kind: 'ready' }} panels={ITEMS.length ? ITEMS.map((i) => <p key={i}>{i}</p>) : <EmptyState title="none" />} />;\n`,
    });
    expect(placeholderOnly(lists)).toBeNull();
    const content = plant({
      ...copy,
      'room/Room.tsx': `${head}export const Room = () => { const { t } = roomCopy.useCopy(); return <MonitorTemplate state={{ kind: 'ready' }} panels={<p>{t('about')}</p>} />; };\n`,
    });
    expect(placeholderOnly(content)).toBeNull();
  });

  it('leaves a placeholder out of n, in a batch, and off the list of rooms allowed off the kit', () => {
    const src = mkdtempSync(join(tmpdir(), 'volt-placeholder-count-'));
    const files: Record<string, string> = {
      'features/m/a/A.tsx': `// volt-room: /m/a\nimport { FlowTemplate } from '@intafaced/ui/lit/templates';\nexport const A = () => <FlowTemplate />;\n`,
      'features/m/b/B.tsx': `// volt-room: /m/b\nimport { FlowTemplate } from '@intafaced/ui/lit/templates';\nexport const B = () => <FlowTemplate state={{ kind: 'empty', title: 'soon' }} />;\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(src, name, '..'), { recursive: true });
      writeFileSync(join(src, name), text);
    }
    const c = voltCount({
      src,
      rooms: ['/m/a', '/m/b'].map((path) => ({ path, title: path, area: 'm' })),
      routeTemplates: { '/m/a': { template: 'flow' }, '/m/b': { template: 'flow' } },
      portalRooms: [],
      portalTemplates: {},
    });
    expect([c.n, c.N]).toEqual([1, 2]);
    expect(c.rooms.find((r) => r.key === '/m/b')?.state).toBe('placeholder');
    expect(c.batches).toEqual([{ batch: 'm · flow', size: 1, rooms: ['/m/b'] }]);
    expect(ratchet(c, [])).toEqual([]);
    expect(ratchet(c, ['/m/b'])).toEqual([]);
    expect(staleOffKit(c, ['/m/b'])).toEqual(['/m/b']);
  });
});

describe('a part drawn through a barrel', () => {
  const plant = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'volt-barrel-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  const room = (imports: string, draws: string) =>
    `import { DeskTemplate } from '@intafaced/ui/lit/templates';\n${imports}\nexport const Room = () => <DeskTemplate>${draws}</DeskTemplate>;\n`;
  const clean = (name: string) => `import { Tag } from '@intafaced/ui/lit';\nexport const ${name} = () => <Tag className="lt-chip" />;\n`;
  const dirty = (name: string) => `export const ${name} = () => <div className="flex gap-2" />;\n`;
  const kinds = (dir: string) => offKitFindings(join(dir, 'room/Room.tsx')).map((f) => `${f.kind} ${f.at.split('/').slice(-1)[0]}`);

  it("fails a room that draws an off-kit part through a folder's index.ts, naming the part and where it is off", () => {
    const dir = plant({
      'room/Room.tsx': room(`import { Board, boardCopy } from '../parts';`, '<Board />'),
      'parts/index.ts': `export { boardCopy } from './copy';\nexport { Board } from './Board';\n`,
      'parts/copy.ts': `export const boardCopy = {};\n`,
      'parts/Board.tsx': dirty('Board'),
    });
    const found = offKitFindings(join(dir, 'room/Room.tsx'));
    expect(kinds(dir)).toEqual(['outside-component Room.tsx:2']);
    expect(found[0]!.text).toMatch(
      /^Board from \.\.\/parts \(.*parts\/Board\.tsx\), which draws off the kit: own-class at .*Board\.tsx:1$/,
    );
  });

  it('passes a room whose barrel part is drawn only from the kit, and judges only the names it imports', () => {
    const dir = plant({
      'room/Room.tsx': room(`import { Board } from '../parts/index';`, '<Board />'),
      'parts/index.ts': `export { Board } from './Board';\nexport { Other } from './Other';\n`,
      'parts/Board.tsx': clean('Board'),
      'parts/Other.tsx': dirty('Other'),
    });
    expect(kinds(dir)).toEqual([]);
  });

  it('follows export * and export { A as B }, through a second barrel', () => {
    const dir = plant({
      'room/Room.tsx': room(`import { Starred, Renamed, Fine } from '../parts';`, '<Starred /><Renamed /><Fine />'),
      'parts/index.ts': `export * from './more';\nexport { Inner as Renamed } from './Inner';\nexport * from './Fine';\n`,
      'parts/more/index.ts': `export * from './Starred';\n`,
      'parts/more/Starred.tsx': dirty('Starred'),
      'parts/Inner.tsx': dirty('Inner'),
      'parts/Fine.tsx': clean('Fine'),
    });
    const found = offKitFindings(join(dir, 'room/Room.tsx'));
    expect(found.map((f) => f.text.split(' ')[0])).toEqual(['Starred', 'Renamed']);
    expect(found[0]!.text).toContain('more/Starred.tsx');
    expect(found[1]!.text).toContain('parts/Inner.tsx');
  });

  it('fails a part a barrel re-exports from the old kit', () => {
    const dir = plant({
      'room/Room.tsx': room(`import { Card } from '../parts';`, '<Card />'),
      'parts/index.ts': `export { Card } from '@intafaced/ui';\n`,
    });
    expect(offKitFindings(join(dir, 'room/Room.tsx'))[0]!.text).toMatch(
      /^Card from \.\.\/parts, which draws off the kit: old-kit at .*index\.ts:1 \(@intafaced\/ui\)$/,
    );
  });

  it('ends a cycle of barrels, and of a part that imports the room back', () => {
    const dir = plant({
      'room/Room.tsx': room(`import { Missing, Board } from '../a';`, '<Missing /><Board />'),
      'a/index.ts': `export * from '../b';\nexport { Board } from './Board';\n`,
      'b/index.ts': `export * from '../a';\n`,
      'a/Board.tsx': `import { Room } from '../room/Room';\nimport { Missing } from '../b';\nexport const Board = () => <div className="card" />;\n`,
    });
    expect(kinds(dir)).toEqual(['outside-component Room.tsx:2']);
  });
});

describe('batches side by side', () => {
  const plantTree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'volt-batches-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  const old = (name: string) => `import { Card } from '@intafaced/ui';\nexport const ${name} = () => <Card className="old" />;\n`;
  const volt = (route: string, name: string) =>
    `// volt-room: ${route}\nimport { FlowTemplate } from '@intafaced/ui/lit/templates';\nexport const ${name} = () => <FlowTemplate />;\n`;
  // Three rooms of one area on one template: /m/a is in Volt already; batch A moves /m/b, batch B moves /m/c.
  const main = {
    'features/m/a/A.tsx': volt('/m/a', 'A'),
    'features/m/b/B.tsx': old('B'),
    'features/m/c/C.tsx': old('C'),
  };
  const batchA = { 'features/m/b/B.tsx': volt('/m/b', 'B') };
  const batchB = { 'features/m/c/C.tsx': volt('/m/c', 'C') };
  const source = (files: Record<string, string>): VoltSource => ({
    src: plantTree(files),
    rooms: ['/m/a', '/m/b', '/m/c'].map((path) => ({ path, title: path, area: 'm' })),
    routeTemplates: { '/m/a': { template: 'flow' }, '/m/b': { template: 'flow' }, '/m/c': { template: 'flow' } },
    portalRooms: [],
    portalTemplates: {},
  });
  const offKit = ['/m/b', '/m/c'];

  it('two batches that move different rooms of one area change no common file', () => {
    const common = Object.keys(batchA).filter((f) => f in batchB);
    expect(common).toEqual([]);
    for (const batch of [batchA, batchB]) expect(Object.keys(batch).every((f) => f.startsWith('features/'))).toBe(true);
  });

  it('each passes into main alone, and after the other merges, with volt-off-kit.json untouched', () => {
    const onMain = voltCount(source(main));
    for (const [label, files, before] of [
      ['batch A', { ...main, ...batchA }, onMain],
      ['batch B', { ...main, ...batchB }, onMain],
      ['A after B', { ...main, ...batchB, ...batchA }, voltCount(source({ ...main, ...batchB }))],
    ] as const) {
      const c = voltCount(source(files));
      expect(ratchet(c, offKit, before), label).toEqual([]);
    }
    expect(voltCount(source({ ...main, ...batchA, ...batchB })).n).toBe(3);
  });

  it("the prune script's list drops only the stale entries, passes, and leaves n as it was", () => {
    const both = voltCount(source({ ...main, ...batchA, ...batchB }));
    expect(staleOffKit(both, offKit)).toEqual(['/m/b', '/m/c']);
    const pruned = prunedOffKit(both, offKit);
    expect(pruned).toEqual([]);
    expect(ratchet(both, pruned, both)).toEqual([]);
    expect(voltCount(source({ ...main, ...batchA, ...batchB })).n).toBe(both.n);
    const half = voltCount(source({ ...main, ...batchA }));
    expect(prunedOffKit(half, offKit)).toEqual(['/m/c']);
  });

  it('a planted fault still fails: a room in Volt moved off the kit, even with a stale entry still allowing it', () => {
    const onMain = voltCount(source(main));
    const fault = { ...main, ...batchA, 'features/m/a/A.tsx': volt('/m/a', 'A').replace('<FlowTemplate />', '<div className="card" />') };
    const problems = ratchet(voltCount(source(fault)), offKit, onMain);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^off: \/m\/a: on its template, but draws off the kit: own-class/);
    const unmarked = { ...main, 'features/m/a/A.tsx': old('A') };
    expect(ratchet(voltCount(source(unmarked)), offKit, onMain)[0]).toMatch(/^off: \/m\/a: not on its flow template yet/);
    // Batch A merged with /m/b's entry left stale; a later change moves /m/b back off the kit.
    const afterA = voltCount(source({ ...main, ...batchA }));
    expect(ratchet(afterA, offKit, onMain)).toEqual([]);
    const back = ratchet(voltCount(source(main)), offKit, afterA);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatch(/^fell: \/m\/b: not on its flow template yet/);
  });

  it('fails a volt-room line that names no room, or a room two files claim', () => {
    const bad = { ...main, 'features/m/x/X.tsx': volt('/m/nowhere', 'X'), 'features/m/y/Y.tsx': volt('/m/a', 'Y') };
    expect(ratchet(voltCount(source(bad)), offKit).map((p) => p.split(':')[0])).toEqual(['mark', 'mark']);
  });
});
