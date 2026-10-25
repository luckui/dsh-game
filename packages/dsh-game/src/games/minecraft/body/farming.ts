/**
 * 种地和养动物：她决定种什么、种在哪、多大、什么时候收、繁殖什么；身体去锄地、播种、收割补种、喂动物、剪羊毛。
 *
 *   farmPlot      清掉地上的草 → 锄头把泥土锄成耕地 → 播种；看 4 格内有没有水（没水长得很慢）
 *   harvestCrops  收附近熟了的庄稼（小麦、胡萝卜、土豆到第 7 阶段，甜菜到第 3 阶段），捡掉落物，补种回去
 *   breedAnimals  拿对的饲料喂动物（一对一对喂），看有没有生出小的
 *   shearSheep    拿剪刀剪羊毛
 * 结果里的背包变化都按背包前后实际的差算。
 */
import { goals, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { MinecraftActionErrorCode, MinecraftActionResult } from './contracts.js';
import { patchedGoto } from './patchedGoto.js';
import { swimToShore } from './survival.js';
import { protectMovementsFromFalls } from './fluidSafety.js';

export interface FarmHelpers {
  /** 挖掉一格（走过去、换工具） */
  dig(target: Vec3): Promise<void>;
  pickup(radius: number): Promise<void>;
  log(text: string): void;
}

/** 种子 → 种下去长出来的作物 */
const SEED_TO_CROP: Record<string, string> = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' };
const CROP_TO_SEED: Record<string, string> = Object.fromEntries(Object.entries(SEED_TO_CROP).map(([s, c]) => [c, s]));
const RIPE_AGE: Record<string, number> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path']);
/** 动物 → 能拿来繁殖的饲料（按顺序找背包里有的） */
const BREED_FOOD: Record<string, string[]> = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
};

function result(started: number, before: Record<string, number>, bot: any, outcome: MinecraftActionResult['outcome'], summary: string, code?: MinecraftActionErrorCode): MinecraftActionResult {
  return {
    actionId: '', outcome, summary, durationMs: Date.now() - started,
    inventoryDelta: difference(before, counts(bot)), worldChanges: [], observations: [],
    ...(code ? { error: { code, recoverable: true, details: { message: summary } } } : {}),
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

const item = (bot: any, match: (name: string) => boolean) => (bot.inventory?.items?.() ?? []).find((i: any) => match(i.name));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function goNear(bot: any, p: Vec3, range = 3, signal?: AbortSignal): Promise<void> {
  if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) <= range + 0.5) return;
  let r = await patchedGoto(bot, new goals.GoalNear(p.x, p.y, p.z, range), { signal });
  // 掉进水渠里：寻路器在水里规划不好，先游上岸再走
  if (!r.ok && (await swimToShore(bot, signal)) && !signal?.aborted) r = await patchedGoto(bot, new goals.GoalNear(p.x, p.y, p.z, range), { signal });
  if (!r.ok) throw new Error(`cannot get there: ${r.message}`);
}

/** 这格耕地 4 格内有没有水（同一层或上面一层） */
function hasWaterNear(bot: any, ground: Vec3): boolean {
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const dy of [0, 1]) {
    const b = bot.blockAt(ground.offset(dx, dy, dz));
    if (b && (b.name === 'water' || b.getProperties?.().waterlogged === true)) return true;
  }
  return false;
}

/**
 * 在地里干活时的走法：耕地和庄稼不挖（寻路器站在耕地上会以为自己在方块里面）、不跳远、尽量不从庄稼上走（跳上耕地会把它踩回泥土）。
 * 做完换回原来的走法。
 */
async function withFarmMovements<T>(bot: any, fn: () => Promise<T>): Promise<T> {
  const old = bot.pathfinder.movements;
  const movements = protectMovementsFromFalls(bot, new Movements(bot));
  for (const name of ['farmland', ...Object.keys(RIPE_AGE)]) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id !== undefined) movements.blocksCantBreak.add(id);
  }
  movements.allowParkour = false;
  // 走庄稼那格多算几步路（能绕就绕）；寻路器一步里代价加起来过 100 就当走不通，所以不能给大了，不然站在地中间就出不去
  movements.exclusionAreasStep.push((block: any) => (RIPE_AGE[block?.name] !== undefined ? 3 : 0));
  bot.pathfinder.setMovements(movements);
  try {
    return await fn();
  } finally {
    bot.pathfinder.setMovements(old);
  }
}

