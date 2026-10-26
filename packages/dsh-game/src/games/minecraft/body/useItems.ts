/**
 * 手里拿着东西对着世界用一下（右键）：她决定用什么、对着哪一格；身体走过去、换到手上、瞄准、用，再看那一格和旁边变成了什么。
 *
 *   useBucket   空桶：装起那一格的水或岩浆（要是源头，流动的装不起来）
 *               水桶 / 岩浆桶：倒在那一格（那一格要是空的，旁边或下面要有能贴着的方块）
 *   useOnBlock  对那一格方块的某一面用手里的东西：打火石点火（传送门门框里面点着就亮了）、骨粉……
 *
 * 结果里说清楚世界实际变成了什么：倒的水碰到岩浆源变成黑曜石、碰到流动岩浆变成圆石，下界里水倒出来就蒸发，传送门亮没亮。
 */
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { MinecraftActionErrorCode, MinecraftActionResult } from './contracts.js';
import { patchedGoto } from './patchedGoto.js';
import { confirmDug } from './digAck.js';

const BUCKETS = new Set(['bucket', 'water_bucket', 'lava_bucket']);
const LIQUID_OF: Record<string, string> = { water_bucket: 'water', lava_bucket: 'lava' };
const SIDES: Record<string, Vec3> = {
  top: new Vec3(0, 1, 0), bottom: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0),
};

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

function result(started: number, before: Record<string, number>, bot: any, outcome: MinecraftActionResult['outcome'], summary: string, code?: MinecraftActionErrorCode): MinecraftActionResult {
  return {
    actionId: '', outcome, summary, durationMs: Date.now() - started,
    inventoryDelta: difference(before, counts(bot)), worldChanges: [], observations: [],
    ...(code ? { error: { code, recoverable: true, details: { message: summary } } } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;
const item = (bot: any, name: string) => (bot.inventory?.items?.() ?? []).find((i: any) => i.name === name);
const isSource = (b: any) => !!b && (b.name === 'water' || b.name === 'lava') && Number(b.getProperties?.().level ?? b.metadata ?? 0) === 0;
const solid = (b: any) => !!b && b.boundingBox === 'block';
const inNether = (bot: any) => String(bot.game?.dimension ?? '').includes('nether');

// 传送门也挡不住：站在传送门里往外倒水，服务器的视线穿过去（庄稼不一样：站在长高的胡萝卜里倒水，水会倒进自己那一格）
const SEE_THROUGH = new Set(['air', 'cave_air', 'void_air', 'water', 'nether_portal']);
/** 挡视线时可以随手挖掉的：杂草、雪层（庄稼、火把、花不在里面） */
const WEEDS = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']);

/** 从 eye 看 aim，除了 allowed 这几格，视线上第一个不是空气的方块（庄稼、草这类没碰撞箱的也算）；没有就是 null */
function blockerOnLine(bot: any, eye: Vec3, aim: Vec3, allowed: Vec3[], ignoreWeeds = false): any | null {
  const d = aim.minus(eye);
  const len = d.norm();
  const skip = new Set(allowed.map(fmt));
  for (let t = 0; t < len; t += 0.05) {
    const p = eye.plus(d.scaled(t / len)).floored();
    if (skip.has(fmt(p))) continue;
    const block = bot.blockAt(p);
    // 水挡不住：倒水时服务器的视线穿过液体
    if (block && !SEE_THROUGH.has(block.name) && !(ignoreWeeds && WEEDS.has(block.name))) return block;
  }
  return null;
}

/** 走到够得着的地方（4 格内，看得到那一格） */
async function reach(bot: any, target: Vec3, signal: AbortSignal): Promise<void> {
  if (bot.entity.position.offset(0, 1.6, 0).distanceTo(target.offset(0.5, 0.5, 0.5)) <= 4) return;
  const r = await patchedGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), { signal });
  if (!r.ok) throw new Error(`cannot get close enough: ${r.message}`);
}

/** 这一格和周围一圈（3×3×3，含斜角）现在是什么（看用完以后变了什么：倒下去的水会流到斜下方） */
function around(bot: any, p: Vec3): Map<string, string> {
  const out = new Map<string, string>();
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const q = p.offset(dx, dy, dz);
    out.set(fmt(q), bot.blockAt(q)?.name ?? 'unknown');
  }
  return out;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, was] of before) {
    const now = after.get(k);
    if (now && now !== was) out.push(`${k}: ${was} → ${now}`);
  }
  return out;
}

