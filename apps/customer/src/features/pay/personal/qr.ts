/**
 * A small QR Code encoder (ISO/IEC 18004, byte mode, versions 1 to 40, all four error-correction levels).
 * No dependency: the customer app has no QR package, and a payment link has to be scannable from a screen.
 * The algorithm follows the public specification (Reed-Solomon over GF(256), 8 mask patterns, penalty scoring).
 * Pure: text in, a square of dark/light modules out.
 */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits that name the error-correction level. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index = version (0 is unused). One row per level, in L, M, Q, H order.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30,
  ],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24,
    25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40,
    43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56,
    59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63,
    66, 70, 74, 77, 81,
  ],
];

const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  const level = ECC_INDEX[ecc];
  return (
    Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[level]![version]! * NUM_ERROR_CORRECTION_BLOCKS[level]![version]!
  );
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisorFor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function remainderOf(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

/** Split the data into blocks, add the error-correction bytes to each, and interleave them. */
function addEccAndInterleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const level = ECC_INDEX[ecc];
  const blocks = NUM_ERROR_CORRECTION_BLOCKS[level]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[level]![version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = divisorFor(eccLength);
  const all: number[][] = [];
  for (let i = 0, offset = 0; i < blocks; i++) {
    const part = data.slice(offset, offset + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    offset += part.length;
    const check = remainderOf(part, divisor);
    if (i < shortBlocks) part.push(0);
    all.push(part.concat(check));
  }
  const result: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      // The padding byte in a short block is skipped.
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];
  constructor(
    readonly version: number,
    readonly ecc: QrEcc,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  private set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }
  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(this.size - 4, 3);
    this.finder(3, this.size - 4);
    const positions = this.alignmentPositions();
    const n = positions.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.alignment(positions[i]!, positions[j]!);
      }
    this.formatBits(0);
    this.versionBits();
  }
  private finder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, distance !== 2 && distance !== 4);
      }
  }
  private alignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }
  formatBits(mask: number) {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i));
    this.set(8, this.size - 8, true);
  }
  private versionBits() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }
  drawCodewords(data: readonly number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.reserved[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!this.reserved[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
  }
  /** The four standard penalty rules; the mask with the lowest score reads best. */
  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let result = 0;
    const lines = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        const history: number[] = [];
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) result += 3 + (run - 5);
            history.push(run);
            run = 1;
          }
        }
        // Finder-like 1:1:3:1:1 runs with light space on one side.
        for (let k = 0; k + 4 < history.length; k++) {
          const core = history[k + 1]!;
          if (core > 0 && history[k + 2] === core * 3 && history[k + 3] === core && history[k + 4] === core) {
            const before = history[k]!;
            const after = history[k + 5] ?? 0;
            if (before >= core * 4 || after >= core * 4) result += 40;
          }
        }
      }
    };
    lines((y, x) => m[y]![x]!);
    lines((x, y) => m[y]![x]!);
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        const c = m[y]![x]!;
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
      }
    let dark = 0;
    for (const row of m) for (const cell of row) if (cell) dark++;
    const total = n * n;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];

/** Largest text (in UTF-8 bytes) that fits at a level. */
export function qrCapacity(ecc: QrEcc = 'M'): number {
  return Math.floor((dataCodewords(40, ecc) * 8 - 4 - 16) / 8);
}

/** Dark modules as `true`. Throws when the text is too long for any version at that level. */
export function encodeQr(text: string, ecc: QrEcc = 'M'): boolean[][] {
  const bytes = utf8(text);
  let version = 1;
  let capacityBits = 0;
  for (; ; version++) {
    if (version > 40) throw new RangeError('QR text too long');
    capacityBits = dataCodewords(version, ecc) * 8;
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= capacityBits) break;
  }
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = new Array<number>(bits.length / 8).fill(0);
  bits.forEach((value, i) => {
    data[i >>> 3]! |= value << (7 - (i & 7));
  });

  const grid = new Grid(version, ecc);
  grid.drawFunctionPatterns();
  grid.drawCodewords(addEccAndInterleave(data, version, ecc));
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    grid.applyMask(mask);
    grid.formatBits(mask);
    const score = grid.penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    grid.applyMask(mask);
  }
  grid.applyMask(best);
  grid.formatBits(best);
  return grid.modules;
}

/** One SVG path for the dark modules, with a quiet zone of `border` modules. The viewBox is returned alongside. */
export function qrPath(modules: readonly (readonly boolean[])[], border = 4): { d: string; size: number } {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + border},${y + border}h${end - x}v1h${x - end}z`);
      x = end;
    }
  });
  return { d: parts.join(''), size: modules.length + border * 2 };
}
