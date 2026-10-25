/**
 * 形状图纸：复杂的几何（穹顶、圆塔、尖顶、拱）不用一格格算，用形状写，一行一个，像 OpenSCAD 那样。
 * 工具只做「把形状画进格子」这件机械的事；造型、比例、材料、怎么组合是她定的。
 *
 *   materials: Q=quartz_block S=stone_bricks G=glass T=oak_stairs[facing=north]
 *   cylinder S center 0 0 0 radius 6 height 8 hollow 1 open top     塔身（只要墙，不封顶）
 *   sphere Q center 0 8 0 radius 6 top hollow 1                     穹顶（上半球，切面天然开口）
 *   cone copper_block center 0 14 0 radius 2 height 4               尖顶
 *   cut box from -1 0 -7 to 1 3 -5                                  门洞
 *   blueprint 窗户 at 4 3 -7                                        把另一张图纸（字符图也行）放在这里
 *   box G from 5 2 -1 to 5 3 -1 repeat 4 step 0 0 -3                一排 4 扇窗（每扇往北挪 3 格）
 *   box S from 3 0 -2 to 8 4 2 mirror x                             东边一翼，镜像出西边那一翼
 *   roof spruce_stairs from -6 5 -4 to 6 5 4 gable fill P overhang 1  人字坡屋顶（楼梯朝向自动算），两头补三角墙
 *
 * 规则：
 *   - 坐标是方块坐标（整数），相对于盖的时候给的那个点；x 往东，y 往上，z 往南
 *   - 一格算在形状里：这一格的中心落在形状里（球、圆柱的半径按 r + 0.5 算：半径 6 的球正好 13 格宽）
 *   - hollow t：只留外壳，厚 t 格；外壳是封闭的（往里收 t 格剩下的才挖空）。半球、拱的切面，open 指定的那一头不封
 *   - 后写的盖掉先写的；cut 是从前面的形状里挖掉（不动世界里原来的东西）；材料写 air 是把世界里那些格子清成空气
 *   - repeat N step dx dy dz：这一行画 N 份，每份挪一个步长；mirror x / z / xz：再按 x=0 / z=0 的平面画镜像（楼梯、门的朝向跟着翻，左右对调）
 *   - roof 楼梯 from x1 y z1 to x2 y z2：在这块地上用楼梯一层层往里收（每层高一格），朝向朝屋脊往上；gable 人字顶（axis x / z 是屋脊的方向，默认顺着长边），
 *     hip 四坡顶；宽度是单数时屋脊是一排实心方块（ridge 方块，默认是这种楼梯对应的木板 / 砖）；fill 方块：补人字顶两头的三角墙；overhang n：屋檐往外多出 n 格
 *   - 最大 256 × 256 × 256，最多 100 万块
 */
import type { Blueprint, BlockSpec } from './blueprint.js';

export const SHAPE_LIMITS = { size: 256, blocks: 1_000_000 };

export interface ShapeResult {
  blueprint: Blueprint | null;
  errors: string[];
  warnings: string[];
}

const KINDS = ['box', 'sphere', 'cylinder', 'cone', 'pyramid', 'arch', 'line', 'roof', 'blueprint'];
const GRAVITY = /^(sand|red_sand|gravel|anvil|chipped_anvil|damaged_anvil|.*_concrete_powder|dragon_egg|suspicious_sand|suspicious_gravel|scaffolding)$/;
const POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@$%&*+=-~^!?<>/|;:\'"`,()[]{}';

/** 写的是形状图纸吗（第一行有内容的是 materials: 或者形状名） */
export function isShapeText(text: string): boolean {
  const first = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('```') && !l.startsWith('//'));
  if (!first) return false;
  return /^(materials|材料)\s*[:：]/i.test(first) || new RegExp(`^(cut\\s+)?(${KINDS.join('|')})\\b`, 'i').test(first);
}