export async function useBucket(bot: any, req: { item: string; position: { x: number; y: number; z: number }; signal: AbortSignal }): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const target = new Vec3(Math.floor(req.position.x), Math.floor(req.position.y), Math.floor(req.position.z));
  if (!BUCKETS.has(req.item)) return result(started, before, bot, 'failed', `${req.item} is not a bucket; buckets: bucket (empty), water_bucket, lava_bucket`, 'unknown_item');
  const held = item(bot, req.item);
  if (!held) return result(started, before, bot, 'failed', `no ${req.item} in the inventory${req.item === 'bucket' ? ' (a bucket is 3 iron ingots)' : ''}`, 'missing_item');
  const block = bot.blockAt(target);
  if (!block) return result(started, before, bot, 'failed', `${fmt(target)} is not loaded`, 'target_not_found');

  try {
    await reach(bot, target, req.signal);
    await bot.equip(held, 'hand');
    const was = around(bot, target);
    if (req.item === 'bucket') {
      // 装：对着液体源头那一格的中间用
      if (block.name !== 'water' && block.name !== 'lava') return result(started, before, bot, 'failed', `${fmt(target)} is ${block.name}, not water or lava`, 'target_not_found');
      if (!isSource(block)) return result(started, before, bot, 'failed', `the ${block.name} at ${fmt(target)} is flowing, not a source block; only a source can be picked up`, 'blocked');
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
      await sleep(100);
      bot.activateItem();
      await sleep(500);
      const got = counts(bot)[`${block.name}_bucket`] ?? 0;
      if (got > (before[`${block.name}_bucket`] ?? 0)) return result(started, before, bot, 'succeeded', `filled the bucket with ${block.name} from ${fmt(target)}`);
      return result(started, before, bot, 'failed', `the bucket stayed empty (could not aim at the ${block.name} at ${fmt(target)})`, 'blocked');
    }
    // 倒：那一格要空着；对着它旁边一个实心方块朝它的那一面用
    if (solid(block)) return result(started, before, bot, 'failed', `${fmt(target)} is ${block.name}; pour into an empty cell`, 'blocked');
    const liquid = LIQUID_OF[req.item];
    const faces = Object.entries(SIDES).map(([, d]) => ({ against: target.minus(d), d })).filter((f) => solid(bot.blockAt(f.against)));
    if (!faces.length) return result(started, before, bot, 'failed', `nothing solid next to ${fmt(target)} to pour against`, 'blocked');
    const aimOf = (f: { against: Vec3; d: Vec3 }) => f.against.offset(0.5 + f.d.x * 0.5, 0.5 + f.d.y * 0.5, 0.5 + f.d.z * 0.5);
    // 视线上不能有别的东西：服务器按她的视线找倒在哪，庄稼、草、火把没有碰撞箱但挡视线，水会倒进那一格（冲掉庄稼）
    const eyeAt = (feet: Vec3) => feet.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const pick = (eye: Vec3, ignoreWeeds = false) => {
      let blocker: any = null;
      for (const f of faces) {
        const b = blockerOnLine(bot, eye, aimOf(f), [target, f.against], ignoreWeeds);
        if (!b) return { face: f, blocker: null };
        blocker ??= b;
      }
      return { face: null, blocker };
    };
    let choice = pick(eyeAt(bot.entity.position));
    // 挡着的是杂草、雪层：挖掉（一碰就掉，玩家也这么做）；庄稼、火把、花不挖
    const clearWeeds = async () => {
      for (let i = 0; i < 3 && !choice.face && choice.blocker && WEEDS.has(choice.blocker.name); i++) {
        await bot.dig(choice.blocker, true).catch(() => {});
        choice = pick(eyeAt(bot.entity.position));
      }
    };
    await clearWeeds();
    // 还是挡着：在那一格周围找一个站的地方（脚下实心、身子两格空着），从那里看进去视线通的（杂草不算，到了再挖），走过去
    if (!choice.face) {
      const spots = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
      for (const [dx, dz] of spots) {
        const stand = target.offset(dx, 1, dz);
        if (!solid(bot.blockAt(stand.offset(0, -1, 0))) || solid(bot.blockAt(stand)) || solid(bot.blockAt(stand.offset(0, 1, 0)))) continue;
        if (!pick(eyeAt(stand.offset(0.5, 0, 0.5)), true).face) continue;
        const r = await patchedGoto(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { signal: req.signal });
        if (r.ok) {
          choice = pick(eyeAt(bot.entity.position));
          await clearWeeds();
        }
        if (choice.face) break;
      }
    }
    const face = choice.face;
    if (!face) {
      const what = choice.blocker ? `${choice.blocker.name} at ${fmt(choice.blocker.position)} is in the way` : 'something is in the way';
      return result(started, before, bot, 'failed', `could not get a clear line of sight into ${fmt(target)} (${what})`, 'blocked');
    }
    await bot.lookAt(aimOf(face), true);
    // 站在哪、瞄的哪一格的哪一面：倒歪了能看出来
    const sideName = Object.entries(SIDES).find(([, d]) => d.equals(face.d))?.[0] ?? '?';
    const how = `standing at ${fmt(bot.entity.position.floored())}, aimed at the ${sideName} of ${bot.blockAt(face.against)?.name ?? '?'} at ${fmt(face.against)}`;
    await sleep(100);
    bot.activateItem();
    await sleep(1500);
    const now = around(bot, target);
    const changed = changes(was, now);
    const emptied = (counts(bot)[req.item] ?? 0) < (before[req.item] ?? 0);
    const formed = changed.filter((c) => /→ (obsidian|cobblestone|stone)$/.test(c));
    if (!emptied) return result(started, before, bot, 'failed', `could not pour the ${liquid} at ${fmt(target)} (${how})`, 'blocked');
    if (liquid === 'water' && inNether(bot) && bot.blockAt(target)?.name !== 'water') {
      return result(started, before, bot, 'succeeded', `poured the water out at ${fmt(target)}, and it evaporated at once (water cannot exist in the Nether)`);
    }
    // 倒出去了，但不在那一格（视线被别的东西挡了）：照实说流到哪了
    const landed = bot.blockAt(target);
    // 要是源头：旁边倒歪了流进来的是流动的水（level 不是 0），不算倒进去了
    if (!formed.length && !(landed?.name === liquid && isSource(landed))) {
      const went = changed.filter((c) => new RegExp(`→ ${liquid}`).test(c)).join('; ') || 'nowhere nearby';
      return result(started, before, bot, 'failed', `the ${liquid} did not land in ${fmt(target)} but here: ${went} (${how})`, 'blocked');
    }
    const notes = formed.length ? `; ${formed.map((c) => c.replace(/: (lava|water) → /, ': $1 turned into ')).join('; ')}` : '';
    return result(started, before, bot, 'succeeded', `poured ${liquid} at ${fmt(target)}${notes}`);
  } catch (err) {
    return result(started, before, bot, req.signal.aborted ? 'cancelled' : 'failed', (err as Error).message, 'path_unreachable');
  }
}

