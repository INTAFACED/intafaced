// The Volt ratchet: n never falls and no new room starts off the kit. `volt-off-kit.json` lists the rooms
// allowed off the kit today; it only shrinks (`node tooling/design/volt-count.mjs --write` drops a room once it is in Volt;
// tooling/design/volt-lists.test.mjs fails a list that gains a room). On a batch PR into a Volt layer a stale entry does
// not fail, so no batch edits the list; the layer's PR into main holds it exact.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { intoVoltLayer, offKitFindings, ratchet, voltCount, type VoltSource } from './volt-count';
import allowedOffKit from './volt-off-kit.json';

const count = voltCount();

describe('customer rooms in Volt', () => {
  it('counts every room once', () => {
    const keys = count.rooms.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(count.N).toBe(keys.length);
    console.info(`Customer rooms in Volt: ${count.n} of ${count.N}`);
  });

  it('starts no room off the kit, and lets no room in Volt fall off it', () => {
    const problems = ratchet(count, allowedOffKit, true);
    expect(problems, 'a room not in Volt that volt-off-kit.json does not allow (build it on its template from the kit)').toEqual([]);
  });

  it('keeps the list of rooms allowed off the kit tight, except on a batch into a Volt layer', () => {
    const stale = ratchet(count, allowedOffKit, intoVoltLayer()).filter((p) => p.startsWith('stale:'));
    if (intoVoltLayer())
      console.info(
        `A batch into ${process.env.GITHUB_BASE_REF}: ${count.rooms.filter((r) => r.state === 'volt' && allowedOffKit.includes(r.key)).length} listed rooms now in Volt, tightened on the layer's PR into main`,
      );
    expect(stale).toEqual([]);
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

  it("follows a feature's index.ts re-export to the .tsx it names, and judges that part", () => {
    const dir = plant({
      'room/Room.tsx': [
        `import { FlowTemplate } from '@intafaced/ui/lit/templates';`,
        `import { Confirm, useSign } from '../features/auth';`,
        `import { Bar } from '../features/wallet/index';`,
        `import { Clean } from '../features/clean';`,
        `export const Room = () => <FlowTemplate><Confirm /><Bar /><Clean /></FlowTemplate>;`,
      ].join('\n'),
      'features/auth/index.ts': `export { useSign } from './hooks';\nexport { StepUp as Confirm, type Props } from './StepUp';\n`,
      'features/auth/hooks.ts': `export const useSign = () => 1;\n`,
      'features/auth/StepUp.tsx': `import { Card } from '@intafaced/ui';\nexport const StepUp = () => <Card />;\n`,
      'features/wallet/index.ts': `export * from './parts';\n`,
      'features/wallet/parts.ts': `export { Bar } from './Bar';\n`,
      'features/wallet/Bar.tsx': `export const Bar = () => <div className="wallet-bar" />;\n`,
      'features/clean/index.ts': `export { Clean } from './Clean';\n`,
      'features/clean/Clean.tsx': `import { Tag } from '@intafaced/ui/lit';\nexport const Clean = () => <Tag />;\n`,
    });
    const found = offKitFindings(join(dir, 'room/Room.tsx'));
    expect(found.map((f) => `${f.kind} ${f.at.split('/').slice(-1)[0]}`)).toEqual([
      'outside-component Room.tsx:2',
      'outside-component Room.tsx:3',
    ]);
    expect(found[0]!.text).toMatch(/^Confirm from \.\.\/features\/auth \(.*StepUp\.tsx\), which draws off the kit: old-kit/);
    expect(found[1]!.text).toMatch(/^Bar from .*Bar\.tsx\), which draws off the kit: own-class/);
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

  it('each passes on its layer alone, and after the other merges, with volt-off-kit.json untouched', () => {
    for (const [label, files] of [
      ['batch A', { ...main, ...batchA }],
      ['batch B', { ...main, ...batchB }],
      ['A after B', { ...main, ...batchB, ...batchA }],
    ] as const) {
      const c = voltCount(source(files));
      expect(ratchet(c, offKit, true), label).toEqual([]);
    }
    expect(voltCount(source({ ...main, ...batchA, ...batchB })).n).toBe(3);
  });

  it("the layer's PR into main holds the list exact, and --write's list passes it", () => {
    const both = voltCount(source({ ...main, ...batchA, ...batchB }));
    expect(ratchet(both, offKit, false).map((p) => p.split(':')[0])).toEqual(['stale', 'stale']);
    const written = offKit.filter((key) => both.rooms.some((r) => r.key === key && r.state !== 'volt'));
    expect(ratchet(both, written, false)).toEqual([]);
  });

  it('a planted fault still fails a batch: a room in Volt moved off the kit', () => {
    const fault = { ...main, ...batchA, 'features/m/a/A.tsx': volt('/m/a', 'A').replace('<FlowTemplate />', '<div className="card" />') };
    const problems = ratchet(voltCount(source(fault)), offKit, true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^off: \/m\/a: on its template, but draws off the kit: own-class/);
    const unmarked = { ...main, 'features/m/a/A.tsx': old('A') };
    expect(ratchet(voltCount(source(unmarked)), offKit, true)[0]).toMatch(/^off: \/m\/a: not on its flow template yet/);
  });

  it('fails a volt-room line that names no room, or a room two files claim', () => {
    const bad = { ...main, 'features/m/x/X.tsx': volt('/m/nowhere', 'X'), 'features/m/y/Y.tsx': volt('/m/a', 'Y') };
    expect(ratchet(voltCount(source(bad)), offKit, true).map((p) => p.split(':')[0])).toEqual(['mark', 'mark']);
  });

  it('reads a batch PR into a Volt layer from the base branch only', () => {
    expect(intoVoltLayer({ GITHUB_BASE_REF: 'volt/overview' })).toBe(true);
    expect(intoVoltLayer({ GITHUB_BASE_REF: 'main' })).toBe(false);
    expect(intoVoltLayer({})).toBe(false);
  });
});