interface Shape {
  min: [number, number, number];
  max: [number, number, number];
  /** 这一格在形状里 */
  contains(x: number, y: number, z: number): boolean;
  /** 挖空心时看「外面」用：半球的切面、open 的那一头、拱的两头当作还在里面（不封口） */
  full(x: number, y: number, z: number): boolean;
}

const sq = (v: number) => v * v;

/** 一行拆成：cut?、形状名、材料、参数 */
function parseLine(line: string): { cut: boolean; kind: string; material: string | null; nums: Record<string, number[]>; flags: Set<string>; words: Record<string, string> } | string {
  const tokens = line.split(/\s+/).filter(Boolean);
  let i = 0;
  const cut = tokens[i]?.toLowerCase() === 'cut';
  if (cut) i += 1;
  const kind = tokens[i++]?.toLowerCase() ?? '';
  if (!KINDS.includes(kind)) return `看不懂「${line}」：形状只有 ${KINDS.join(' / ')}（前面可以加 cut）`;
  let material: string | null = null;
  const KEYS = new Set(['from', 'to', 'center', 'radius', 'height', 'length', 'axis', 'hollow', 'open', 'at', 'top', 'bottom', 'down', 'repeat', 'step', 'mirror', 'overhang', 'gable', 'hip', 'ridge', 'fill']);
  if (kind === 'blueprint') {
    material = tokens[i++] ?? null;
    if (!material) return `「${line}」：blueprint 后面写图纸的名字`;
  } else if (!cut) {
    material = tokens[i] && !KEYS.has(tokens[i].toLowerCase()) ? tokens[i++] : null;
    if (!material) return `「${line}」：形状名后面写材料（materials 里的字母，或者方块名）`;
  } else if (tokens[i] && !KEYS.has(tokens[i].toLowerCase()) && !/^-?\d/.test(tokens[i])) {
    // cut 挖掉的地方不用材料：写了（比如 cut box air）也不碍事
    i += 1;
  }
  const nums: Record<string, number[]> = {};
  const flags = new Set<string>();
  const words: Record<string, string> = {};
  while (i < tokens.length) {
    const key = tokens[i++].toLowerCase();
    if (['top', 'bottom', 'down', 'gable', 'hip'].includes(key)) { flags.add(key); continue; }
    if (key === 'axis' || key === 'open' || key === 'mirror' || key === 'ridge' || key === 'fill') {
      const raw = tokens[i++];
      if (!raw) return `「${line}」：${key} 后面要写值`;
      // ridge / fill 是材料：字母分大小写
      words[key] = key === 'ridge' || key === 'fill' ? raw : raw.toLowerCase();
      continue;
    }
    if (!KEYS.has(key)) return `「${line}」里的「${key}」看不懂（能写的：from to center radius height length axis hollow open top bottom down at repeat step mirror，roof 还有 gable hip ridge fill overhang）`;
    const values: number[] = [];
    while (i < tokens.length && /^-?\d+(\.\d+)?$/.test(tokens[i])) values.push(Number(tokens[i++]));
    if (key === 'hollow' && !values.length) values.push(1);
    if (!values.length) return `「${line}」：${key} 后面要写数字`;
    nums[key] = values;
  }
  return { cut, kind, material, nums, flags, words };
}

function need(nums: Record<string, number[]>, key: string, count: number, line: string): number[] {
  const v = nums[key];
  if (!v || v.length < count) throw new Error(`「${line}」：要写 ${key}${count > 1 ? `（${count} 个数）` : ''}`);
  return v;
}

