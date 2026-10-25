/**
 * 自保动作：躲到地下、逃开怪物、睡觉过夜。都是生存模式里玩家常用的保命办法，由身体直接用 mineflayer 做。
 */
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { MinecraftActionErrorCode, MinecraftActionResult } from './contracts.js';
import { patchedGoto } from './patchedGoto.js';
import { placeBlockAt } from './placeBlock.js';

/** 能用来封住头顶的方块 */
const SEAL_PREFERENCE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'coarse_dirt', 'gravel', 'sand'];
const LIQUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
const EMPTY = new Set(['air', 'cave_air', 'void_air']);

function done(started: number, summary: string, delta: Record<string, number> = {}): MinecraftActionResult {
  return { actionId: '', outcome: 'succeeded', summary, durationMs: Date.now() - started, inventoryDelta: delta, worldChanges: [], observations: [] };
}

function failed(started: number, code: MinecraftActionErrorCode, message: string, recoverable = true): MinecraftActionResult {
  return {
    actionId: '', outcome: 'failed', summary: message, durationMs: Date.now() - started, inventoryDelta: {}, worldChanges: [], observations: [],
    error: { code, recoverable, details: { message } },
  };
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

function sealItem(bot: any): any | null {
  const items: any[] = bot.inventory?.items?.() ?? [];
  for (const name of SEAL_PREFERENCE) {
    const hit = items.find((i) => i.name === name);
    if (hit) return hit;
  }
  return items.find((i) => i.name.endsWith('_planks')) ?? null;
}

async function waitUntil(check: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal?.aborted) return false;
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

function hostilesNear(bot: any, radius: number, match: (e: any) => boolean = (e) => e?.type === 'hostile'): any[] {
  const me = bot.entity?.position;
  if (!me) return [];
  return Object.values(bot.entities as Record<string, any>).filter((e) => e !== bot.entity && match(e) && e.position && e.position.distanceTo(me) <= radius);
}

/**
 * 原地往下挖三格钻进去，再把头顶封上。封口在地面那一层（洞口）：四周是地面的方块，新方块能贴着它们放；
 * 只挖两格的话封口在地面上面一格，平地上四周和下面都是空的，放不上去
 */
export async function hideUnderground(bot: any, signal: AbortSignal): Promise<MinecraftActionResult> {
  const started = Date.now();
  const seal = sealItem(bot);
  if (!seal) return failed(started, 'missing_item', 'need a block to seal the hole above (dirt, cobblestone, planks...)');
  const before = counts(bot);
  const feet: Vec3 = bot.entity.position.floored();
  const dig = [1, 2, 3].map((d) => bot.blockAt(feet.offset(0, -d, 0)));
  const floor = bot.blockAt(feet.offset(0, -4, 0));
  for (const b of dig) {
    if (!b) return failed(started, 'unsafe', 'the ground below is not loaded');
    if (LIQUID.has(b.name)) return failed(started, 'unsafe', `there is ${b.name} below, digging down here is dangerous`);
    if (b.name === 'bedrock') return failed(started, 'blocked', 'bedrock below, cannot dig down');
  }
  if (!floor || EMPTY.has(floor.name) || LIQUID.has(floor.name)) {
    return failed(started, 'unsafe', `there is ${floor?.name ?? 'nothing'} under the hole (a cave or liquid), would fall in`);
  }
  for (const b of dig) {
    if (signal.aborted) return failed(started, 'cancelled', 'cancelled');
    if (EMPTY.has(b.name)) continue;
    await bot.tool?.equipForBlock?.(b, {}).catch?.(() => {});
    if (!bot.canDigBlock(b)) return failed(started, 'missing_tool', `cannot dig ${b.name} here`);
    await bot.dig(b, true);
  }
  await waitUntil(() => bot.entity.position.y <= feet.y - 2.9, 4000, signal);
  try {
    await placeBlockAt(bot, seal, feet.offset(0, -1, 0), 'side', { signal });
  } catch (err) {
    return failed(started, 'blocked', `dug in but could not seal the top: ${(err as Error).message}`);
  }
  const at = bot.entity.position.floored();
  await new Promise((r) => setTimeout(r, 500));
  return done(started, `hid underground at ${at.x} ${at.y} ${at.z} and sealed the top with ${seal.name}; to come out go to ${feet.x} ${feet.y} ${feet.z}`, difference(before, counts(bot)));
}

/** 朝远离附近怪物的方向跑开 */
export async function fleeFromHostiles(bot: any, signal: AbortSignal, distance = 16, match?: (e: any) => boolean, safeRadius = 8): Promise<MinecraftActionResult> {
  const started = Date.now();
  const threats = hostilesNear(bot, 24, match);
  if (!threats.length) return done(started, 'no hostile mob within 24 blocks');
  const me: Vec3 = bot.entity.position;
  let dx = 0;
  let dz = 0;
  for (const t of threats) {
    const w = 1 / Math.max(1, t.position.distanceTo(me));
    dx += (me.x - t.position.x) * w;
    dz += (me.z - t.position.z) * w;
  }
  const len = Math.hypot(dx, dz) || 1;
  const target = { x: Math.round(me.x + (dx / len) * distance), z: Math.round(me.z + (dz / len) * distance) };
  bot.setControlState?.('sprint', true);
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNearXZ(target.x, target.z, 3)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flee timeout')), 15_000)),
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
    ]);
  } catch (err) {
    bot.pathfinder.setGoal(null);
    if (signal.aborted) return failed(started, 'cancelled', 'cancelled');
    const left = hostilesNear(bot, safeRadius, match).map((e) => e.name);
    if (!left.length) return done(started, `ran away (${(err as Error).message}); no hostile within ${safeRadius} blocks now`);
    return failed(started, 'blocked', `could not get away: ${(err as Error).message}; still near ${left.join(', ')}`);
  } finally {
    bot.setControlState?.('sprint', false);
  }
  const left = hostilesNear(bot, safeRadius, match).map((e) => e.name);
  if (left.length && match) return failed(started, 'unsafe', `ran ${distance} blocks but ${left.join(', ')} is still within ${safeRadius} blocks`);
  return done(started, `ran ${distance} blocks away from ${threats.map((t) => t.name).join(', ')}${left.length ? `; still near ${left.join(', ')}` : ''}`);
}

