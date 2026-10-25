/**
 * 周围的地形（look 的身体部分）：以她为中心 (2r+1)×(2r+1) 格，每一列从上往下找第一块地面（实心方块、水、岩浆，树叶也算），
 * 记下高度和是什么方块。没加载的列高度是 null。
 */
import { Vec3 } from 'vec3';
export interface TerrainScan {
  /** 左上角（西北角）那一列的 x、z */
  x0: number;
  z0: number;
  size: number;
  /** 一行行（z 从北到南）、每行从西到东：地面那一格的 y；null 是没加载 */
  heights: (number | null)[];
  /** 地面那一格的方块名 */
  blocks: string[];
  me: { x: number; y: number; z: number };
}

export function scanTerrain(bot: any, radius: number): TerrainScan {
  const me = bot.entity.position.floored();
  const size = radius * 2 + 1;
  const x0 = me.x - radius;
  const z0 = me.z - radius;
  const top = Math.min(me.y + 64, 319);
  const bottom = Math.max(me.y - 64, -64);
  const heights: (number | null)[] = [];
  const blocks: string[] = [];
  for (let dz = 0; dz < size; dz++) for (let dx = 0; dx < size; dx++) {
    let found: { y: number; name: string } | null = null;
    let loaded = false;
    for (let y = top; y >= bottom; y--) {
      const b = bot.blockAt(new Vec3(x0 + dx, y, z0 + dz));
      if (!b) continue;
      loaded = true;
      if (b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava') { found = { y, name: b.name }; break; }
    }
    heights.push(found ? found.y : loaded ? bottom : null);
    blocks.push(found ? found.name : loaded ? 'void' : 'unloaded');
  }
  return { x0, z0, size, heights, blocks, me: { x: me.x, y: me.y, z: me.z } };
}
