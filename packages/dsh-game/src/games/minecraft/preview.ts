/**
 * 图纸的渲染图：给她「看一眼」自己设计的东西（字符投影看得出轮廓，看不出像不像、好不好看）。
 *
 *   - 方块颜色：从游戏 jar 里按方块状态 → 模型 → 贴图找到顶面和侧面的贴图，算平均色；草、树叶按默认的绿色上色；玻璃这类半透明
 *   - 画法：45° 斜俯视的方块图（顶面亮、两个侧面暗一点，每块描一圈细边看得出一格格），从东南、西南、西北、东北四个角各看一张，拼成 2×2 一张图
 *   - 只画看得见的方块（六面都被挡住的不画）；先画远的再画近的
 *   - 台阶画半块，楼梯画「下半块 + 朝向那边的上半块」（倒装的反过来）：屋顶的坡看得出来，不会画成台阶状的金字塔
 * 没有 jar（没装客户端）就没有渲染图，只有字符投影。
 */
import zlib from 'node:zlib';
import type { Blueprint } from './blueprint.js';
import { GameJar } from './gameJar.js';

// ───────────────────────── PNG ─────────────────────────

/** 读 PNG：8 位的 RGBA / RGB / 灰度，和 1～8 位的调色板（游戏贴图够用了） */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | null {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8;
  let width = 0, height = 0, depth = 8, type = 6, palette: Buffer | null = null, alpha: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) return null; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') alpha = data;
    else if (kind === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels || (type !== 3 && depth !== 8)) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = lines.subarray(y * stride, (y + 1) * stride);
    const up = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= bpp ? up[i - bpp] : 0;
      const v = src[i];
      // Paeth：p = a + b - c，取 a / b / c 里离 p 最近的（一样近按 a、b、c 的顺序）
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[i] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const row = lines.subarray(y * stride, (y + 1) * stride);
    if (type === 3) {
      const bit = x * depth;
      const idx = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      rgba[o] = palette?.[idx * 3] ?? 0; rgba[o + 1] = palette?.[idx * 3 + 1] ?? 0; rgba[o + 2] = palette?.[idx * 3 + 2] ?? 0;
      rgba[o + 3] = alpha && idx < alpha.length ? alpha[idx] : 255;
    } else {
      const s = x * channels;
      const g = row[s];
      rgba[o] = type === 2 || type === 6 ? row[s] : g;
      rgba[o + 1] = type === 2 || type === 6 ? row[s + 1] : g;
      rgba[o + 2] = type === 2 || type === 6 ? row[s + 2] : g;
      rgba[o + 3] = type === 6 ? row[s + 3] : type === 4 ? row[s + 1] : 255;
    }
  }
  return { width, height, rgba };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 写 PNG（8 位 RGB） */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ───────────────────────── 方块颜色 ─────────────────────────

export interface FaceColors {
  top: [number, number, number];
  side: [number, number, number];
  /** 不透明度：玻璃这类小于 1 */
  alpha: number;
}

const FOLIAGE: [number, number, number] = [0x59, 0xae, 0x30];
const GRASS: [number, number, number] = [0x79, 0xc0, 0x5a];

/** 从游戏 jar 里找方块的颜色（找过的记下来） */
export class BlockColors {
  private readonly cache = new Map<string, FaceColors>();
  constructor(private readonly jar: GameJar) {}

  private texture(ref: string | undefined): { color: [number, number, number]; alpha: number } | null {
    if (!ref) return null;
    const name = ref.replace(/^minecraft:/, '');
    const png = this.jar.read(`assets/minecraft/textures/${name}.png`);
    const img = png ? decodePng(png) : null;
    if (!img) return null;
    let r = 0, g = 0, b = 0, n = 0, a = 0;
    const pixels = img.width * Math.min(img.height, img.width); // 动画贴图是竖着排的好几帧：只看第一帧
    for (let i = 0; i < pixels; i++) {
      const al = img.rgba[i * 4 + 3];
      a += al;
      if (al < 16) continue;
      r += img.rgba[i * 4]; g += img.rgba[i * 4 + 1]; b += img.rgba[i * 4 + 2]; n += 1;
    }
    if (!n) return null;
    return { color: [r / n, g / n, b / n], alpha: a / pixels / 255 };
  }

  /** 方块状态 → 第一个模型 → 一路找父模型，收齐贴图变量 */
  private textures(name: string): Record<string, string> {
    const state = this.jar.json(`assets/minecraft/blockstates/${name}.json`);
    const first = state?.variants ? Object.values(state.variants)[0] : state?.multipart?.[0]?.apply;
    let model: string | undefined = (Array.isArray(first) ? first[0] : first as any)?.model;
    const vars: Record<string, string> = {};
    for (let depth = 0; model && depth < 8; depth++) {
      const m = this.jar.json(`assets/minecraft/models/${model.replace(/^minecraft:/, '')}.json`);
      if (!m) break;
      for (const [k, v] of Object.entries(m.textures ?? {})) if (!(k in vars)) vars[k] = String(v);
      model = m.parent;
    }
    const resolve = (v: string | undefined, hops = 0): string | undefined => (v?.startsWith('#') && hops < 6 ? resolve(vars[v.slice(1)], hops + 1) : v);
    const out: Record<string, string> = {};
    for (const k of Object.keys(vars)) { const r = resolve(vars[k]); if (r) out[k] = r; }
    return out;
  }