/** 一格：清掉上面的草 → 锄成耕地 → 播种。种上了返回 null，没种上返回原因 */
async function tillAndSow(bot: any, ground: Vec3, seed: string, crop: string, helpers: FarmHelpers, signal: AbortSignal): Promise<string | null> {
  const where = `${ground.x} ${ground.y} ${ground.z}`;
  const g = bot.blockAt(ground);
  if (!g || (!TILLABLE.has(g.name) && g.name !== 'farmland')) return `${where} is ${g?.name ?? 'not loaded'}`;
  if (bot.blockAt(ground.offset(0, 1, 0))?.name === crop && g.name === 'farmland') return null;
  await goNear(bot, ground, 3, signal);
  // 上面的草、花清掉（耕地上面要是空的）
  const above = bot.blockAt(ground.offset(0, 1, 0));
  if (above && above.name !== 'air') {
    if (above.boundingBox === 'block') return `${where} has ${above.name} on top`;
    await helpers.dig(ground.offset(0, 1, 0));
  }
  if (bot.blockAt(ground)?.name !== 'farmland') {
    await bot.equip(item(bot, (n) => n.endsWith('_hoe')), 'hand');
    await bot.activateBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
    await sleep(250);
    if (bot.blockAt(ground)?.name !== 'farmland') return `${where} did not turn into farmland`;
  }
  const seeds = item(bot, (n) => n === seed);
  if (!seeds) return `ran out of ${seed}`;
  await bot.equip(seeds, 'hand');
  await bot.activateBlock(bot.blockAt(ground), new Vec3(0, 1, 0));
  await sleep(250);
  return bot.blockAt(ground.offset(0, 1, 0))?.name === crop ? null : `${where}: the seed did not stay planted`;
}

/** 开一块地：西北角（地面那一格）开始 size×size，种上 seed */
export async function farmPlot(bot: any, req: { seed: string; corner: { x: number; y: number; z: number }; size: number; signal: AbortSignal }, helpers: FarmHelpers): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const crop = SEED_TO_CROP[req.seed];
  if (!crop) return result(started, before, bot, 'failed', `${req.seed} is not something you plant on farmland; seeds that work: ${Object.keys(SEED_TO_CROP).join(', ')}`, 'unknown_item');
  if (!item(bot, (n) => n.endsWith('_hoe'))) return result(started, before, bot, 'failed', 'need a hoe to till the soil (wooden_hoe: 2 planks + 2 sticks)', 'missing_tool');
  if (!item(bot, (n) => n === req.seed)) return result(started, before, bot, 'failed', `no ${req.seed} to plant`, 'missing_item');

  const size = Math.max(1, Math.min(9, Math.round(req.size)));
  // 地面那一格：给的是地面上面那层也行（往下一格）
  const cells: Vec3[] = [];
  for (let dz = 0; dz < size; dz++) for (let dx = 0; dx < size; dx++) {
    const p = new Vec3(req.corner.x + dx, req.corner.y, req.corner.z + dz);
    const at = bot.blockAt(p);
    cells.push(at && !TILLABLE.has(at.name) && at.name !== 'farmland' && at.boundingBox === 'empty' ? p.offset(0, -1, 0) : p);
  }
  const farmlandBefore = cells.filter((c) => bot.blockAt(c)?.name === 'farmland').length;
  const problems = new Map<string, string>();
  await withFarmMovements(bot, async () => {
    // 两遍，中间把清草时掉的种子捡回来；第二遍补第一遍之后又被踩坏、没种上的格子（种好的格子直接跳过）
    for (let pass = 0; pass < 2; pass++) {
      for (const c of cells) {
        if (req.signal.aborted) return;
        const why = await tillAndSow(bot, c, req.seed, crop, helpers, req.signal).catch((err: Error) => `${c.x} ${c.y} ${c.z}: ${err.message}`);
        if (why) problems.set(`${c}`, why); else problems.delete(`${c}`);
        if (why?.startsWith('ran out of')) return;
      }
      if (pass === 0) await helpers.pickup(8).catch(() => {});
    }
    // 最后几格清草掉的种子可能还在飞、在水渠里漂：等它停下再捡两次
    for (let i = 0; i < 2; i++) {
      await sleep(1000);
      await helpers.pickup(8).catch(() => {});
    }
  });
  if (req.signal.aborted) return result(started, before, bot, 'cancelled', 'stopped farming');
  // 按地里实际的样子数
  const planted = cells.filter((c) => bot.blockAt(c.offset(0, 1, 0))?.name === crop && bot.blockAt(c)?.name === 'farmland');
  const tilled = Math.max(0, cells.filter((c) => bot.blockAt(c)?.name === 'farmland').length - farmlandBefore);
  const dry = planted.filter((c) => !hasWaterNear(bot, c)).length;
  const skipped = [...new Set(problems.values())];
  const notes = [
    dry ? `${dry} of them have no water within 4 blocks, so they will grow very slowly (put water next to the field)` : '',
    skipped.length ? `${cells.length - planted.length} not planted: ${skipped.slice(0, 4).join('; ')}` : '',
  ].filter(Boolean).join('; ');
  const summary = `tilled ${tilled}, ${crop} now growing on ${planted.length} of ${cells.length} cells of the ${size}x${size} field${notes ? `; ${notes}` : ''}; ${crop} takes a few minutes of game time to grow`;
  return result(started, before, bot, planted.length ? (planted.length === cells.length ? 'succeeded' : 'partial') : 'failed', summary, planted.length ? undefined : 'blocked');
}

