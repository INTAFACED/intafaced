import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package index of @intafaced/contracts carries the server's tRPC and principal code. A browser room that imports
// it fails to open (J-identity-13 #2 on run 42194387369: "This room could not open" on /support/new). Rooms read
// contracts by subpath only.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('the customer app reads contracts by subpath', () => {
  it('no app source imports the @intafaced/contracts package index', () => {
    const offenders = files(SRC).filter((file) => /from\s+['"]@intafaced\/contracts['"]/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
