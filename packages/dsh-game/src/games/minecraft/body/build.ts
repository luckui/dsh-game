/**
 * 照图纸盖房子：游戏层把图纸换算成世界坐标交过来（每块放什么、哪些格子要清成空气），身体在后台盖完再报告。
 *
 *   1. 算材料：已经是对的方块不用再放；缺的直接报给她（去不去采由她定）
 *   2. 记下周围原来哪些格子是空的（盖完好认出脚手架）
 *   3. 清掉图纸上要是空气、现在有东西的格子
 *   4. 从下往上一层层放：先放实心的，门、火把这类贴着别的东西的最后放；够不着的地方寻路器自己垫方块爬上去；
 *      要朝向的方块（楼梯、门……）先转到那个方向再放
 *   5. 每块核对一遍；原来是空的、现在多出来的泥土圆石（脚手架）挖掉；捡掉落物
 * 盖的时候寻路器不能挖图纸上的格子、尽量不在图纸上的格子垫方块：不然走着走着会把刚盖的墙挖穿
 */
import { goals, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { MinecraftActionResult } from './contracts.js';
import { protectMovementsFromFalls, protectMovementsFromFluid } from './fluidSafety.js';
import { patchedGoto } from './patchedGoto.js';
import { isInteractive, isReplaceableForPlacement } from './placeBlock.js';

export interface BuildBlock {
  x: number;
  y: number;
  z: number;
  name: string;
  props: Record<string, string>;
}

export interface BuildRequest {
  label: string;
  blocks: BuildBlock[];
  /** 图纸上是空气（「.」）的格子：原来有东西就挖掉 */
  clear: { x: number; y: number; z: number }[];
  signal: AbortSignal;
}

export interface BuildHelpers {
  /** 在这个位置放这个物品（走过去、清障、找参考面、放、核对都在里面） */
  place(item: any, target: Vec3): Promise<void>;
  /** 挖掉一个方块（走过去、换工具） */
  dig(target: Vec3): Promise<void>;
  /** 捡附近的掉落物 */
  pickup(radius: number): Promise<void>;
  progress(text: string): void;
  /** 这一格已经是图纸上的方块了（虚影可以撤了） */
  placed(b: BuildBlock): void;
  log(text: string): void;
}

/** 贴着别的方块才立得住的：最后放 */
const ATTACHED = /_door$|torch$|_button$|^lever$|ladder$|_sign$|_banner$|_carpet$|_pressure_plate$|^lantern$|_bed$|flower_pot$/;
const SCAFFOLD = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']);
/** mineflayer 的 yaw：0 朝北，逆时针增加 */
const YAW: Record<string, number> = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

function done(started: number, outcome: MinecraftActionResult['outcome'], summary: string, delta: Record<string, number>, error?: MinecraftActionResult['error']): MinecraftActionResult {
  return { actionId: '', outcome, summary, durationMs: Date.now() - started, inventoryDelta: delta, worldChanges: [], observations: [], ...(error ? { error } : {}) };
}

function counts(bot: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of bot.inventory?.items?.() ?? []) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

function difference(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d) out[k] = d;
  }
  return out;
}

/** 这格现在是不是图纸要的方块（名字对，有朝向要求的话朝向也对） */
function matches(bot: any, b: BuildBlock): boolean {
  const now = bot.blockAt(new Vec3(b.x, b.y, b.z));
  if (!now || now.name !== b.name) return false;
  const props = now.getProperties?.() ?? {};
  return Object.entries(b.props).every(([k, v]) => props[k] === undefined || String(props[k]) === v);
}

function nameMatches(bot: any, b: BuildBlock): boolean {
  return bot.blockAt(new Vec3(b.x, b.y, b.z))?.name === b.name;
}