/** 睡觉：附近有床就去睡，没有就放下背包里的床；睡到天亮 */
export async function sleepInBed(bot: any, signal: AbortSignal): Promise<MinecraftActionResult> {
  const started = Date.now();
  const dimension = String(bot.game?.dimension ?? '');
  if (/nether|end/.test(dimension)) {
    return failed(started, 'unsafe', `did not put a bed down: in the ${dimension.includes('nether') ? 'Nether' : 'End'} a bed explodes when you try to sleep in it`);
  }
  let bed = bot.findBlock?.({ matching: (b: any) => bot.isABed?.(b), maxDistance: 24 });
  let placed: string | null = null;
  if (!bed) {
    const item = (bot.inventory?.items?.() ?? []).find((i: any) => i.name.endsWith('_bed'));
    if (!item) return failed(started, 'missing_item', 'no bed nearby and none in the inventory (a bed is crafted from 3 wool + 3 planks)');
    const feet: Vec3 = bot.entity.position.floored();
    const spots = [new Vec3(2, 0, 0), new Vec3(-2, 0, 0), new Vec3(0, 0, 2), new Vec3(0, 0, -2), new Vec3(2, 0, 1), new Vec3(-2, 0, -1)];
    for (const off of spots) {
      const target = feet.plus(off);
      const at = bot.blockAt(target);
      const ground = bot.blockAt(target.offset(0, -1, 0));
      if (!at || !EMPTY.has(at.name) || !ground || EMPTY.has(ground.name) || LIQUID.has(ground.name)) continue;
      try {
        await placeBlockAt(bot, item, target, 'bottom', { signal });
        bed = bot.findBlock?.({ matching: (b: any) => bot.isABed?.(b), maxDistance: 6 });
        if (bed) { placed = item.name; break; }
      } catch {
        // 换个地方再放
      }
    }
    if (!bed) return failed(started, 'blocked', `could not find a flat spot to put the ${item.name}`);
  }
  if (bed.position.distanceTo(bot.entity.position) > 2.5) {
    const r = await patchedGoto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { signal });
    if (!r.ok) return failed(started, 'path_unreachable', `cannot reach the bed at ${bed.position}`);
  }
  try {
    await bot.sleep(bed);
  } catch (err) {
    const msg = (err as Error).message;
    const code: MinecraftActionErrorCode = /monster/i.test(msg) ? 'unsafe' : 'blocked';
    return failed(started, code, `cannot sleep now: ${msg}`);
  }
  const woke = await waitUntil(() => !bot.isSleeping, 30_000, signal);
  return done(
    started,
    `${placed ? `put down a ${placed} and ` : ''}slept${woke ? ' until morning' : ' (still sleeping: everyone in the world has to sleep to skip the night)'}`,
    placed ? { [placed]: -1 } : {},
  );
}

const WATER = new Set(['water', 'flowing_water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

/** 在水里：找最近的能站的岸（实心方块，上面两格是空气），对着它游过去爬上去。寻路器在水里规划不好，这里手动划水 */
export async function swimToShore(bot: any, signal?: AbortSignal, timeoutMs = 12_000): Promise<boolean> {
  const inWater = () => {
    const p = bot.entity?.position;
    if (!p) return false;
    const feet = bot.blockAt(p.floored());
    const head = bot.blockAt(p.offset(0, 1, 0).floored());
    return WATER.has(feet?.name) || WATER.has(head?.name) || bot.entity.isInWater;
  };
  if (!inWater()) return true;
  const me: Vec3 = bot.entity.position.floored();
  let best: { target: Vec3; score: number } | null = null;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -2; dy <= 3; dy++) {
        const ground = bot.blockAt(me.offset(dx, dy, dz));
        if (!ground || ground.boundingBox !== 'block' || WATER.has(ground.name) || LIQUID.has(ground.name)) continue;
        const a1 = bot.blockAt(me.offset(dx, dy + 1, dz));
        const a2 = bot.blockAt(me.offset(dx, dy + 2, dz));
        if (!a1 || !a2 || !EMPTY.has(a1.name) || !EMPTY.has(a2.name)) continue;
        const score = Math.hypot(dx, dz) + Math.max(0, dy) * 1.5;
        if (!best || score < best.score) best = { target: me.offset(dx, dy + 1, dz), score };
      }
    }
  }
  if (!best) return false;
  const target = best.target.offset(0.5, 0, 0.5);
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end && !signal?.aborted) {
      const p = bot.entity.position;
      const flat = Math.hypot(target.x - p.x, target.z - p.z);
      if (!inWater() && bot.entity.onGround) return true;
      await bot.lookAt(target.offset(0, 1.2, 0), true);
      bot.setControlState('forward', flat > 0.3);
      bot.setControlState('jump', true);
      bot.setControlState('sprint', false);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    bot.clearControlStates?.();
  }
  return !inWater();
}
