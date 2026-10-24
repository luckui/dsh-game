/**
 * 图纸：她自己画的建筑。用字符图从下往上一层层画，配一张图例（一个字符 = 一种方块），身体照着图纸盖。
 *
 *   图例：
 *   # oak_planks
 *   L oak_log
 *   D oak_door facing=south
 *   . 空气
 *   第1层：
 *   L###L
 *   #...#
 *   第2层：
 *   ……
 *
 * 方向：每层的第一行在最北边，往下一行往南一格；每行从左到右是从西往东；第 1 层在最下面。
 * 「.」是空气：那格原来有东西（泥土、石头……）会挖掉；空格是不管：那格原来是什么就留着什么。
 * 盖的时候她给一个坐标，就是第 1 层第一行第一个字符（西北角、最下面）放在哪。
 * 这里只管读图纸、查问题、给她看投影和材料；方块名对不对由身体查（它有这个版本的方块表），盖由身体盖。
 */

export interface BlockSpec {
  name: string;
  /** 方块状态：facing（north / south / east / west）、half（top / bottom）、type（top / bottom，台阶） */
  props: Record<string, string>;
}

export interface Blueprint {
  /** 层 → 行 → 列：图例里的字符（'.' 是空气，要清空；' ' 是不管） */
  layers: string[][];
  legend: Record<string, BlockSpec>;
  width: number;
  depth: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  name: string;
  props: Record<string, string>;
}

/** 一次能盖的最大尺寸：宽（东西）、深（南北）、高 */
export const MAX_SIZE = { width: 16, depth: 16, height: 12 };
const AIR = new Set(['.', ' ']);
const FACINGS = new Set(['north', 'south', 'east', 'west']);
/** 两格高、放下面那格就会自己长出上面那格的方块 */
const TWO_TALL = /_door$|^tall_grass$|^large_fern$|^sunflower$|^lilac$|^rose_bush$|^peony$/;

export interface ParseResult {
  blueprint: Blueprint | null;
  /** 读不了的原因（读不了就没有 blueprint） */
  errors: string[];
  /** 读得了但要她知道的（行长短不一已补齐、悬空的方块……） */
  warnings: string[];
}

export function parseBlueprint(text: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const legend: Record<string, BlockSpec> = {};
  const layers: string[][] = [];
  let section: 'none' | 'legend' | 'layer' = 'none';
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(raw)) continue;
    const line = raw.replace(/\s+$/, '');
    const head = line.trim();
    if (/^(图例|legend)\s*[:：]?$/i.test(head)) {
      section = 'legend';
      continue;
    }
    const layerHead = head.match(/^(?:第\s*(\d+)\s*层|layer\s*(\d+))\s*[:：]?$/i);
    if (layerHead) {
      const n = Number(layerHead[1] ?? layerHead[2]);
      if (n !== layers.length + 1) warnings.push(`「${head}」不是按顺序来的，按第 ${layers.length + 1} 层算`);
      layers.push([]);
      section = 'layer';
      continue;
    }
    if (!head) continue;
    if (section === 'legend') {
      const m = head.match(/^(\S)\s*[=:：]?\s+([A-Za-z0-9_:]+)((?:\s+[a-z_]+=[a-z_0-9]+)*)\s*$/);
      if (!m) {
        // 「. 空气」这类说明空气的行
        if (/^[.\s]\s*(空气|air)?$/i.test(head) || /^\.\s/.test(head)) continue;
        errors.push(`图例这一行看不懂：「${head}」（要写成「字符 方块名」，比如「# oak_planks」，可以跟 facing=north 这样的状态）`);
        continue;
      }
      const [, ch, name, rest] = m;
      if (AIR.has(ch)) continue;
      const props: Record<string, string> = {};
      for (const kv of rest.trim().split(/\s+/).filter(Boolean)) {
        const [k, v] = kv.split('=');
        props[k] = v;
      }
      if (props.facing && !FACINGS.has(props.facing)) errors.push(`图例「${ch}」的 facing=${props.facing} 不对，只能是 north / south / east / west`);
      legend[ch] = { name: name.toLowerCase().replace(/^minecraft:/, ''), props };
      continue;
    }
    if (section === 'layer') {
      layers[layers.length - 1].push(line);
      continue;
    }
    errors.push(`「${head}」不在图例或某一层下面（先写「图例：」，再写「第1层：」「第2层：」……）`);
  }

  if (!layers.length) errors.push('没有画任何一层（写「第1层：」，下面一行行画）');
  const width = Math.max(0, ...layers.flat().map((row) => row.length));
  const depth = Math.max(0, ...layers.map((rows) => rows.length));
  const height = layers.length;
  if (width > MAX_SIZE.width || depth > MAX_SIZE.depth || height > MAX_SIZE.height) {
    errors.push(`太大了：宽 ${width} × 深 ${depth} × 高 ${height}，最大 ${MAX_SIZE.width} × ${MAX_SIZE.depth} × ${MAX_SIZE.height}`);
  }

  // 行的长短、层的行数不一样：用空气补齐，告诉她哪里不齐
  layers.forEach((rows, k) => {
    rows.forEach((row, r) => {
      if (row.length < width) warnings.push(`第${k + 1}层第${r + 1}行只有 ${row.length} 格，比最长的行少 ${width - row.length} 格（右边补的格子不管）`);
    });
    if (rows.length < depth) warnings.push(`第${k + 1}层只有 ${rows.length} 行，比别的层少 ${depth - rows.length} 行（下面补的格子不管）`);
  });
  const grid = layers.map((rows) => Array.from({ length: depth }, (_, r) => (rows[r] ?? '').padEnd(width, ' ')));

  const unknown = new Set<string>();
  for (const ch of grid.flat().join('')) if (!AIR.has(ch) && !legend[ch]) unknown.add(ch);
  if (unknown.size) errors.push(`图里用了图例里没有的字符：${[...unknown].map((c) => `「${c}」`).join('')}`);

  if (errors.length) return { blueprint: null, errors, warnings };
  const blueprint: Blueprint = { layers: grid, legend, width, depth, height };
  const floating = floatingBlocks(blueprint);
  if (floating.length) warnings.push(`有 ${floating.length} 块悬空（下面和四周都没有挨着的方块），身体会搭脚手架去放：${floating.slice(0, 6).join('、')}${floating.length > 6 ? '……' : ''}`);
  return { blueprint, errors, warnings };
}