export async function buildStructure(bot: any, req: BuildRequest, helpers: BuildHelpers): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const registry = bot.registry;

  // 1. 方块名和材料
  const unknown = [...new Set(req.blocks.map((b) => b.name))].filter((n) => !registry?.blocksByName?.[n] || !registry?.itemsByName?.[n]);
  if (unknown.length) {
    return done(started, 'failed', `these are not blocks you can place in Minecraft ${bot.version}: ${unknown.join(', ')}`, {}, { code: 'unknown_item', recoverable: true, details: { unknown } });
  }
  const todo = req.blocks.filter((b) => !matches(bot, b));
  for (const b of req.blocks) if (!todo.includes(b)) helpers.placed(b);
  const need: Record<string, number> = {};
  for (const b of todo) if (!nameMatches(bot, b)) need[b.name] = (need[b.name] ?? 0) + 1;
  const missing = Object.entries(need).filter(([n, c]) => (before[n] ?? 0) < c).map(([n, c]) => `${n} ${c - (before[n] ?? 0)} more (need ${c}, have ${before[n] ?? 0})`);
  if (missing.length) {
    return done(started, 'failed', `not enough materials to build ${req.label}: ${missing.join('; ')}`, {}, { code: 'missing_item', recoverable: true, details: { missing: need } });
  }

  // 2. 记下周围原来空着的格子（盖完认脚手架用）
  const all = [...req.blocks, ...req.clear];
  const min = { x: Math.min(...all.map((b) => b.x)) - 3, y: Math.min(...all.map((b) => b.y)) - 1, z: Math.min(...all.map((b) => b.z)) - 3 };
  const max = { x: Math.max(...all.map((b) => b.x)) + 3, y: Math.max(...all.map((b) => b.y)) + 3, z: Math.max(...all.map((b) => b.z)) + 3 };
  const emptyBefore = new Set<string>();
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b || isReplaceableForPlacement(b)) emptyBefore.add(key({ x, y, z }));
  }

  // 寻路器：不挖图纸上的格子、尽量不在图纸上垫方块；能垫泥土圆石爬上去
  const planned = new Set(all.map(key));
  /** 要放方块的格子（垫柱子不能占；图纸上的空气格可以临时垫，盖完拆掉） */
  const solidCells = new Set(req.blocks.map(key));
  /** 给悬空的格子垫的临时柱子（盖完拆掉） */
  const supports: Vec3[] = [];
  const oldMovements = bot.pathfinder.movements;
  const movements = protectMovementsFromFalls(bot, protectMovementsFromFluid(bot, new Movements(bot)));
  movements.allowParkour = false;
  movements.exclusionAreasBreak.push((block: any) => (planned.has(key(block.position)) ? 100 : 0));
  movements.exclusionAreasPlace.push((block: any) => (planned.has(key(block.position)) ? 1000 : 0));
  bot.pathfinder.setMovements(movements);

  const failed: string[] = [];
  const wrongFacing: string[] = [];
  try {
    // 3. 清掉要是空气的格子
    for (const c of req.clear) {
      if (req.signal.aborted) throw new Error('cancelled');
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
      if (b && !isReplaceableForPlacement(b) && b.name !== 'bedrock') {
        await helpers.dig(new Vec3(c.x, c.y, c.z)).catch((err: Error) => helpers.log(`[build] could not clear ${b.name} at ${key(c)}: ${err.message}`));
      }
    }

    // 4. 一层层放：实心的在前，贴着放的最后
    const layers = [...new Set(todo.map((b) => b.y))].sort((a, b) => a - b);
    const solid = todo.filter((b) => !ATTACHED.test(b.name));
    const attached = todo.filter((b) => ATTACHED.test(b.name));
    for (const [i, y] of layers.entries()) {
      const row = solid.filter((b) => b.y === y);
      // 先放已经有东西挨着的（不然没处贴着放，比如屋顶要从墙头往里铺），其中离自己近的先放
      while (row.length) {
        if (req.signal.aborted) throw new Error('cancelled');
        const me = bot.entity.position;
        const rank = (b: BuildBlock) => (hasNeighbour(bot, b) ? 0 : 1000) + me.distanceTo(new Vec3(b.x, b.y, b.z));
        row.sort((a, b) => rank(a) - rank(b));
        const b = row.shift()!;
        await placeOne(bot, b, helpers, solidCells, supports).then(() => helpers.placed(b), (err: Error) => failed.push(`${b.name} at ${key(b)} (${err.message})`));
      }
      helpers.progress(`${req.label}: layer ${i + 1}/${layers.length} done`);
    }
    for (const b of attached) {
      if (req.signal.aborted) throw new Error('cancelled');
      await placeOne(bot, b, helpers, solidCells, supports).then(() => helpers.placed(b), (err: Error) => failed.push(`${b.name} at ${key(b)} (${err.message})`));
    }
    // 补一遍：没放上的（当时没处贴着放、放偏了……）现在周围多半有东西了，再放一次
    const retry = req.blocks.filter((b) => !nameMatches(bot, b));
    if (retry.length) {
      failed.length = 0;
      retry.sort((a, b) => a.y - b.y);
      for (const b of retry) {
        if (req.signal.aborted) throw new Error('cancelled');
        await placeOne(bot, b, helpers, solidCells, supports).then(() => helpers.placed(b), (err: Error) => failed.push(`${b.name} at ${key(b)} (${err.message})`));
      }
    }
  } catch (err) {
    bot.pathfinder.setMovements(oldMovements);
    if (req.signal.aborted) return done(started, 'cancelled', 'stopped building', difference(before, counts(bot)));
    throw err;
  }

  // 5. 核对；拆脚手架（从上往下拆；够不着高处时寻路器还会垫方块，所以拆完再看一遍，最多三遍）；捡东西
  const missingNow = req.blocks.filter((b) => !nameMatches(bot, b));
  for (const b of req.blocks) {
    if (nameMatches(bot, b) && !matches(bot, b)) wrongFacing.push(`${b.name} at ${key(b)} (wanted ${Object.entries(b.props).map(([k, v]) => `${k}=${v}`).join(' ')})`);
  }
  let scaffold = 0;
  try {
    for (let pass = 0; pass < 3; pass++) {
      let found = 0;
      for (let y = max.y; y >= min.y; y--) for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) {
        const p = { x, y, z };
        if (!emptyBefore.has(key(p)) || planned.has(key(p))) continue;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && SCAFFOLD.has(b.name)) {
          found += 1;
          await helpers.dig(new Vec3(x, y, z)).then(() => { scaffold += 1; }).catch(() => {});
        }
      }
      if (!found) break;
    }
    // 垫在悬空格子下面的柱子（可能在图纸范围外面）：从上往下拆
    for (const p of supports.sort((a, b) => b.y - a.y)) {
      const b = bot.blockAt(p);
      if (b && SCAFFOLD.has(b.name)) await helpers.dig(p).then(() => { scaffold += 1; }).catch(() => {});
    }
    await helpers.pickup(12).catch(() => {});
  } finally {
    bot.pathfinder.setMovements(oldMovements);
  }

  const placed = req.blocks.length - missingNow.length;
  const notes = [
    scaffold ? `took down ${scaffold} scaffolding block(s)` : '',
    wrongFacing.length ? `${wrongFacing.length} placed facing the wrong way: ${wrongFacing.slice(0, 5).join('; ')}` : '',
    missingNow.length ? `${missingNow.length} not placed: ${(failed.length ? failed : missingNow.map((b) => `${b.name} at ${key(b)}`)).slice(0, 6).join('; ')}` : '',
  ].filter(Boolean).join('; ');
  const summary = `${req.label}: ${placed}/${req.blocks.length} blocks in place${notes ? `; ${notes}` : ''}`;
  return done(started, missingNow.length ? 'partial' : 'succeeded', summary, difference(before, counts(bot)));
}