export async function useOnBlock(bot: any, req: { item: string; position: { x: number; y: number; z: number }; face?: string; signal: AbortSignal }): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const target = new Vec3(Math.floor(req.position.x), Math.floor(req.position.y), Math.floor(req.position.z));
  const held = item(bot, req.item);
  if (!held) return result(started, before, bot, 'failed', `no ${req.item} in the inventory`, 'missing_item');
  const block = bot.blockAt(target);
  if (!block || !solid(block)) return result(started, before, bot, 'failed', `${fmt(target)} is ${block?.name ?? 'not loaded'}; use it on a solid block`, 'target_not_found');
  const dir = SIDES[req.face ?? 'top'] ?? SIDES.top;
  try {
    await reach(bot, target, req.signal);
    await bot.equip(held, 'hand');
    const was = around(bot, target.plus(dir));
    await bot.lookAt(target.offset(0.5 + dir.x * 0.5, 0.5 + dir.y * 0.5, 0.5 + dir.z * 0.5), true);
    await bot.activateBlock(bot.blockAt(target), dir);
    await sleep(800);
    const changed = changes(was, around(bot, target.plus(dir)));
    const portal = bot.findBlock?.({ matching: (b: any) => b.name === 'nether_portal', maxDistance: 6 });
    if (portal) return result(started, before, bot, 'succeeded', `used ${req.item} on ${block.name} at ${fmt(target)}; the nether portal lit up (purple portal blocks around ${fmt(portal.position)}; walk into them to travel)`);
    if (!changed.length) return result(started, before, bot, 'partial', `used ${req.item} on ${block.name} at ${fmt(target)}, but nothing changed`);
    return result(started, before, bot, 'succeeded', `used ${req.item} on ${block.name} at ${fmt(target)}: ${changed.join('; ')}`);
  } catch (err) {
    return result(started, before, bot, req.signal.aborted ? 'cancelled' : 'failed', (err as Error).message, 'path_unreachable');
  }
}