/** 一行 → 形状 */
function makeShape(kind: string, nums: Record<string, number[]>, flags: Set<string>, words: Record<string, string>, line: string): Shape {
  const open = words.open ?? '';
  const openTop = /top|both|ends/.test(open);
  const openBottom = /bottom|both|ends/.test(open);
  switch (kind) {
    case 'box': {
      const [x1, y1, z1] = need(nums, 'from', 3, line);
      const [x2, y2, z2] = need(nums, 'to', 3, line);
      const lo = [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)] as [number, number, number];
      const hi = [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)] as [number, number, number];
      const inXZ = (x: number, z: number) => x >= lo[0] && x <= hi[0] && z >= lo[2] && z <= hi[2];
      return {
        min: lo, max: hi,
        contains: (x, y, z) => inXZ(x, z) && y >= lo[1] && y <= hi[1],
        full: (x, y, z) => inXZ(x, z) && (openBottom || y >= lo[1]) && (openTop || y <= hi[1]),
      };
    }
    case 'sphere': {
      const [cx, cy, cz] = need(nums, 'center', 3, line);
      const r = need(nums, 'radius', 1, line);
      const [rx, ry, rz] = r.length >= 3 ? r : [r[0], r[0], r[0]];
      const inside = (x: number, y: number, z: number) => sq((x - cx) / (rx + 0.5)) + sq((y - cy) / (ry + 0.5)) + sq((z - cz) / (rz + 0.5)) <= 1;
      const top = flags.has('top');
      const bottom = flags.has('bottom');
      return {
        min: [Math.floor(cx - rx), top ? cy : Math.floor(cy - ry), Math.floor(cz - rz)],
        max: [Math.ceil(cx + rx), bottom ? cy : Math.ceil(cy + ry), Math.ceil(cz + rz)],
        contains: (x, y, z) => inside(x, y, z) && (!top || y >= cy) && (!bottom || y <= cy),
        full: inside,
      };
    }
    case 'cylinder':
    case 'arch': {
      const [cx, cy, cz] = need(nums, 'center', 3, line);
      const r = need(nums, 'radius', 1, line)[0];
      const len = (nums.height ?? nums.length ?? [kind === 'arch' ? 1 : 0])[0];
      if (!len) throw new Error(`「${line}」：要写 height（沿着轴有多长）`);
      const axis = words.axis ?? (kind === 'arch' ? 'x' : 'y');
      if (!['x', 'y', 'z'].includes(axis)) throw new Error(`「${line}」：axis 只能是 x / y / z`);
      if (kind === 'arch' && axis === 'y') throw new Error(`「${line}」：拱是横着的，axis 写 x（拱洞朝南北）或 z（拱洞朝东西）`);
      // 把格子换成（沿轴的距离，横截面上的两个坐标）
      const split = (x: number, y: number, z: number): [number, number, number] =>
        axis === 'y' ? [y - cy, x - cx, z - cz] : axis === 'x' ? [x - cx, y - cy, z - cz] : [z - cz, x - cx, y - cy];
      const disc = (a: number, b: number) => sq(a) + sq(b) <= sq(r + 0.5);
      const along = (t: number, ends: boolean) => (ends ? true : t >= 0 && t <= len - 1);
      if (kind === 'arch') {
        // 半个圆柱横放，拱顶朝上：横截面只要 y ≥ 中心的那半；底下切面和两头都不封
        const up = (x: number, y: number, z: number) => y >= cy;
        return {
          min: axis === 'x' ? [cx, cy, Math.floor(cz - r)] : [Math.floor(cx - r), cy, cz],
          max: axis === 'x' ? [cx + len - 1, Math.ceil(cy + r), Math.ceil(cz + r)] : [Math.ceil(cx + r), Math.ceil(cy + r), cz + len - 1],
          contains: (x, y, z) => { const [t, a, b] = split(x, y, z); return along(t, false) && disc(a, b) && up(x, y, z); },
          full: (x, y, z) => { const [, a, b] = split(x, y, z); return disc(a, b) || y < cy; },
        };
      }
      return {
        min: axis === 'y' ? [Math.floor(cx - r), cy, Math.floor(cz - r)] : axis === 'x' ? [cx, Math.floor(cy - r), Math.floor(cz - r)] : [Math.floor(cx - r), Math.floor(cy - r), cz],
        max: axis === 'y' ? [Math.ceil(cx + r), cy + len - 1, Math.ceil(cz + r)] : axis === 'x' ? [cx + len - 1, Math.ceil(cy + r), Math.ceil(cz + r)] : [Math.ceil(cx + r), Math.ceil(cy + r), cz + len - 1],
        contains: (x, y, z) => { const [t, a, b] = split(x, y, z); return along(t, false) && disc(a, b); },
        full: (x, y, z) => { const [t, a, b] = split(x, y, z); return disc(a, b) && (openBottom || t >= 0) && (openTop || t <= len - 1); },
      };
    }
    case 'cone':
    case 'pyramid': {
      const [cx, cy, cz] = need(nums, 'center', 3, line);
      const r = need(nums, 'radius', 1, line)[0];
      const h = need(nums, 'height', 1, line)[0];
      const down = flags.has('down');
      // 第 i 层（从底往尖数）的半径：底下是 r，越往上越小
      const level = (y: number) => (down ? cy - y : y - cy);
      const radiusAt = (i: number) => (r * (h - i)) / h;
      const inLayer = (x: number, z: number, i: number) => (kind === 'cone'
        ? sq(x - cx) + sq(z - cz) <= sq(radiusAt(i) + 0.5)
        : Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= radiusAt(i) + 0.5);
      return {
        min: [Math.floor(cx - r), down ? cy - h + 1 : cy, Math.floor(cz - r)],
        max: [Math.ceil(cx + r), down ? cy : cy + h - 1, Math.ceil(cz + r)],
        contains: (x, y, z) => { const i = level(y); return i >= 0 && i <= h - 1 && inLayer(x, z, i); },
        full: (x, y, z) => { const i = level(y); return (i >= 0 || openBottom) && i <= h - 1 && inLayer(x, z, Math.max(0, i)); },
      };
    }
    case 'line': {
      const a = need(nums, 'from', 3, line);
      const b = need(nums, 'to', 3, line);
      const steps = Math.max(1, ...a.map((v, k) => Math.abs(b[k] - v))) * 2;
      const cells = new Set<string>();
      for (let s = 0; s <= steps; s++) cells.add(a.map((v, k) => Math.round(v + ((b[k] - v) * s) / steps)).join(','));
      const has = (x: number, y: number, z: number) => cells.has(`${x},${y},${z}`);
      return {
        min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
        max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
        contains: has, full: has,
      };
    }
    default:
      throw new Error(`「${line}」：不认识的形状 ${kind}`);
  }
}