  of(name: string): FaceColors {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const t = this.textures(name);
    const top = this.texture(t.top ?? t.end ?? t.up ?? t.all ?? t.texture ?? t.cross ?? t.particle ?? t.side);
    const side = this.texture(t.side ?? t.all ?? t.front ?? t.texture ?? t.cross ?? t.particle ?? t.top) ?? top;
    let colors: FaceColors = top && side
      ? { top: top.color, side: side.color, alpha: Math.min(1, Math.max(0.25, (top.alpha + side.alpha) / 2)) }
      : { top: [200, 60, 200], side: [160, 40, 160], alpha: 1 }; // 找不到贴图：醒目的紫色
    const tint = /leaves$/.test(name) && !/cherry|azalea|pale/.test(name) ? FOLIAGE : /^(short_grass|tall_grass|grass|fern|large_fern|vine|lily_pad)$/.test(name) ? GRASS : null;
    if (tint) colors = { ...colors, top: mul(colors.top, tint), side: mul(colors.side, tint) };
    if (name === 'grass_block') colors = { ...colors, top: mul(colors.top, GRASS) };
    this.cache.set(name, colors);
    return colors;
  }
}

const mul = (c: [number, number, number], t: [number, number, number]): [number, number, number] => [c[0] * t[0] / 255, c[1] * t[1] / 255, c[2] * t[2] / 255];

// ───────────────────────── 画 ─────────────────────────

/** 四个看的方向：从哪个角看。u 是画面里往右下的方向，v 是往左下的方向 */
const VIEWS: { label: string; map: (c: number, r: number, w: number, d: number) => [number, number]; size: (w: number, d: number) => [number, number] }[] = [
  { label: '从东南看', map: (c, r) => [c, r], size: (w, d) => [w, d] },
  { label: '从西南看', map: (c, r, w) => [r, w - 1 - c], size: (w, d) => [d, w] },
  { label: '从西北看', map: (c, r, w, d) => [w - 1 - c, d - 1 - r], size: (w, d) => [w, d] },
  { label: '从东北看', map: (c, r, w, d) => [d - 1 - r, c], size: (w, d) => [d, w] },
];

export const VIEW_LABELS = '左上从东南看、右上从西南看、左下从西北看、右下从东北看';