function at(bp: Blueprint, k: number, r: number, c: number): string {
  return bp.layers[k]?.[r]?.[c] ?? ' ';
}

function solid(bp: Blueprint, k: number, r: number, c: number): boolean {
  return !AIR.has(at(bp, k, r, c));
}

/** 第 2 层以上、下面和四周都没有方块挨着的（第 1 层放在地上，不算） */
function floatingBlocks(bp: Blueprint): string[] {
  const out: string[] = [];
  for (let k = 1; k < bp.height; k++) {
    for (let r = 0; r < bp.depth; r++) {
      for (let c = 0; c < bp.width; c++) {
        if (!solid(bp, k, r, c)) continue;
        if (isTwoTallTop(bp, k, r, c)) continue;
        const touching = solid(bp, k - 1, r, c) || solid(bp, k + 1, r, c) || solid(bp, k, r - 1, c) || solid(bp, k, r + 1, c) || solid(bp, k, r, c - 1) || solid(bp, k, r, c + 1);
        if (!touching) out.push(`第${k + 1}层第${r + 1}行第${c + 1}格`);
      }
    }
  }
  return out;
}

/** 门这类两格高的东西：图上上下两格画同一个字符，上面那格是它自己长出来的，不用放 */
function isTwoTallTop(bp: Blueprint, k: number, r: number, c: number): boolean {
  const ch = at(bp, k, r, c);
  const spec = bp.legend[ch];
  return !!spec && TWO_TALL.test(spec.name) && k > 0 && at(bp, k - 1, r, c) === ch && !isTwoTallTop(bp, k - 1, r, c);
}

/** 要放的方块（门只放下面那格）；origin 是第 1 层第一行第一个字符（西北角、最下面）的坐标 */
export function placements(bp: Blueprint, origin: { x: number; y: number; z: number }): Placement[] {
  const out: Placement[] = [];
  for (let k = 0; k < bp.height; k++) {
    for (let r = 0; r < bp.depth; r++) {
      for (let c = 0; c < bp.width; c++) {
        const ch = at(bp, k, r, c);
        if (AIR.has(ch) || isTwoTallTop(bp, k, r, c)) continue;
        const spec = bp.legend[ch];
        out.push({ x: origin.x + c, y: origin.y + k, z: origin.z + r, name: spec.name, props: spec.props });
      }
    }
  }
  return out;
}

/** 要清成空气的格子（图上的「.」） */
export function clearCells(bp: Blueprint, origin: { x: number; y: number; z: number }): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let k = 0; k < bp.height; k++) {
    for (let r = 0; r < bp.depth; r++) {
      for (let c = 0; c < bp.width; c++) {
        if (at(bp, k, r, c) === '.') out.push({ x: origin.x + c, y: origin.y + k, z: origin.z + r });
      }
    }
  }
  return out;
}

/**
 * 虚影要放的格子：方块多了（超过 limit）只放外壳（从外面看得到的：六个方向里有一边挨着空的），里面看不见的不放
 */
export function ghostCells(bp: Blueprint, origin: { x: number; y: number; z: number }, limit = 600): Placement[] {
  const all = placements(bp, origin);
  if (all.length <= limit) return all;
  return all.filter((p) => {
    const k = p.y - origin.y;
    const r = p.z - origin.z;
    const c = p.x - origin.x;
    return !solid(bp, k - 1, r, c) || !solid(bp, k + 1, r, c) || !solid(bp, k, r - 1, c) || !solid(bp, k, r + 1, c) || !solid(bp, k, r, c - 1) || !solid(bp, k, r, c + 1);
  });
}

/** 要用的材料：方块名 → 个数（门按扇算） */
export function materials(bp: Blueprint): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of placements(bp, { x: 0, y: 0, z: 0 })) out[p.name] = (out[p.name] ?? 0) + 1;
  return out;
}