/** 楼梯对应的实心方块（屋脊默认用它）：oak_stairs → oak_planks，stone_brick_stairs → stone_bricks …… 不对的话 check-blocks 会说 */
function baseOfStairs(name: string): string {
  const b = name.replace(/_stairs$/, '');
  if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)$/.test(b)) return `${b}_planks`;
  if (/brick$/.test(b)) return `${b}s`;
  if (/tile$/.test(b)) return `${b}s`;
  if (b === 'purpur' || b === 'quartz') return `${b}_block`;
  return b;
}

type Cell = [number, number, number, string | null];

/**
 * 坡屋顶：在 from～to 这块地上用楼梯一层层往里收，每层高一格。楼梯朝向朝屋脊往上（北边那坡的楼梯朝南……），
 * 最上面剩一排时放屋脊方块；人字顶 fill 补两头的三角墙
 */
function roofCells(stairs: BlockSpec, ridge: BlockSpec, fill: BlockSpec | null, nums: Record<string, number[]>, flags: Set<string>, words: Record<string, string>, line: string): Cell[] {
  const [ax, y0, az] = need(nums, 'from', 3, line);
  const [bx, , bz] = need(nums, 'to', 3, line);
  const o = nums.overhang?.[0] ?? 0;
  const x1 = Math.min(ax, bx) - o, x2 = Math.max(ax, bx) + o, z1 = Math.min(az, bz) - o, z2 = Math.max(az, bz) + o;
  if (x2 - x1 + 1 > SHAPE_LIMITS.size || z2 - z1 + 1 > SHAPE_LIMITS.size) throw new Error(`「${line}」太大了`);
  const st = (facing: string) => specKey({ name: stairs.name, props: { ...stairs.props, facing, half: stairs.props.half ?? 'bottom' } });
  const R = specKey(ridge);
  const F = fill ? specKey(fill) : null;
  const out: Cell[] = [];
  if (flags.has('hip')) {
    for (let k = 0; ; k++) {
      const xa = x1 + k, xb = x2 - k, za = z1 + k, zb = z2 - k, y = y0 + k;
      if (xa > xb || za > zb) break;
      if (za === zb) { for (let x = xa; x <= xb; x++) out.push([x, y, za, R]); break; }
      if (xa === xb) { for (let z = za; z <= zb; z++) out.push([xa, y, z, R]); break; }
      for (let x = xa; x <= xb; x++) { out.push([x, y, za, st('south')]); out.push([x, y, zb, st('north')]); }
      for (let z = za + 1; z <= zb - 1; z++) { out.push([xa, y, z, st('east')]); out.push([xb, y, z, st('west')]); }
    }
    return out;
  }
  // 人字顶：屋脊默认顺着长边
  const axis = words.axis ?? (x2 - x1 >= z2 - z1 ? 'x' : 'z');
  if (axis !== 'x' && axis !== 'z') throw new Error(`「${line}」：屋顶的 axis 只能是 x 或 z（屋脊的方向）`);
  for (let k = 0; ; k++) {
    const y = y0 + k;
    if (axis === 'x') {
      const za = z1 + k, zb = z2 - k;
      if (za > zb) break;
      if (za === zb) { for (let x = x1; x <= x2; x++) out.push([x, y, za, R]); break; }
      for (let x = x1; x <= x2; x++) { out.push([x, y, za, st('south')]); out.push([x, y, zb, st('north')]); }
      if (F) for (let z = za + 1; z <= zb - 1; z++) { out.push([x1 + o, y, z, F]); out.push([x2 - o, y, z, F]); }
    } else {
      const xa = x1 + k, xb = x2 - k;
      if (xa > xb) break;
      if (xa === xb) { for (let z = z1; z <= z2; z++) out.push([xa, y, z, R]); break; }
      for (let z = z1; z <= z2; z++) { out.push([xa, y, z, st('east')]); out.push([xb, y, z, st('west')]); }
      if (F) for (let x = xa + 1; x <= xb - 1; x++) { out.push([x, y, z1 + o, F]); out.push([x, y, z2 - o, F]); }
    }
  }
  return out;
}