const SIDES = [new Vec3(0, -1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, 0)];

/** 旁边有能贴着放的方块 */
function hasNeighbour(bot: any, b: BuildBlock): boolean {
  const target = new Vec3(b.x, b.y, b.z);
  return SIDES.some((f) => {
    const n = bot.blockAt(target.plus(f));
    return n && !isReplaceableForPlacement(n);
  });
}

/**
 * 这一格悬空（六面都没东西能贴着放，比如门框两边竖边最底下那块在空着的角上面）：
 * 在它下面垫一根临时的柱子，从下面的实心方块一直垫到它下面那格；柱子不占图纸上的格子，最多垫 6 格高
 */
async function propUp(bot: any, b: BuildBlock, helpers: BuildHelpers, planned: Set<string>, supports: Vec3[]): Promise<void> {
  const column: Vec3[] = [];
  for (let y = b.y - 1; y >= b.y - 6; y--) {
    const p = new Vec3(b.x, y, b.z);
    const at = bot.blockAt(p);
    if (!at) break;
    if (!isReplaceableForPlacement(at)) {
      column.reverse();
      for (const q of column) {
        const filler = bot.inventory.items().find((i: any) => SCAFFOLD.has(i.name));
        if (!filler) throw new Error('it would float, and there is no dirt or cobblestone to prop it up with');
        await helpers.place(filler, q);
        supports.push(q);
      }
      return;
    }
    if (planned.has(key(p))) break;
    column.push(p);
  }
  throw new Error('it would float with nothing within 6 blocks below to prop it up on');
}

