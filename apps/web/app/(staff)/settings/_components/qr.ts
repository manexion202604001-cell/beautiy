// Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1–10 (up to 213 bytes) — enough for public booking URLs. Pure, no deps.

// [dataCodewordsPerBlock by group..., ecCodewordsPerBlock] for level M, versions 1..10
const BLOCKS_M: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree: number) {
  const r = new Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data: number[], div: number[]) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

export interface QrMatrix { size: number; modules: boolean[][] }

export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = BLOCKS_M[v - 1].groups.reduce((s, [n, d]) => s + n * d, 0);
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= cap * 8) { version = v; break; }
  }
  if (!version) throw new Error('QR: data too long');
  const spec = BLOCKS_M[version - 1];
  const dataCap = spec.groups.reduce((s, [n, d]) => s + n * d, 0);

  // bit stream
  const bb: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCap * 8 - bb.length));
  while (bb.length % 8) bb.push(0);
  for (let pad = 0xec; bb.length < dataCap * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(''), 2));

  // blocks + interleave
  const div = rsDivisor(spec.ec);
  const blocks: { d: number[]; e: number[] }[] = [];
  let k = 0;
  for (const [n, len] of spec.groups) for (let i = 0; i < n; i++) { const d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsRemainder(d, div) }); }
  const cw: number[] = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) cw.push(b.d[i]);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) cw.push(b.e[i]);

  const size = version * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
  const al = ALIGN[version - 1], last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (0 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    const b = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // zigzag data placement
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < cw.length * 8) { m[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
      }
    }
  }

  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (k: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[k](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let y = 0; y < size; y++) {
      for (const axis of [0, 1]) {
        let run = 1;
        for (let i = 1; i < size; i++) {
          const a = axis ? m[i][y] : m[y][i], b = axis ? m[i - 1][y] : m[y][i - 1];
          if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
      for (let x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      }
    }
    // rule 3: finder-like 1:1:3:1:1 patterns with 4 light modules on one side
    const A = [true, false, true, true, true, false, true, false, false, false, false];
    const B = [false, false, false, false, true, false, true, true, true, false, true];
    for (let y = 0; y < size; y++) for (let x = 0; x + 11 <= size; x++) {
      for (const pat of [A, B]) {
        if (pat.every((v, i) => m[y][x + i] === v)) p += 40;
        if (pat.every((v, i) => m[x + i][y] === v)) p += 40;
      }
    }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(k); drawFormat(k);
    const p = penalty();
    if (p < bestP) { bestP = p; best = k; }
    applyMask(k); // undo
  }
  applyMask(best); drawFormat(best);
  return { size, modules: m };
}

/** SVG path data (1 unit per module) with a 4-module quiet zone. */
export function qrSvgPath(q: QrMatrix, quiet = 4): { d: string; dim: number } {
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) d += `M${x + quiet},${y + quiet}h1v1h-1z`;
  return { d, dim: q.size + quiet * 2 };
}