/** 镜像过去的方块：x 镜像东西对调、z 镜像南北对调；只镜像一个方向时左右对调（门的合页、楼梯的拐角） */
function flipKey(key: string, fx: boolean, fz: boolean): string {
  if (!key.includes('[') || (!fx && !fz)) return key;
  const SWAP: Record<string, string> = fx && fz ? { east: 'west', west: 'east', north: 'south', south: 'north' } : fx ? { east: 'west', west: 'east' } : { north: 'south', south: 'north' };
  return key.replace(/\[(.*)\]$/, (_m, inner: string) => `[${inner.split(',').map((kv) => {
    const [k, v] = kv.split('=');
    if (k === 'facing' && SWAP[v]) return `${k}=${SWAP[v]}`;
    if (fx !== fz && /left|right/.test(v)) return `${k}=${v.replace(/left|right/, (w) => (w === 'left' ? 'right' : 'left'))}`;
    return kv;
  }).join(',')}]`);
}

/** 方块名 → BlockSpec：oak_stairs[facing=north,half=top] */
function specOf(material: string): BlockSpec | string {
  const m = material.match(/^([a-z0-9_:]+)(?:\[([a-z0-9_=,]*)\])?$/i);
  if (!m) return `材料「${material}」看不懂（写方块名，可以带 [facing=north] 这样的状态）`;
  const props: Record<string, string> = {};
  for (const kv of (m[2] ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!k || !v) return `材料「${material}」的状态「${kv}」看不懂`;
    props[k] = v;
  }
  return { name: m[1].toLowerCase().replace(/^minecraft:/, ''), props };
}