/** 放一块：有朝向要求的自己转好方向再放，别的交给 helpers.place */
async function placeOne(bot: any, b: BuildBlock, helpers: BuildHelpers, planned: Set<string>, supports: Vec3[]): Promise<void> {
  if (matches(bot, b)) return;
  const item = bot.inventory.items().find((i: any) => i.name === b.name);
  if (!item) throw new Error(`no ${b.name} left`);
  const target = new Vec3(b.x, b.y, b.z);
  if (!hasNeighbour(bot, b)) await propUp(bot, b, helpers, planned, supports);
  if (!b.props.facing && !b.props.half && !b.props.type) {
    await helpers.place(item, target);
    // 放方块的函数在目标附近找到同样的方块就算放好了：这里要的是正好这一格
    if (!nameMatches(bot, b)) throw new Error('it landed somewhere else');
    return;
  }
  // 要朝向的：走到旁边，找一个能贴着放的面，转到要的方向，不让放方块时再转头
  const now = bot.blockAt(target);
  if (now && !isReplaceableForPlacement(now)) await helpers.dig(target);
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4) {
    const r = await patchedGoto(bot, new goals.GoalNear(b.x, b.y, b.z, 3), {});
    if (!r.ok) throw new Error(`cannot get near: ${r.message}`);
  }
  const ref = SIDES
    .map((f) => ({ block: bot.blockAt(target.plus(f)), face: f.scaled(-1) }))
    .find((c) => c.block && !isReplaceableForPlacement(c.block) && !isInteractive(c.block));
  if (!ref) throw new Error('nothing next to it to place against');
  await bot.equip(item, 'hand');
  if (b.props.facing) {
    // 新的朝向要等下一个物理帧才发给服务器：放方块的包不能比它先到，不然服务器按旧的朝向放
    await bot.look(YAW[b.props.facing], 0, true);
    await bot.waitForTicks(2);
  }
  const half = b.props.half === 'top' || b.props.type === 'top' ? 'top' : b.props.half === 'bottom' || b.props.type === 'bottom' ? 'bottom' : undefined;
  await bot._placeBlockWithOptions(ref.block, ref.face, { forceLook: 'ignore', ...(half ? { half } : {}) });
  await new Promise((r) => setTimeout(r, 250));
  if (!nameMatches(bot, b)) throw new Error('the server did not place it');
}