/** 收附近熟了的庄稼，补种回去 */
export async function harvestCrops(bot: any, req: { crop?: string; radius: number; replant: boolean; signal: AbortSignal }, helpers: FarmHelpers): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const wanted = req.crop ? [SEED_TO_CROP[req.crop] ?? req.crop] : Object.keys(RIPE_AGE);
  const ids = wanted.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
  if (!ids.length) return result(started, before, bot, 'failed', `${req.crop} is not a crop; crops: ${Object.keys(RIPE_AGE).join(', ')}`, 'unknown_item');
  const positions: Vec3[] = bot.findBlocks({ matching: ids, maxDistance: req.radius, count: 400 });
  const crops = positions.map((p) => bot.blockAt(p)).filter(Boolean);
  const ripe = crops.filter((b: any) => Number(b.getProperties?.().age) >= RIPE_AGE[b.name]);
  if (!crops.length) return result(started, before, bot, 'failed', `no ${wanted.join('/')} planted within ${req.radius} blocks`, 'target_not_found');
  if (!ripe.length) {
    const stages = crops.map((b: any) => `${b.getProperties?.().age}/${RIPE_AGE[b.name]}`);
    return result(started, before, bot, 'succeeded', `${crops.length} crop(s) within ${req.radius} blocks, none ripe yet (growth stages: ${stages.slice(0, 12).join(', ')})`);
  }
  let harvested = 0;
  const me = bot.entity.position;
  ripe.sort((a: any, b: any) => me.distanceTo(a.position) - me.distanceTo(b.position));
  const spots: { ground: Vec3; crop: string }[] = ripe.map((b: any) => ({ ground: b.position.offset(0, -1, 0), crop: b.name }));
  const problems = new Map<string, string>();
  await withFarmMovements(bot, async () => {
    for (const b of ripe) {
      if (req.signal.aborted) return;
      try {
        await goNear(bot, b.position, 3, req.signal);
        const now = bot.blockAt(b.position);
        if (!now || now.name !== b.name) { problems.set(`${b.position}`, `${b.name} at ${b.position} was gone before I got there`); continue; }
        await bot.dig(now, true);
        harvested += 1;
      } catch (err) {
        problems.set(`${b.position}`, `${b.name} at ${b.position}: ${(err as Error).message}`);
      }
    }
    await helpers.pickup(8).catch(() => {});
    if (!req.replant) return;
    // 补种：收的时候踩回泥土的格子，有锄头就重新锄
    for (const s of spots) {
      if (req.signal.aborted) return;
      if (bot.blockAt(s.ground)?.name !== 'farmland' && !item(bot, (n) => n.endsWith('_hoe'))) {
        problems.set(`${s.ground}`, `the farmland at ${s.ground} got trampled back to dirt and there is no hoe to till it again`);
        continue;
      }
      const why = await tillAndSow(bot, s.ground, CROP_TO_SEED[s.crop], s.crop, helpers, req.signal).catch((err: Error) => err.message);
      if (why) problems.set(`${s.ground}`, why);
    }
    await helpers.pickup(8).catch(() => {});
  });
  const young = (s: { ground: Vec3; crop: string }) => {
    const b = bot.blockAt(s.ground.offset(0, 1, 0));
    return b?.name === s.crop && Number(b.getProperties?.().age) < RIPE_AGE[s.crop];
  };
  const replanted = spots.filter(young).length;
  const unripe = crops.length - ripe.length;
  const notes = problems.size ? `; ${[...new Set(problems.values())].slice(0, 3).join('; ')}` : '';
  const summary = `harvested ${harvested} of ${ripe.length} ripe crop(s)${req.replant ? `, replanted ${replanted}` : ''}; ${unripe} still growing${notes}`;
  const complete = harvested === ripe.length && (!req.replant || replanted === spots.length);
  return result(started, before, bot, complete ? 'succeeded' : 'partial', summary);
}

