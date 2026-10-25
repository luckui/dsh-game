/**
 * 地形俯视图（look）：她看不到周围的地形，只能一样样 find 去猜，选地方会选到海里。给她一张俯视图加几行文字：
 *
 *   图：每一列一个小方格，按地面方块的颜色上色（水蓝、岩浆橙），越高越亮、朝北朝西的坡暗一点；每 8 格一条细线；中间红圈是她；
 *       找到的平地用黄、青、品红的方框圈出来
 *   字：她在哪、脚下是什么（在水里会说水面在哪）；水占多少、地面高低；平地在哪、多大、多高
 *
 * 平地：边长 17 / 13 / 9 格的正方形里高低差不超过 1、没有水和树叶；大的优先，一样大的离她近的优先，最多 3 块、互不重叠。
 */
import type { TerrainScan } from './body/terrain.js';
import { encodePng, type BlockColors } from './preview.js';

export interface FlatSpot {
  /** 中心那一列（站上去的高度是 y + 1） */
  x: number;
  y: number;
  z: number;
  size: number;
  block: string;
}

const LIQUID = new Set(['water', 'lava']);
const SPOT_COLORS: [number, number, number][] = [[255, 214, 0], [0, 220, 230], [235, 60, 220]];
const SPOT_NAMES = ['黄框', '青框', '品红框'];

export function findFlatSpots(t: TerrainScan, sizes = [17, 13, 9], max = 3): FlatSpot[] {
  const h = (x: number, z: number) => t.heights[z * t.size + x];
  const b = (x: number, z: number) => t.blocks[z * t.size + x];
  const spots: (FlatSpot & { dist: number; box: [number, number, number, number] })[] = [];
  const meX = t.me.x - t.x0, meZ = t.me.z - t.z0;
  for (const k of sizes) {
    const found: typeof spots = [];
    for (let z = 0; z + k <= t.size; z += 2) for (let x = 0; x + k <= t.size; x += 2) {
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let dz = 0; dz < k && ok; dz++) for (let dx = 0; dx < k; dx++) {
        const v = h(x + dx, z + dz);
        const name = b(x + dx, z + dz);
        if (v === null || LIQUID.has(name) || /leaves|void|unloaded/.test(name)) { ok = false; break; }
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        if (hi - lo > 1) { ok = false; break; }
      }
      if (!ok) continue;
      const cx = x + (k >> 1), cz = z + (k >> 1);
      found.push({ x: t.x0 + cx, y: hi, z: t.z0 + cz, size: k, block: b(cx, cz), dist: Math.hypot(cx - meX, cz - meZ), box: [x, z, x + k - 1, z + k - 1] });
    }
    found.sort((p, q) => p.dist - q.dist);
    for (const f of found) {
      if (spots.length >= max) break;
      if (spots.some((s) => f.box[0] <= s.box[2] && f.box[2] >= s.box[0] && f.box[1] <= s.box[3] && f.box[3] >= s.box[1])) continue;
      spots.push(f);
    }
    if (spots.length >= max) break;
  }
  return spots.map(({ dist: _d, box: _b, ...s }) => s);
}

function fallbackColor(name: string): [number, number, number] {
  if (/grass|moss/.test(name)) return [110, 160, 70];
  if (/leaves/.test(name)) return [60, 120, 40];
  if (/sand/.test(name)) return [220, 210, 160];
  if (/snow|ice/.test(name)) return [235, 240, 250];
  if (/dirt|mud|podzol/.test(name)) return [130, 95, 65];
  if (/log|planks|wood/.test(name)) return [150, 115, 70];
  return [130, 130, 130];
}