const specKey = (s: BlockSpec) => `${s.name}${Object.keys(s.props).length ? `[${Object.entries(s.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`;

/**
 * 读形状图纸。lookup：按名字找已经存好的图纸（blueprint 那一行用）
 */
export function parseShapes(text: string, lookup: (name: string) => Blueprint | undefined): ShapeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const legend: Record<string, BlockSpec> = {};
  /** materials 里定义成 air 的名字（Z=air）：用它就是清成空气 */
  const airNames = new Set<string>(['air']);
  /** 格子 → 方块（specKey），'air' 是清成空气 */
  const cells = new Map<string, string>();
  const specs = new Map<string, BlockSpec>();
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/(\s|^)(\/\/|#\s).*$/, '').trim()).filter((l) => l && !l.startsWith('```'));
  let budget = SHAPE_LIMITS.blocks * 4;

  for (const line of lines) {
    const mats = line.match(/^(?:materials|材料)\s*[:：]\s*(.*)$/i);
    if (mats) {
      for (const pair of mats[1].split(/\s+/).filter(Boolean)) {
        const m = pair.match(/^([^=\s]+)=(.+)$/);
        if (!m) { errors.push(`materials 里的「${pair}」看不懂（写成 Q=quartz_block）`); continue; }
        if (m[2].toLowerCase() === 'air') { airNames.add(m[1]); continue; }
        const spec = specOf(m[2]);
        if (typeof spec === 'string') errors.push(spec);
        else legend[m[1]] = spec;
      }
      continue;
    }
    const parsed = parseLine(line);
    if (typeof parsed === 'string') { errors.push(parsed); continue; }
    const { cut, kind, material, nums, flags, words } = parsed;
    /** 这一行画出来的格子（null 是 cut 挖掉） */
    const drawn: Cell[] = [];
    const resolve = (m: string): BlockSpec | null | undefined | string => (airNames.has(m) || m.toLowerCase() === 'air' ? null : legend[m] ?? (m.length === 1 ? undefined : specOf(m)));

    // 放另一张图纸
    if (kind === 'blueprint') {
      const other = lookup(material!);
      const [ax, ay, az] = nums.at ?? [];
      if (!other) { errors.push(`「${line}」：没有叫「${material}」的图纸（先 design 存好）`); continue; }
      if (az === undefined) { errors.push(`「${line}」：要写 at x y z（那张图纸的西北角、最下面放在这里）`); continue; }
      const off = other.offset ?? { x: 0, y: 0, z: 0 };
      for (let k = 0; k < other.height; k++) for (let r = 0; r < other.depth; r++) for (let c = 0; c < other.width; c++) {
        const ch = other.layers[k]?.[r]?.[c] ?? ' ';
        if (ch === ' ') continue;
        const at = [ax + off.x + c, ay + off.y + k, az + off.z + r] as const;
        if (cut) { drawn.push([...at, null]); continue; }
        if (ch === '.') { drawn.push([...at, 'air']); continue; }
        const spec = other.legend[ch];
        specs.set(specKey(spec), spec);
        drawn.push([...at, specKey(spec)]);
      }
    } else if (kind === 'roof') {
      if (cut) { errors.push(`「${line}」：屋顶不能 cut`); continue; }
      const stairs = resolve(material!);
      if (stairs === undefined) { errors.push(`「${line}」：材料「${material}」不在 materials 里`); continue; }
      if (typeof stairs === 'string') { errors.push(stairs); continue; }
      if (!stairs || !/_stairs$/.test(stairs.name)) { errors.push(`「${line}」：屋顶的材料要是楼梯（比如 spruce_stairs、stone_brick_stairs）`); continue; }
      const ridge = words.ridge ? resolve(words.ridge) : { name: baseOfStairs(stairs.name), props: {} };
      const fill = words.fill ? resolve(words.fill) : null;
      if (ridge === undefined || fill === undefined || typeof ridge === 'string' || typeof fill === 'string' || ridge === null) { errors.push(`「${line}」：ridge / fill 的材料看不懂`); continue; }
      try {
        for (const c of roofCells(stairs, ridge, fill, nums, flags, words, line)) {
          drawn.push(c);
          const sp = specOf(c[3]!);
          if (typeof sp !== 'string') specs.set(c[3]!, sp);
        }
      } catch (err) {
        errors.push((err as Error).message);
        continue;
      }
    } else {
      let shape: Shape;
      try {
        shape = makeShape(kind, nums, flags, words, line);
      } catch (err) {
        errors.push((err as Error).message);
        continue;
      }
      const size = shape.max.map((v, k) => v - shape.min[k] + 1);
      if (size.some((s) => s > SHAPE_LIMITS.size)) { errors.push(`「${line}」太大了：${size.join(' × ')}，一个方向最多 ${SHAPE_LIMITS.size} 格`); continue; }
      const volume = size[0] * size[1] * size[2];
      budget -= volume;
      if (budget < 0) { errors.push('形状加起来太大了，算不过来（最多 100 万块）'); break; }

      let value: string | null = null;
      if (!cut) {
        const m = material!;
        const spec = resolve(m);
        if (spec === undefined) { errors.push(`「${line}」：材料「${m}」不在 materials 里`); continue; }
        if (typeof spec === 'string') { errors.push(spec); continue; }
        if (spec) specs.set(specKey(spec), spec);
        value = spec ? specKey(spec) : 'air';
      }
      const t = nums.hollow?.[0] ?? 0;
      // 挖空心：离「外面」t 步以内的才留下（6 个方向一步步走）
      const reach: [number, number, number][] = [];
      for (let dx = -t; dx <= t; dx++) for (let dy = -t; dy <= t; dy++) for (let dz = -t; dz <= t; dz++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= t && (dx || dy || dz)) reach.push([dx, dy, dz]);
      }
      for (let x = shape.min[0]; x <= shape.max[0]; x++) for (let y = shape.min[1]; y <= shape.max[1]; y++) for (let z = shape.min[2]; z <= shape.max[2]; z++) {
        if (!shape.contains(x, y, z)) continue;
        if (t > 0 && !reach.some(([dx, dy, dz]) => !shape.full(x + dx, y + dy, z + dz))) continue;
        drawn.push([x, y, z, cut ? null : value!]);
      }
    }

    // 重复、镜像
    const times = Math.max(1, Math.round(nums.repeat?.[0] ?? 1));
    if (nums.repeat && !nums.step) { errors.push(`「${line}」：repeat 要配 step dx dy dz（每份挪多少）`); continue; }
    const [sx, sy, sz] = nums.step ? [nums.step[0] ?? 0, nums.step[1] ?? 0, nums.step[2] ?? 0] : [0, 0, 0];
    const m = words.mirror ?? '';
    if (m && !/^(x|z|xz|zx)$/.test(m)) { errors.push(`「${line}」：mirror 只能是 x、z 或 xz`); continue; }
    const flips: [boolean, boolean][] = [[false, false]];
    if (m.includes('x')) flips.push([true, false]);
    if (m.includes('z')) flips.push([false, true]);
    if (m.includes('x') && m.includes('z')) flips.push([true, true]);
    budget -= drawn.length * times * flips.length;
    if (budget < 0) { errors.push('形状加起来太大了，算不过来（最多 100 万块）'); break; }
    for (let r = 0; r < times; r++) for (const [fx, fz] of flips) for (const [x, y, z, v] of drawn) {
      const key = `${(fx ? -x : x) + r * sx},${y + r * sy},${(fz ? -z : z) + r * sz}`;
      if (v === null) { cells.delete(key); continue; }
      const flipped = flipKey(v, fx, fz);
      if (flipped !== v && !specs.has(flipped)) { const sp = specOf(flipped); if (typeof sp !== 'string') specs.set(flipped, sp); }
      cells.set(key, flipped);
    }
  }
  if (errors.length) return { blueprint: null, errors, warnings };
  if (!cells.size) return { blueprint: null, errors: ['什么都没画出来（全被 cut 掉了，或者没写形状）'], warnings };

  // 格子 → 图纸（和字符图同一种结构，盖、虚影、投影都用同一套）
  const keys = [...cells.keys()].map((k) => k.split(',').map(Number));
  const min = [0, 1, 2].map((a) => Math.min(...keys.map((k) => k[a])));
  const max = [0, 1, 2].map((a) => Math.max(...keys.map((k) => k[a])));
  const [width, height, depth] = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  if (width > SHAPE_LIMITS.size || height > SHAPE_LIMITS.size || depth > SHAPE_LIMITS.size) {
    return { blueprint: null, errors: [`整个图纸太大了：宽 ${width} × 深 ${depth} × 高 ${height}，一个方向最多 ${SHAPE_LIMITS.size} 格`], warnings };
  }
  const solidCount = [...cells.values()].filter((v) => v !== 'air').length;
  if (solidCount > SHAPE_LIMITS.blocks) return { blueprint: null, errors: [`方块太多了：${solidCount} 块，最多 ${SHAPE_LIMITS.blocks} 块`], warnings };

  // 字符：她在 materials 里起的字母优先，别的从字符池里挑
  const charOf = new Map<string, string>();
  for (const [ch, spec] of Object.entries(legend)) if (ch.length === 1 && ch !== '.' && ch !== ' ' && specs.has(specKey(spec)) && !charOf.has(specKey(spec))) charOf.set(specKey(spec), ch);
  const used = new Set(charOf.values());
  const pool = [...POOL].filter((c) => !used.has(c));
  for (const key of specs.keys()) {
    if (charOf.has(key)) continue;
    const ch = pool.shift();
    if (!ch) return { blueprint: null, errors: ['用的方块种类太多了（最多 90 种）'], warnings };
    charOf.set(key, ch);
  }
  const outLegend: Record<string, BlockSpec> = {};
  for (const [key, ch] of charOf) outLegend[ch] = specs.get(key)!;
  const layers: string[][] = Array.from({ length: height }, () => Array.from({ length: depth }, () => ' '.repeat(width)));
  const rows = layers.map((rs) => rs.map((r) => r.split('')));
  for (const [key, v] of cells) {
    const [x, y, z] = key.split(',').map(Number);
    rows[y - min[1]][z - min[2]][x - min[0]] = v === 'air' ? '.' : charOf.get(v)!;
  }
  const grid = rows.map((rs) => rs.map((r) => r.join('')));

  // 会掉下来的：沙子、沙砾、混凝土粉末下面空着
  const falling = [...cells].filter(([key, v]) => {
    if (v === 'air' || !GRAVITY.test(specs.get(v)?.name ?? '')) return false;
    const [x, y, z] = key.split(',').map(Number);
    const below = cells.get(`${x},${y - 1},${z}`);
    return y > min[1] && (!below || below === 'air');
  });
  if (falling.length) warnings.push(`有 ${falling.length} 块沙子 / 沙砾 / 混凝土粉末下面是空的，放上去会掉下来`);

  return {
    blueprint: { layers: grid, legend: outLegend, width, depth, height, offset: { x: min[0], y: min[1], z: min[2] } },
    errors,
    warnings,
  };
}
