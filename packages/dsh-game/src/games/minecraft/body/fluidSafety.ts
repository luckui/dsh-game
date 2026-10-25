import { Vec3 } from 'vec3';

const LIQUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const MAX_VERTICAL_FLOW_LOOKAHEAD = 32;
const FLUID_BREAK_GUARD = Symbol('hiyori-fluid-break-guard');

export interface ExcavationFluidRisk {
  unsafe: boolean;
  liquid?: string;
  source?: { x: number; y: number; z: number };
}

/**
 * Detects whether removing one block would open the excavated cell to a
 * liquid. A solid layer between a route and water remains safe; an open
 * vertical shaft to water does not.
 */
export function assessExcavationFluidRisk(
  bot: { blockAt(position: any): any },
  position: { x: number; y: number; z: number },
): ExcavationFluidRisk {
  const immediateSources = [
    offset(position, 0, 1, 0),
    offset(position, -1, 0, 0),
    offset(position, 1, 0, 0),
    offset(position, 0, 0, -1),
    offset(position, 0, 0, 1),
  ];
  for (const source of immediateSources) {
    const liquid = liquidName(bot.blockAt(source));
    if (liquid) return { unsafe: true, liquid, source };
  }

  // Covers the short world-update window where a water column has an open
  // shaft below it but the lower air blocks have not become flowing water yet.
  for (let dy = 1; dy <= MAX_VERTICAL_FLOW_LOOKAHEAD; dy += 1) {
    const source = offset(position, 0, dy, 0);
    const block = bot.blockAt(source);
    const liquid = liquidName(block);
    if (liquid) return { unsafe: true, liquid, source };
    if (!isFlowPassable(block)) break;
  }

  return { unsafe: false };
}

/**
 * Installs a deterministic A* break exclusion. Existing water traversal is
 * unaffected because only candidate blocks that would be excavated are
 * screened.
 */
export function protectMovementsFromFluid<T extends {
  exclusionAreasBreak?: Array<(block: any) => number>;
}>(bot: { blockAt(position: any): any }, movements: T): T {
  const tagged = movements as T & { [FLUID_BREAK_GUARD]?: boolean };
  if (tagged[FLUID_BREAK_GUARD]) return movements;
  tagged[FLUID_BREAK_GUARD] = true;
  movements.exclusionAreasBreak ??= [];
  movements.exclusionAreasBreak.push((block: any) => (
    block?.position && assessExcavationFluidRisk(bot, block.position).unsafe ? 100 : 0
  ));
  return movements;
}

function liquidName(block: any): string | undefined {
  const name = String(block?.name ?? '');
  return LIQUID_NAMES.has(name) ? name : undefined;
}

function isFlowPassable(block: any): boolean {
  if (!block) return false;
  const name = String(block.name ?? '');
  return name === 'air'
    || name === 'cave_air'
    || name === 'void_air'
    || block.boundingBox === 'empty';
}

function offset(
  position: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
): Vec3 {
  return new Vec3(position.x + x, position.y + y, position.z + z);
}

const FALL_BREAK_GUARD = Symbol('hiyori-fall-break-guard');
/** 挖掉一格后，它下面空着超过这么多格就不挖（寻路器自己最多往下跳 4 格） */
const MAX_SAFE_DROP = 3;

/** 这一格下面连着有几格是空的（看到 8 格为止；没加载的当作空的） */
export function dropBelow(bot: { blockAt(position: any): any }, position: { x: number; y: number; z: number }): number {
  let drop = 0;
  for (let d = 1; d <= 8; d++) {
    const b = bot.blockAt(offset(position, 0, -d, 0));
    if (b && (b.boundingBox === 'block' || liquidName(b))) break;
    drop += 1;
  }
  return drop;
}

/**
 * 寻路器为了够到下面的东西，会往下挖、或者往半空里垫方块搭过去再往下走：在浮空的平台、悬崖边、山洞顶上，
 * 挖穿了、没垫上就是从高处掉下去（测试时从 200 格高摔死过两次）。
 * 下面空着超过 3 格的地方：不挖，也不往那里垫方块（下面是水的不算空：水上搭桥照样可以）
 */
export function protectMovementsFromFalls<T extends {
  exclusionAreasBreak?: Array<(block: any) => number>;
  exclusionAreasPlace?: Array<(block: any) => number>;
}>(bot: { blockAt(position: any): any }, movements: T): T {
  const tagged = movements as T & { [FALL_BREAK_GUARD]?: boolean };
  if (tagged[FALL_BREAK_GUARD]) return movements;
  tagged[FALL_BREAK_GUARD] = true;
  const overDrop = (block: any) => !!block?.position && dropBelow(bot, block.position) > MAX_SAFE_DROP;
  movements.exclusionAreasBreak ??= [];
  movements.exclusionAreasBreak.push((block: any) => (overDrop(block) ? 100 : 0));
  movements.exclusionAreasPlace ??= [];
  movements.exclusionAreasPlace.push((block: any) => (overDrop(block) ? 1000 : 0));
  return movements;
}