/** 投影：从南往北看（正面）、从东往西看（侧面）、从上往下看（俯视）；每格是离看的人最近的那块的字符 */
export function projections(bp: Blueprint): { front: string[]; side: string[]; top: string[] } {
  const front: string[] = [];
  const side: string[] = [];
  for (let k = bp.height - 1; k >= 0; k--) {
    let f = '';
    for (let c = 0; c < bp.width; c++) {
      let ch = '.';
      for (let r = bp.depth - 1; r >= 0; r--) if (solid(bp, k, r, c)) { ch = at(bp, k, r, c); break; }
      f += ch;
    }
    front.push(f);
    let s = '';
    // 从东往西看：左手边是南
    for (let r = bp.depth - 1; r >= 0; r--) {
      let ch = '.';
      for (let c = bp.width - 1; c >= 0; c--) if (solid(bp, k, r, c)) { ch = at(bp, k, r, c); break; }
      s += ch;
    }
    side.push(s);
  }
  const top: string[] = [];
  for (let r = 0; r < bp.depth; r++) {
    let t = '';
    for (let c = 0; c < bp.width; c++) {
      let ch = '.';
      for (let k = bp.height - 1; k >= 0; k--) if (solid(bp, k, r, c)) { ch = at(bp, k, r, c); break; }
      t += ch;
    }
    top.push(t);
  }
  return { front, side, top };
}

/** 交给她看的预览：尺寸、材料、三张投影、问题 */
export function describeBlueprint(name: string, bp: Blueprint, warnings: string[], unknownNames: string[]): string {
  const mats = materials(bp);
  const total = Object.values(mats).reduce((a, b) => a + b, 0);
  const { front, side, top } = projections(bp);
  const legend = Object.entries(bp.legend).map(([ch, s]) => `${ch}=${s.name}${Object.entries(s.props).map(([k, v]) => ` ${k}=${v}`).join('')}`).join('，');
  return [
    `图纸「${name}」：宽 ${bp.width}（东西）× 深 ${bp.depth}（南北）× 高 ${bp.height}，共 ${total} 块。`,
    `图例：${legend}`,
    `材料：${Object.entries(mats).map(([n, c]) => `${n} ×${c}`).join('，')}`,
    `正面（从南往北看，上面是高处）：\n${front.join('\n')}`,
    `侧面（从东往西看，左边是南）：\n${side.join('\n')}`,
    `俯视（从上往下看，上面是北）：\n${top.join('\n')}`,
    ...(unknownNames.length ? [`方块名不对：${unknownNames.join('；')}。改好图例再画一遍才能盖。`] : []),
    ...(warnings.length ? [`要注意：\n- ${warnings.join('\n- ')}`] : []),
  ].join('\n');
}

/** 参考图纸：常见建筑，她可以拿来照着改、换材料，或者推倒重画 */
export const TEMPLATES: Record<string, { title: string; text: string }> = {
  cabin: {
    title: '小木屋（7×6，门朝南，四扇窗，平顶）',
    text: `图例：
# oak_planks
L oak_log
G glass_pane
D oak_door facing=north
. 空气
第1层：
#######
#######
#######
#######
#######
#######
第2层：
L#####L
#.....#
#.....#
#.....#
#.....#
L##D##L
第3层：
L#G#G#L
#.....#
G.....G
#.....#
#.....#
L##D##L
第4层：
L#####L
#.....#
#.....#
#.....#
#.....#
L#####L
第5层：
#######
#######
#######
#######
#######
#######`,
  },
  tower: {
    title: '瞭望塔（5×5，高 8，门朝南，顶上有垛口）',
    text: `图例：
C cobblestone
D oak_door facing=north
. 空气
第1层：
CCCCC
CCCCC
CCCCC
CCCCC
CCCCC
第2层：
CCCCC
C...C
C...C
C...C
CCDCC
第3层：
CCCCC
C...C
C...C
C...C
CCDCC
第4层：
CCCCC
C...C
C...C
C...C
CCCCC
第5层：
CCCCC
C...C
C...C
C...C
CCCCC
第6层：
CCCCC
C...C
C...C
C...C
CCCCC
第7层：
CCCCC
CCCCC
CCCCC
CCCCC
CCCCC
第8层：
C.C.C
.....
C...C
.....
C.C.C`,
  },
  wall: {
    title: '一段围墙（9 长，3 高）',
    text: `图例：
C cobblestone
第1层：
CCCCCCCCC
第2层：
CCCCCCCCC
第3层：
C.C.C.C.C`,
  },
  bridge: {
    title: '木桥（3 宽，9 长，南北走向，两边有栏杆）',
    text: `图例：
# oak_planks
F oak_fence
. 空气
第1层：
###
###
###
###
###
###
###
###
###
第2层：
F.F
F.F
F.F
F.F
F.F
F.F
F.F
F.F
F.F`,
  },
  nether_portal: {
    title: '下界传送门门框（4×5 黑曜石，东西方向；用打火石点里面）',
    text: `图例：
O obsidian
. 空气
第1层：
OOOO
第2层：
O..O
第3层：
O..O
第4层：
O..O
第5层：
OOOO`,
  },
};