/** 地形俯视图（PNG）：每列 cell 像素 */
export function renderTerrain(t: TerrainScan, colors: BlockColors | null, spots: FlatSpot[], cell = 8): Buffer {
  const W = t.size * cell;
  const img = new Uint8Array(W * W * 3);
  const h = (x: number, z: number) => (x < 0 || z < 0 || x >= t.size || z >= t.size ? null : t.heights[z * t.size + x]);
  for (let z = 0; z < t.size; z++) for (let x = 0; x < t.size; x++) {
    const name = t.blocks[z * t.size + x];
    const v = h(x, z);
    let rgb: [number, number, number] = name === 'water' ? [62, 118, 228] : name === 'lava' ? [235, 100, 20] : name === 'unloaded' ? [40, 40, 40] : name === 'void' ? [15, 15, 25] : colors ? colors.of(name).top : fallbackColor(name);
    let f = 1;
    if (v !== null && !LIQUID.has(name)) {
      f = Math.max(0.55, Math.min(1.35, 1 + (v - t.me.y) * 0.025));
      const n = h(x, z - 1), w = h(x - 1, z);
      if ((n !== null && n > v) || (w !== null && w > v)) f *= 0.82;
      if ((n !== null && n < v) || (w !== null && w < v)) f *= 1.1;
    }
    rgb = rgb.map((c) => Math.max(0, Math.min(255, c * f))) as [number, number, number];
    for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) {
      const o = ((z * cell + py) * W + x * cell + px) * 3;
      const line = ((t.x0 + x) % 8 === 0 && px === 0) || ((t.z0 + z) % 8 === 0 && py === 0);
      const k = line ? 0.8 : 1;
      img[o] = rgb[0] * k; img[o + 1] = rgb[1] * k; img[o + 2] = rgb[2] * k;
    }
  }
  const box = (x1: number, z1: number, x2: number, z2: number, rgb: [number, number, number], width: number) => {
    for (let px = x1 * cell; px < (x2 + 1) * cell; px++) for (let py = z1 * cell; py < (z2 + 1) * cell; py++) {
      const edge = px - x1 * cell < width || (x2 + 1) * cell - 1 - px < width || py - z1 * cell < width || (z2 + 1) * cell - 1 - py < width;
      if (!edge || px < 0 || py < 0 || px >= W || py >= W) continue;
      const o = (py * W + px) * 3;
      img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2];
    }
  };
  spots.forEach((s, i) => {
    const cx = s.x - t.x0, cz = s.z - t.z0, r = s.size >> 1;
    box(cx - r, cz - r, cx + r, cz + r, SPOT_COLORS[i], 2);
  });
  // 她：红色的圈
  const mx = t.me.x - t.x0, mz = t.me.z - t.z0;
  box(mx - 1, mz - 1, mx + 1, mz + 1, [230, 30, 30], 3);
  return encodePng(W, W, img);
}

export function describeTerrain(t: TerrainScan, spots: FlatSpot[]): string {
  const all = t.blocks.length;
  const water = t.blocks.filter((b) => b === 'water').length;
  const land = t.heights.filter((v, i) => v !== null && !LIQUID.has(t.blocks[i]));
  const lo = land.length ? Math.min(...(land as number[])) : null;
  const hi = land.length ? Math.max(...(land as number[])) : null;
  const meIdx = (t.me.z - t.z0) * t.size + (t.me.x - t.x0);
  const under = t.blocks[meIdx];
  const ground = t.heights[meIdx];
  const where = under === 'water' && ground !== null
    ? `你在水里：这一列水面在 y=${ground}，你在 y=${t.me.y}（水下 ${Math.max(0, ground - t.me.y + 1)} 格）`
    : `你在 (${t.me.x}, ${t.me.y}, ${t.me.z})，这一列地面是 ${under}（y=${ground}）`;
  const lines = [
    `周围的地形：以你为中心 ${t.size}×${t.size} 格（x ${t.x0}～${t.x0 + t.size - 1}，z ${t.z0}～${t.z0 + t.size - 1}）。${where}。`,
    `水占 ${Math.round((water / all) * 100)}%${lo !== null ? `；地面高度 ${lo}～${hi}` : '；附近没有陆地'}。`,
    spots.length
      ? `平地（站上去是地面高度 + 1）：${spots.map((s, i) => `${SPOT_NAMES[i]}：中心 (${s.x}, ${s.y + 1}, ${s.z})，${s.size}×${s.size}，地面是 ${s.block}`).join('；')}。`
      : '附近没有 9×9 以上的平地。',
    `附了一张俯视图：上面是北、右边是东，一个小方格是一列（一格），细线每 8 格一条（x、z 是 8 的倍数的地方），中间红圈是你；颜色是地面方块的颜色，水是蓝的，越亮越高。`,
  ];
  return lines.join('\n');
}
