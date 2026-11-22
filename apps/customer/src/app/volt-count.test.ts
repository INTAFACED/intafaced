// The Volt ratchet: n never falls and no new room starts off the kit. `volt-off-kit.json` lists the rooms
// allowed off the kit today; it only shrinks (`node tooling/design/volt-count.mjs --write` drops a room once it is in Volt).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { offKitFindings, voltCount } from './volt-count';
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
    const allowed = new Set<string>(allowedOffKit);
    const off = count.rooms
      .filter((r) => r.state !== 'volt' && !allowed.has(r.key))
      .map((r) => `${r.key}: ${r.reason}${r.findings.map((f) => `\n    ${f.kind} at ${f.at}: ${f.text}`).join('')}`);
    expect(off, 'a room not in Volt that volt-off-kit.json does not allow (build it on its template from the kit)').toEqual([]);
  });

  it('keeps the list of rooms allowed off the kit tight', () => {
    const off = new Set(count.rooms.filter((r) => r.state !== 'volt').map((r) => r.key));
    const stale = allowedOffKit.filter((key) => !off.has(key));
    expect(stale, 'in Volt now, or no longer a room: run `node tooling/design/volt-count.mjs --write`').toEqual([]);
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