function nearbyAnimals(bot: any, animal: string, radius: number): any[] {
  const me = bot.entity.position;
  return Object.values(bot.entities as Record<string, any>)
    .filter((e) => e.name === animal && e.position && e.position.distanceTo(me) <= radius)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

/** 喂 pairs 对动物（繁殖），看生出几只小的 */
export async function breedAnimals(bot: any, req: { animal: string; pairs: number; signal: AbortSignal }): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const foods = BREED_FOOD[req.animal];
  if (!foods) return result(started, before, bot, 'failed', `don't know how to breed ${req.animal}; animals: ${Object.keys(BREED_FOOD).join(', ')}`, 'unknown_item');
  const food = foods.find((f) => before[f] > 0);
  const want = Math.max(1, Math.min(4, Math.round(req.pairs))) * 2;
  if (!food) return result(started, before, bot, 'failed', `need ${foods.join(' or ')} to breed ${req.animal}`, 'missing_item');
  const animals = nearbyAnimals(bot, req.animal, 24);
  if (animals.length < 2) return result(started, before, bot, 'failed', `need at least 2 ${req.animal} within 24 blocks, found ${animals.length}`, 'target_not_found');
  const countBefore = nearbyAnimals(bot, req.animal, 32).length;
  let fed = 0;
  for (const a of animals.slice(0, want)) {
    if (req.signal.aborted) break;
    const f = item(bot, (n) => n === food);
    if (!f) break;
    try {
      const r = await patchedGoto(bot, new goals.GoalNear(a.position.x, a.position.y, a.position.z, 2), { signal: req.signal });
      if (!r.ok) continue;
      await bot.equip(f, 'hand');
      await bot.lookAt(a.position.offset(0, (a.height ?? 1) * 0.6, 0), true);
      await bot.activateEntity(a);
      fed += 1;
      await sleep(300);
    } catch {
      // 跑掉了：喂下一只
    }
  }
  // 喂过的两只要走到一起才生：最多等 10 秒
  let born = 0;
  for (let waited = 0; waited < 10_000 && born * 2 < fed - 1; waited += 1000) {
    await sleep(1000);
    born = Math.max(0, nearbyAnimals(bot, req.animal, 32).length - countBefore);
  }
  const summary = `fed ${fed} ${req.animal} with ${food}; ${born} baby ${req.animal} born${born ? '' : ' (two adults that were just fed need to be near each other; an animal can breed again only after about 5 minutes)'}`;
  return result(started, before, bot, fed >= 2 ? 'succeeded' : 'partial', summary);
}

/** 剪羊毛：剪 count 只 */
export async function shearSheep(bot: any, req: { count: number; signal: AbortSignal }, helpers: FarmHelpers): Promise<MinecraftActionResult> {
  const started = Date.now();
  const before = counts(bot);
  const shears = item(bot, (n) => n === 'shears');
  if (!shears) return result(started, before, bot, 'failed', 'need shears (2 iron ingots)', 'missing_tool');
  const sheep = nearbyAnimals(bot, 'sheep', 24);
  if (!sheep.length) return result(started, before, bot, 'failed', 'no sheep within 24 blocks', 'target_not_found');
  let tried = 0;
  for (const s of sheep.slice(0, Math.max(1, Math.min(16, Math.round(req.count))))) {
    if (req.signal.aborted) break;
    try {
      const r = await patchedGoto(bot, new goals.GoalNear(s.position.x, s.position.y, s.position.z, 2), { signal: req.signal });
      if (!r.ok) continue;
      await bot.equip(item(bot, (n) => n === 'shears'), 'hand');
      await bot.lookAt(s.position.offset(0, 0.8, 0), true);
      await bot.activateEntity(s);
      tried += 1;
      await sleep(300);
    } catch {
      // 跑掉了：剪下一只
    }
  }
  await sleep(800);
  await helpers.pickup(10).catch(() => {});
  const wool = Object.entries(difference(before, counts(bot))).filter(([n, d]) => n.endsWith('_wool') && d > 0).reduce((a, [, d]) => a + d, 0);
  return result(started, before, bot, wool > 0 ? 'succeeded' : 'partial', `sheared ${tried} sheep, got ${wool} wool${wool ? '' : ' (they may have been sheared already; wool grows back after they eat grass)'}`);
}