/** 渲染图（PNG）：2×2 四个方向 */
export function renderBlueprint(bp: Blueprint, colors: BlockColors, panel = 480): Buffer {
  const width = panel * 2, height = panel * 2;
  const img = new Uint8Array(width * height * 3);
  // 背景：浅灰蓝，四格之间一条细线
  for (let i = 0; i < width * height; i++) { img[i * 3] = 222; img[i * 3 + 1] = 228; img[i * 3 + 2] = 236; }
  for (let i = 0; i < width; i++) for (const y of [panel - 1, panel]) { const o = (y * width + i) * 3; img[o] = img[o + 1] = img[o + 2] = 180; }
  for (let j = 0; j < height; j++) for (const x of [panel - 1, panel]) { const o = (j * width + x) * 3; img[o] = img[o + 1] = img[o + 2] = 180; }

  const solid = (k: number, r: number, c: number) => { const ch = bp.layers[k]?.[r]?.[c]; return !!ch && ch !== '.' && ch !== ' '; };
  // 看得见的方块（六面里至少一面挨着空的）
  const visible: { c: number; r: number; k: number; col: FaceColors; name: string; props: Record<string, string> }[] = [];
  for (let k = 0; k < bp.height; k++) for (let r = 0; r < bp.depth; r++) for (let c = 0; c < bp.width; c++) {
    if (!solid(k, r, c)) continue;
    if (solid(k + 1, r, c) && solid(k - 1, r, c) && solid(k, r + 1, c) && solid(k, r - 1, c) && solid(k, r, c + 1) && solid(k, r, c - 1)) continue;
    const spec = bp.legend[bp.layers[k][r][c]];
    visible.push({ c, r, k, col: colors.of(spec.name), name: spec.name, props: spec.props });
  }

  VIEWS.forEach((view, vi) => {
    const [U, V] = view.size(bp.width, bp.depth);
    // 每格的半宽 a（像素）：整张放得进一格画面
    const a = Math.max(1, Math.min(24, Math.floor(Math.min((panel - 16) / (U + V), (panel - 16) / ((U + V) / 2 + bp.height + 1)))));
    const drawW = (U + V) * a, drawH = ((U + V) / 2 + bp.height) * a;
    const ox = (vi % 2) * panel + Math.floor((panel - drawW) / 2) + V * a;
    const oy = Math.floor(vi / 2) * panel + Math.floor((panel - drawH) / 2) + bp.height * a;
    const put = (x: number, y: number, rgb: [number, number, number], alpha: number) => {
      if (x < (vi % 2) * panel || x >= (vi % 2 + 1) * panel || y < Math.floor(vi / 2) * panel || y >= (Math.floor(vi / 2) + 1) * panel) return;
      const o = (y * width + x) * 3;
      for (let i = 0; i < 3; i++) img[o + i] = Math.round(img[o + i] * (1 - alpha) + rgb[i] * alpha);
    };
    // 地面：图纸占的那块地，画浅一点的菱形
    for (let u = 0; u < U; u++) for (let v = 0; v < V; v++) {
      const sx = ox + (u - v) * a, sy = oy + ((u + v) * a) / 2;
      for (let py = 0; py < a; py++) for (let px = 0; px < 2 * a; px++) {
        if (Math.abs(px - a + 0.5) / a + Math.abs(py - a / 2 + 0.5) / (a / 2) <= 1) put(sx + px, Math.round(sy + py), [205, 210, 200], 1);
      }
    }
    // 远的先画：u + v 小的、低的先画
    const order = visible.map((b) => { const [u, v] = view.map(b.c, b.r, bp.width, bp.depth); return { ...b, u, v }; })
      .sort((p, q) => p.u + p.v - (q.u + q.v) || p.k - q.k);
    const edge = a >= 3;
    // 格子里的一个点（u、v、y 都可以带小数）→ 画面上的像素
    const proj = (u: number, v: number, y: number): [number, number] => [ox + (u - v) * a + a, oy + ((u + v) * a) / 2 - y * a];
    /** 画一个长方体看得见的三个面（顶、+u 那面、+v 那面），每面描一圈暗边 */
    const box = (u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, col: FaceColors) => {
      const faces: [[number, number][], [number, number, number], number][] = [
        [[proj(u0, v0, y1), proj(u1, v0, y1), proj(u1, v1, y1), proj(u0, v1, y1)], col.top, 1],
        [[proj(u1, v0, y0), proj(u1, v1, y0), proj(u1, v1, y1), proj(u1, v0, y1)], col.side, 0.8],
        [[proj(u0, v1, y0), proj(u1, v1, y0), proj(u1, v1, y1), proj(u0, v1, y1)], col.side, 0.62],
      ];
      for (const [pts, base, shade] of faces) fillQuad(pts, [base[0] * shade, base[1] * shade, base[2] * shade], col.alpha, edge);
    };
    const fillQuad = (pts: [number, number][], rgb: [number, number, number], alpha: number, outline: boolean) => {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs)), minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
      // 凸四边形：点在四条边的同一侧就在里面；离边不到一像素的描暗
      const edges = pts.map((p, i) => { const q = pts[(i + 1) % 4]; const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return { p, q, len }; });
      for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        let sign = 0, inside = true, near = Infinity;
        for (const { p, q, len } of edges) {
          const cross = (q[0] - p[0]) * (cy - p[1]) - (q[1] - p[1]) * (cx - p[0]);
          if (Math.abs(cross) < 1e-9) continue;
          const sg = Math.sign(cross);
          if (sign && sg !== sign) { inside = false; break; }
          sign = sg;
          near = Math.min(near, Math.abs(cross) / len);
        }
        if (!inside) continue;
        const k = outline && near < 1 ? 0.82 : 1;
        put(x, y, [rgb[0] * k, rgb[1] * k, rgb[2] * k], alpha);
      }
    };
    // 楼梯朝向（世界里的东南西北）→ 这张图里 u、v 的方向
    const dirUV = (b: { c: number; r: number }, facing: string): [number, number] => {
      const d = ({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as Record<string, [number, number]>)[facing] ?? [0, 0];
      const [u0, v0] = view.map(b.c, b.r, bp.width, bp.depth);
      const [u1, v1] = view.map(b.c + d[0], b.r + d[1], bp.width, bp.depth);
      return [u1 - u0, v1 - v0];
    };
    for (const b of order) {
      const { u, v, k: y } = b;
      const half = b.props.half === 'top' || b.props.type === 'top' ? 'top' : 'bottom';
      if (/_slab$/.test(b.name) && b.props.type !== 'double') {
        box(u, v, y + (half === 'top' ? 0.5 : 0), u + 1, v + 1, y + (half === 'top' ? 1 : 0.5), b.col);
      } else if (/_stairs$/.test(b.name)) {
        const [du, dv] = dirUV(b, b.props.facing ?? 'north');
        // 高的那一半在朝向那边
        const ua = du > 0 ? u + 0.5 : u, ub = du < 0 ? u + 0.5 : u + 1, va = dv > 0 ? v + 0.5 : v, vb = dv < 0 ? v + 0.5 : v + 1;
        if (half === 'bottom') { box(u, v, y, u + 1, v + 1, y + 0.5, b.col); box(ua, va, y + 0.5, ub, vb, y + 1, b.col); }
        else { box(ua, va, y, ub, vb, y + 0.5, b.col); box(u, v, y + 0.5, u + 1, v + 1, y + 1, b.col); }
      } else {
        box(u, v, y, u + 1, v + 1, y + 1, b.col);
      }
    }
  });
  return encodePng(width, height, img);
}
