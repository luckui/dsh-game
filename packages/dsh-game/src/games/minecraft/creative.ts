/**
 * 创造模式盖房子：不走身体一块块放，用 RCON 从下往上一层层放（像 WorldEdit），看的人看得到建筑一层层长出来。
 * 生存模式还是身体一块块放（body/build.ts）。
 *
 *   - 每层按行（同一个 z）把连着的同一种方块并成一条 fill，一个的用 setblock
 *   - 门这类两格高的：图上上下两格画同一个字符，下面放 half=lower，上面放 half=upper（setblock 不会自己长出另一半）
 *   - 图上的「.」放空气（清掉原来的东西），空格不动
 *   - 盖的范围先 forceload（离她远的那头区块可能没加载，放不上），盖完放开
 *   - 每层之间停一下：层数少停得久一点（看得出在长，十几层的房子大约十秒），整座最多一分钟左右
 */
import type { Blueprint } from './blueprint.js';
import { rconBatch, type RconTarget } from './rcon.js';

const TWO_TALL = /_door$|^tall_grass$|^large_fern$|^sunflower$|^lilac$|^rose_bush$|^peony$/;

export interface CreativeProgress {
  /** 刚放完的那一层的世界 y */
  y: number;
  index: number;
  total: number;
}

export interface CreativeResult {
  placed: number;
  layers: number;
  /** 放不上的（区块没加载、方块名或状态不对……）：前几条原因 */
  failed: string[];
  stopped: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 图里西北角、最下面那格的世界坐标 */
export function worldBase(bp: Blueprint, origin: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: origin.x + (bp.offset?.x ?? 0), y: origin.y + (bp.offset?.y ?? 0), z: origin.z + (bp.offset?.z ?? 0) };
}

function blockText(bp: Blueprint, k: number, r: number, c: number): string | null {
  const ch = bp.layers[k]?.[r]?.[c] ?? ' ';
  if (ch === ' ') return null;
  if (ch === '.') return 'air';
  const spec = bp.legend[ch];
  const props = { ...spec.props };
  if (TWO_TALL.test(spec.name)) {
    // 往下数连着几个同样的字符：奇数个就是上半扇
    let n = 0;
    while (bp.layers[k - 1 - n]?.[r]?.[c] === ch) n += 1;
    props.half = n % 2 === 1 ? 'upper' : 'lower';
  }
  const state = Object.entries(props).map(([key, v]) => `${key}=${v}`).join(',');
  return `${spec.name}${state ? `[${state}]` : ''}`;
}

/** 区块范围（forceload 一次最多 256 个区块：大了分几块） */
function chunkBoxes(x1: number, z1: number, x2: number, z2: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const step = 16 * 16;
  for (let x = x1; x <= x2; x += step) for (let z = z1; z <= z2; z += step) out.push([x, z, Math.min(x2, x + step - 1), Math.min(z2, z + step - 1)]);
  return out;
}

export async function placeLayers(
  target: RconTarget,
  bp: Blueprint,
  origin: { x: number; y: number; z: number },
  options: { signal: AbortSignal; onLayer?: (p: CreativeProgress) => void },
): Promise<CreativeResult> {
  const base = worldBase(bp, origin);
  const boxes = chunkBoxes(base.x, base.z, base.x + bp.width - 1, base.z + bp.depth - 1);
  await rconBatch(target, boxes.map(([a, b, c, d]) => `forceload add ${a} ${b} ${c} ${d}`), 15_000).catch(() => {});
  const delay = Math.max(60, Math.min(800, Math.floor(45_000 / Math.max(1, bp.height))));
  const failed: string[] = [];
  let placed = 0;
  let stopped = false;
  try {
    for (let k = 0; k < bp.height; k++) {
      if (options.signal.aborted) { stopped = true; break; }
      const y = base.y + k;
      const commands: string[] = [];
      for (let r = 0; r < bp.depth; r++) {
        const z = base.z + r;
        let c = 0;
        while (c < bp.width) {
          const block = blockText(bp, k, r, c);
          if (!block) { c += 1; continue; }
          let end = c;
          while (end + 1 < bp.width && blockText(bp, k, r, end + 1) === block) end += 1;
          commands.push(end === c ? `setblock ${base.x + c} ${y} ${z} ${block}` : `fill ${base.x + c} ${y} ${z} ${base.x + end} ${y} ${z} ${block}`);
          c = end + 1;
        }
      }
      for (let i = 0; i < commands.length; i += 300) {
        const batch = commands.slice(i, i + 300);
        const replies = await rconBatch(target, batch, 30_000).catch((err: Error) => batch.map(() => `error: ${err.message}`));
        replies.forEach((reply, j) => {
          const filled = reply.match(/(?:filled|填充了?)\s*(\d+)/i);
          if (filled) placed += Number(filled[1]);
          else if (/Changed the block|已更改/i.test(reply)) placed += 1;
          else if (/Could not set the block|No blocks were filled|没有方块被填充|无法放置/i.test(reply)) { /* 本来就是这个方块 */ }
          else if (!reply.trim()) { /* 服务器偶尔不回话（多半是放上了）：不算放不上 */ }
          else if (failed.length < 5) failed.push(`${batch[j].split(' ').slice(0, 4).join(' ')}: ${reply.trim() || 'no reply'}`);
        });
      }
      options.onLayer?.({ y, index: k + 1, total: bp.height });
      if (k < bp.height - 1) await sleep(delay);
    }
  } finally {
    await rconBatch(target, boxes.map(([a, b, c, d]) => `forceload remove ${a} ${b} ${c} ${d}`), 15_000).catch(() => {});
  }
  return { placed, layers: bp.height, failed, stopped };
}