/**
 * 挖掉指定的那一格（挖坑、挖水渠、拆东西）：走过去、换上合适的工具、挖、捡掉落物。
 * 挖开会让岩浆流进来的不挖；旁边是水的照挖（挖水渠就是要水流进来），挖完告诉她水流进来了。
 * 要特定工具才掉东西的（石头、矿、黑曜石）手里没有就不挖，说要什么工具。
 */
export async function digAt(bot: any, req: { position: { x: number; y: number; z: number }; signal: AbortSignal }, pickup: (radius: number) => Promise<void>): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const target = new Vec3(Math.floor(req.position.x), Math.floor(req.position.y), Math.floor(req.position.z));
  const block = bot.blockAt(target);
  if (!block) return result(started, before, bot, 'failed', `${fmt(target)} is not loaded`, 'target_not_found');
  if (block.boundingBox === 'empty' && !/grass|fern|flower|bush|crop|wheat|carrots|potatoes|beetroots|sapling|snow|vine|torch/.test(block.name)) {
    return result(started, before, bot, 'failed', `${fmt(target)} is already ${block.name}; nothing to dig`, 'target_not_found');
  }
  if (/bedrock|barrier|end_portal_frame|command_block/.test(block.name)) return result(started, before, bot, 'failed', `${block.name} cannot be broken`, 'blocked');
  const lavaNext = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    .map((d) => target.plus(d)).find((p) => /lava/.test(bot.blockAt(p)?.name ?? ''));
  if (lavaNext) return result(started, before, bot, 'failed', `did not dig ${block.name} at ${fmt(target)}: lava at ${fmt(lavaNext)} would flow in`, 'unsafe');
  const harvestable = !block.harvestTools || (bot.inventory?.items?.() ?? []).some((i: any) => block.canHarvest?.(i.type));
  if (!harvestable) {
    const tools = Object.keys(block.harvestTools).map((id) => bot.registry.items[Number(id)]?.name).filter(Boolean);
    return result(started, before, bot, 'failed', `${block.name} drops nothing without ${tools.slice(0, 3).join(' / ')}${tools.length > 3 ? ' (or better)' : ''}`, 'missing_tool');
  }
  try {
    await reach(bot, target, req.signal);
    await bot.tool?.equipForBlock?.(block, {}).catch?.(() => {});
    const dug = bot.blockAt(target);
    await bot.dig(dug, true);
    // 以服务器为准：mineflayer 挖完先在自己这边记成空气，服务器不认要过一会儿才改回来
    const verdict = await confirmDug(bot, dug);
    if (verdict) return result(started, before, bot, 'failed', `did not dig ${block.name} at ${fmt(target)}: ${verdict}`, /never got within reach/.test(verdict) ? 'path_unreachable' : 'dig_rejected');
    await sleep(300);
    await pickup(4).catch(() => {});
    // 掉下来的东西还在飞、掉进刚挖的坑里：等一下再捡一次
    if (JSON.stringify(counts(bot)) === JSON.stringify(before)) {
      await sleep(800);
      await pickup(4).catch(() => {});
    }
    const now = bot.blockAt(target)?.name ?? 'unknown';
    const water = /water/.test(now) ? '; water flowed into it' : '';
    return result(started, before, bot, 'succeeded', `dug out the ${block.name} at ${fmt(target)}${water}`);
  } catch (err) {
    return result(started, before, bot, req.signal.aborted ? 'cancelled' : 'failed', (err as Error).message, 'path_unreachable');
  }
}
