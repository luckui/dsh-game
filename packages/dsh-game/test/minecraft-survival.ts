/**
 * Minecraft 生存自测：走游戏层（和她调 game_act 时同一条路：参数换算、排队、结果描述都经过），
 * 在本机开发服务器上用一个测试玩家把基本操作挨个做一遍，每一项核对：
 *   - 结果（做完了 / 没成）和数量
 *   - 报给她的背包变化 = 服务器里真实背包的变化
 *   - 身体看到的背包 = 服务器里的背包
 *   - 脚边没有莫名掉出来的东西（合成、熔炼、装备这类不该掉东西的动作）
 *
 * 场地：y=200 的空中平台（离地面远，附近没有天然的树和矿），用 RCON 搭好树、石头、铁矿、煤矿；测试时关刷怪，测完恢复。
 * 运行：node tools/mc-selftest.mjs（要先 node tools/mc-server.mjs start）
 */
import fs from 'node:fs';
import path from 'node:path';
import { MinecraftSession } from '../src/games/minecraft/session.js';
import { rcon as rconRaw, type RconTarget } from '../src/games/minecraft/rcon.js';

const ROOT = path.resolve(process.argv[2] ?? '.');
/** 跑哪些：basic（基本操作）、edge（名字、配方回环、掉落和数量）、build（盖房子）、farm（种地、养动物）、journal（世界日志）、nether（桶、黑曜石、下界传送门）、creative（形状图纸、创造模式一层层盖）、不填 = 全部 */
const SUITE = process.argv[3] ?? 'all';
const props = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.mc-server', 'server.properties'), 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const RCON: RconTarget = { host: '127.0.0.1', port: Number(props['rcon.port'] || 25575), password: props['rcon.password'] };
const NAME = 'SelfTest';
const X = 1000, Y = 200, Z = 1000;
const rcon = (cmd: string) => rconRaw(RCON, cmd);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 身体的日志（排查用） */
const LOG = path.join(ROOT, 'packages', 'dsh-game', 'test', '.out', 'body.log');
/** 测试用的世界日志目录（每次跑之前清空） */
const JOURNAL_DIR = path.join(ROOT, 'packages', 'dsh-game', 'test', '.out', 'journal');

// ---------- 记录结果 ----------
const results: { name: string; ok: boolean; notes: string[] }[] = [];
let current: { name: string; ok: boolean; notes: string[] } | null = null;
function begin(name: string): void {
  current = { name, ok: true, notes: [] };
  results.push(current);
  console.log(`\n=== ${name}`);
}
function check(cond: boolean, what: string): void {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond && current) { current.ok = false; current.notes.push(what); }
}
function note(text: string): void {
  console.log(`  ·    ${text}`);
}

// ---------- 服务器上的真实情况 ----------
/** 服务器里她身上有几个这种东西（clear 数量 0 = 只数不删；含盔甲栏、副手） */
async function serverCount(item: string): Promise<number> {
  const reply = await rcon(`clear ${NAME} minecraft:${item} 0`);
  const m = reply.match(/(\d+)/);
  return /No items were found|没有找到/.test(reply) || !m ? 0 : Number(m[1]);
}
async function droppedNearby(): Promise<number> {
  const reply = await rcon(`execute as ${NAME} at @s if entity @e[type=item,distance=..12]`);
  const m = reply.match(/count:\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

// ---------- 游戏层 ----------
let session: MinecraftSession;
const lines: string[] = [];
const body = () => (session as any).runtime as { command<T>(a: string, p: unknown, t?: number): Promise<T> };
async function bodyInventory(): Promise<Record<string, number>> {
  const snap = await body().command<any>('snapshot', {}, 10_000);
  return snap?.body?.inventory ?? {};
}
/** 背包（身体看到的）和服务器一致吗：逐个物品数一遍 */
async function inventoryMatches(extra: string[] = []): Promise<void> {
  const inv = await bodyInventory();
  const names = [...new Set([...Object.keys(inv), ...extra])];
  const diffs: string[] = [];
  for (const n of names) {
    const s = await serverCount(n);
    if ((inv[n] ?? 0) !== s) diffs.push(`${n} 身体 ${inv[n] ?? 0} / 服务器 ${s}`);
  }
  check(diffs.length === 0, `身体看到的背包和服务器一致${diffs.length ? `：${diffs.join('；')}` : ''}`);
}

/** 做一件事；后台做的就一直等到它报「做完了 / 没成 / 停下了」，返回那一行 */
async function act(action: string, args: { name?: string; index?: number; text?: string } = {}, timeoutMs = 180_000, onStart?: () => Promise<void>): Promise<string> {
  const reply = await session.act({ action, ...args });
  note(`act ${action} ${JSON.stringify(args)} → ${reply.split('\n')[0].slice(0, 160)}`);
  if (onStart) void onStart();
  if (!/^开始|排上了/.test(reply)) return reply;
  const label = reply.match(/^开始(.+?)。/)?.[1] ?? reply.match(/「(.+?)」排上了/)?.[1] ?? '';
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = lines.find((l) => l.startsWith(`${label}：`));
    if (hit) {
      lines.splice(lines.indexOf(hit), 1);
      note(hit.slice(0, 300));
      return hit;
    }
    const m = await session.wait(AbortSignal.timeout(Math.min(30_000, end - Date.now())), 30_000);
    lines.push(...m.lines);
  }
  // 超时了：停下，别让后面排队的都跟着等
  note(`超时，停下：${(await session.act({ action: 'stop' })).slice(0, 80)}`);
  return `超时：${label}`;
}

/** 报给她的背包变化（「背包变化：a +1，b -2」）解析出来 */
function reportedDelta(line: string): Record<string, number> {
  const part = line.match(/背包变化：([^（]+)/)?.[1] ?? '';
  const out: Record<string, number> = {};
  for (const m of part.matchAll(/([a-z0-9_]+) ([+-]?\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/** 做一件事，核对：结果、报的背包变化 = 服务器真实变化、该有的物品数量、不该掉东西时脚边没东西 */
async function step(
  action: string,
  args: { name?: string; index?: number; text?: string },
  expect: { ok?: RegExp; gain?: Record<string, number>; atLeast?: Record<string, number>; noDrops?: boolean; timeoutMs?: number; onStart?: () => Promise<void> } = {},
): Promise<string> {
  await onArena();
  const watch = [...new Set([...Object.keys(expect.gain ?? {}), ...Object.keys(expect.atLeast ?? {})])];
  const before: Record<string, number> = {};
  const inv0 = await bodyInventory();
  for (const n of [...new Set([...Object.keys(inv0), ...watch])]) before[n] = await serverCount(n);
  const dropsBefore = expect.noDrops ? await droppedNearby() : 0;
  const line = await act(action, args, expect.timeoutMs, expect.onStart);
  // 刚做完那一刻她在哪、附近地上有什么（报的背包变化对不上时看）
  const atEnd = `她在 ${await rcon(`data get entity ${NAME} Pos`)}；附近地上：${await rcon(`execute as @e[type=item,x=${X},y=${Y},z=${Z},distance=..30] run data get entity @s Pos`)} / ${await rcon(`execute as @e[type=item,x=${X},y=${Y},z=${Z},distance=..30] run data get entity @s Item`)}`;
  await sleep(800);
  check((expect.ok ?? /做完了/).test(line), `结果：${(expect.ok ?? /做完了/).source}`);
  const reported = reportedDelta(line);
  const inv1 = await bodyInventory();
  const names = [...new Set([...Object.keys(before), ...Object.keys(inv1), ...Object.keys(reported)])];
  const real: Record<string, number> = {};
  for (const n of names) {
    const d = (await serverCount(n)) - (before[n] ?? 0);
    if (d) real[n] = d;
  }
  if (/背包变化/.test(line)) {
    const mismatch = names.filter((n) => (reported[n] ?? 0) !== (real[n] ?? 0)).map((n) => `${n} 报 ${reported[n] ?? 0} / 实际 ${real[n] ?? 0}`);
    check(mismatch.length === 0, `报给她的背包变化和服务器一致${mismatch.length ? `：${mismatch.join('；')}` : ''}`);
    if (mismatch.length) note(`做完那一刻：${atEnd}`);
  }
  for (const [n, g] of Object.entries(expect.gain ?? {})) check((real[n] ?? 0) === g, `${n} 变化 ${real[n] ?? 0}（应为 ${g}）`);
  for (const [n, g] of Object.entries(expect.atLeast ?? {})) check((real[n] ?? 0) >= g, `${n} 变化 ${real[n] ?? 0}（至少 ${g}）`);
  if (expect.noDrops) {
    const drops = (await droppedNearby()) - dropsBefore;
    check(drops <= 0, `脚边没有多出掉落物（多了 ${Math.max(0, drops)} 个）`);
  }
  await inventoryMatches(watch);
  return line;
}

// ---------- 场地 ----------
async function buildArena(): Promise<void> {
  // 先让场地所在的区块常驻（没人在那儿时区块不加载，fill 会失败），搭好平台再把人传过去
  await rcon(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
  await sleep(1500);
  // 先清掉一大圈（上次测试时寻路器搭的方块可能落在墙外，会把她引出去）
  await rcon(`fill ${X - 16} ${Y - 5} ${Z - 16} ${X + 16} ${Y + 12} ${Z + 16} air`);
  await rcon(`fill ${X - 10} ${Y - 4} ${Z - 10} ${X + 10} ${Y} ${Z + 10} dirt`);
  // 一圈玻璃墙加玻璃顶，免得走出、爬出平台掉下去
  await rcon(`fill ${X - 10} ${Y + 7} ${Z - 10} ${X + 10} ${Y + 7} ${Z + 10} glass`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z - 10} ${X + 10} ${Y + 6} ${Z - 10} glass`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z + 10} ${X + 10} ${Y + 6} ${Z + 10} glass`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z - 10} ${X - 10} ${Y + 6} ${Z + 10} glass`);
  await rcon(`fill ${X + 10} ${Y + 1} ${Z - 10} ${X + 10} ${Y + 6} ${Z + 10} glass`);
  // 三棵「树」：四格高的橡木原木柱
  for (const [dx, dz] of [[-6, -6], [-6, 6], [6, -6]]) await rcon(`fill ${X + dx} ${Y + 1} ${Z + dz} ${X + dx} ${Y + 4} ${Z + dz} oak_log`);
  // 一堆石头、三块铁矿、三块煤矿
  await rcon(`fill ${X + 5} ${Y + 1} ${Z + 4} ${X + 7} ${Y + 2} ${Z + 6} stone`);
  await rcon(`fill ${X - 7} ${Y + 1} ${Z + 1} ${X - 7} ${Y + 1} ${Z + 3} iron_ore`);
  await rcon(`fill ${X - 4} ${Y + 1} ${Z - 8} ${X - 2} ${Y + 1} ${Z - 8} coal_ore`);
  await rcon(`gamemode survival ${NAME}`);
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);
}

/** 人还在平台上吗（掉下去、死了重生会离开）：不在就记一笔、传回来 */
async function onArena(): Promise<void> {
  const nums = (await rcon(`data get entity ${NAME} Pos`)).match(/-?\d+(\.\d+)?(?=d)/g)?.map(Number) ?? [];
  const away = nums.length < 3 || Math.abs(nums[0] - X) > 10 || Math.abs(nums[2] - Z) > 10 || nums[1] < Y - 4;
  if (away) {
    check(false, `测试玩家离开了平台（在 ${nums.map((n) => n.toFixed(1)).join(' ')}），传回来`);
    await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
    await sleep(1500);
  }
}

/** 边界情况用的场地：草地、沙砾、一棵树（树旁边地上有别的掉落物） */
async function buildEdgeArena(): Promise<void> {
  await rcon(`fill ${X + 2} ${Y} ${Z - 8} ${X + 8} ${Y} ${Z - 2} grass_block`);
  await rcon(`fill ${X + 2} ${Y + 1} ${Z - 8} ${X + 8} ${Y + 1} ${Z - 2} short_grass`);
  await rcon(`fill ${X - 9} ${Y + 1} ${Z + 5} ${X - 6} ${Y + 3} ${Z + 8} gravel`);
  await rcon(`fill ${X + 2} ${Y + 1} ${Z + 7} ${X + 2} ${Y + 4} ${Z + 7} oak_log`);
}

/** 名字、配方回环、掉落和数量：她可能遇到的各种怪情况 */
async function edgeCases(): Promise<void> {
  await buildEdgeArena();
  await reset();

  begin('名字：老名字 grass（1.20.3 起改叫 short_grass）');
  const grass = await act('collect', { name: 'grass', index: 1 });
  check(/short_grass/.test(grass), `说清楚没有 grass，提到现在的名字 short_grass：${grass.slice(0, 200)}`);
  await inventoryMatches();

  begin('名字：要 stone（挖石头掉的是圆石）');
  await rcon(`give ${NAME} stone_pickaxe 1`);
  await rcon(`fill ${X + 5} ${Y + 1} ${Z + 4} ${X + 7} ${Y + 2} ${Z + 6} stone`);
  await sleep(800);
  const stone = await step('collect', { name: 'stone', index: 2 }, { ok: /：做完了|：只做了一部分|：没成/ });
  note(`她看到的：${stone.slice(0, 200)}`);

  begin('名字：含糊的 iron');
  const iron = await act('collect', { name: 'iron', index: 1 });
  check(!/：做完了/.test(iron) && /raw_iron|iron_ore|iron_ingot/.test(iron), `不假装做完，列出相近的名字：${iron.slice(0, 200)}`);

  begin('名字：泛称 planks、老名字 wooden_planks');
  await rcon(`give ${NAME} oak_log 4`);
  await sleep(800);
  const planks = await step('craft', { name: 'planks', index: 4 }, { ok: /：做完了|：没成/ });
  note(`planks：${planks.slice(0, 200)}`);
  check(/：做完了/.test(planks) || /oak_planks/.test(planks), `planks 要么做出来，要么列出 oak_planks 这类名字`);
  const legacy = await act('craft', { name: 'wooden_planks', index: 4 });
  check(!/超时/.test(legacy), `wooden_planks 有明确的结果：${legacy.slice(0, 200)}`);
  await inventoryMatches();

  begin('配方回环：没有铁锭和铁块，只有粗铁 → 铁锭要熔炼');
  await reset();
  await rcon(`give ${NAME} raw_iron 3`);
  await rcon(`give ${NAME} coal 2`);
  await rcon(`give ${NAME} furnace 1`);
  await sleep(800);
  await step('craft', { name: 'iron_ingot', index: 3 }, { gain: { iron_ingot: 3, raw_iron: -3 }, noDrops: true });

  begin('配方回环：铁块拆成 9 个铁锭（不能在铁块和铁锭之间来回转）');
  await reset();
  await rcon(`give ${NAME} iron_block 1`);
  await sleep(800);
  await step('craft', { name: 'iron_ingot', index: 9 }, { gain: { iron_ingot: 9, iron_block: -1 }, noDrops: true });

  begin('配方回环：铁锭不够做铁块，又没有粗铁（应该说缺什么，不能转圈）');
  await reset();
  await rcon(`give ${NAME} iron_ingot 4`);
  await sleep(800);
  const block = await step('craft', { name: 'iron_block', index: 1 }, { ok: /：没成/, gain: {} });
  note(`她看到的：${block.slice(0, 200)}`);
  check(!/missing[^）]*iron_block/.test(block) && /raw_iron|iron_ore/.test(block), '说出真正缺的（粗铁 / 铁矿），不是「缺铁块」');
  check((await serverCount('iron_ingot')) === 4, `铁锭还是 4 个（${await serverCount('iron_ingot')}）`);

  begin('配方链：只有粗铁和木棍 → 铁镐（先熔炼再合成）');
  await reset();
  await rcon(`give ${NAME} raw_iron 3`);
  await rcon(`give ${NAME} stick 2`);
  await rcon(`give ${NAME} coal 1`);
  await rcon(`give ${NAME} furnace 1`);
  await rcon(`give ${NAME} crafting_table 1`);
  await sleep(800);
  await step('craft', { name: 'iron_pickaxe', index: 1 }, { gain: { iron_pickaxe: 1, raw_iron: -3, stick: -2 }, noDrops: true });

  begin('概率掉落：小麦种子（砍草不一定出种子）');
  await reset();
  const seeds = await step('collect', { name: 'wheat_seeds', index: 2 }, { ok: /：做完了/ });
  note(`她看到的：${seeds.slice(0, 220)}`);
  const seedCount = await serverCount('wheat_seeds');
  check(/做完了/.test(seeds) ? seedCount >= 2 : true, `种子 ${seedCount} 个；说「做完了」时至少 2 个`);
  check(/collected [\d/]+ wheat_seeds by breaking \d+ short_grass/.test(seeds), '分得清：拿到几个种子、砍了几株草');

  begin('概率掉落：燧石（沙砾 10% 出燧石）');
  await rcon(`give ${NAME} wooden_shovel 1`);
  await sleep(800);
  const flint = await step('collect', { name: 'flint', index: 1 }, { ok: /：做完了/ });
  note(`她看到的：${flint.slice(0, 220)}`);
  check(/collected [\d/]+ flint by breaking \d+ gravel/.test(flint), '分得清：拿到几个燧石、挖了几块沙砾');

  begin('杀羊：杀了几只 和 拿到几块羊毛、几块肉 是两回事');
  await reset();
  await rcon(`give ${NAME} iron_sword 1`);
  await rcon(`summon sheep ${X - 3} ${Y + 1} ${Z - 3} {Color:0b}`);
  await rcon(`summon sheep ${X - 4} ${Y + 1} ${Z - 2} {Color:0b}`);
  await sleep(1000);
  const sheep = await step('attack', { name: 'sheep', index: 2 }, { ok: /：做完了/ });
  note(`她看到的：${sheep.slice(0, 220)}`);
  check(/2\/2 sheep|killed 2/.test(sheep), '说清楚杀了 2 只');
  const woolGot = await serverCount('white_wool');
  check(woolGot >= 2, `两只羊的羊毛都捡了（${woolGot}）`);
  if (woolGot < 2) note(`场地附近地上的东西：${await rcon(`execute as @e[type=item,x=${X},y=${Y},z=${Z},distance=..30] run data get entity @s Pos`)} / ${await rcon(`execute as @e[type=item,x=${X},y=${Y},z=${Z},distance=..30] run data get entity @s Item.id`)}`);
  check((await droppedNearby()) === 0, `地上没落下东西（还有 ${await droppedNearby()} 个）`);

  begin('要羊毛：附近没有羊毛方块（羊毛来自羊）');
  await rcon(`summon sheep ${X - 3} ${Y + 1} ${Z - 3} {Color:0b}`);
  await sleep(800);
  const wool = await act('collect', { name: 'white_wool', index: 1 });
  check(!/超时/.test(wool), `有个明确的结果：${wool.slice(0, 220)}`);
  await inventoryMatches();
  await rcon(`kill @e[type=sheep,x=${X},y=${Y},z=${Z},distance=..30]`);

  begin('砍树：旁边地上有别的东西，报的背包变化要和真实一致');
  await reset();
  await rcon(`summon item ${X + 2} ${Y + 1} ${Z + 5} {Item:{id:"minecraft:stick",count:3}}`);
  await rcon(`summon item ${X + 3} ${Y + 1} ${Z + 6} {Item:{id:"minecraft:apple",count:1}}`);
  await sleep(500);
  await step('collect', { name: 'oak_log', index: 4 }, { atLeast: { oak_log: 4 } });
}

/** 图纸里每块方块在世界里是不是对的（用 RCON 的 execute if block 逐块问）：返回不对的那些 */
async function wrongBlocks(text: string, origin: { x: number; y: number; z: number }): Promise<string[]> {
  const { parseBlueprint, placements } = await import('../src/games/minecraft/blueprint.js');
  const bp = parseBlueprint(text).blueprint!;
  const wrong: string[] = [];
  for (const p of placements(bp, origin)) {
    const state = Object.entries(p.props).map(([k, v]) => `${k}=${v}`).join(',');
    const reply = await rcon(`execute if block ${p.x} ${p.y} ${p.z} ${p.name}${state ? `[${state}]` : ''}`);
    if (!/passed/i.test(reply)) wrong.push(`${p.name}${state ? `[${state}]` : ''} @ ${p.x} ${p.y} ${p.z}`);
  }
  return wrong;
}

/** 某个范围里不在图纸上的泥土、圆石（脚手架没拆干净） */
async function leftovers(box: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }, keep: Set<string>): Promise<string[]> {
  const left: string[] = [];
  for (let x = box.x1; x <= box.x2; x++) for (let y = box.y1; y <= box.y2; y++) for (let z = box.z1; z <= box.z2; z++) {
    if (keep.has(`${x},${y},${z}`)) continue;
    const reply = await rcon(`execute if block ${x} ${y} ${z} #minecraft:dirt`);
    const cobble = await rcon(`execute if block ${x} ${y} ${z} cobblestone`);
    if (/passed/i.test(reply) || /passed/i.test(cobble)) left.push(`${x} ${y} ${z}`);
  }
  return left;
}

/** 盖房子：图纸、参考图纸、材料、朝向、脚手架 */
async function buildCases(): Promise<void> {
  const { TEMPLATES, parseBlueprint, placements } = await import('../src/games/minecraft/blueprint.js');
  // 场地里面清空，墙和顶加高（塔有 8 层）
  await rcon(`fill ${X - 9} ${Y + 1} ${Z - 9} ${X + 9} ${Y + 10} ${Z + 9} air`);
  await rcon(`fill ${X - 10} ${Y + 7} ${Z - 10} ${X + 10} ${Y + 7} ${Z + 10} air replace glass`);
  for (const [a, b] of [[`${X - 10} ${Y + 1} ${Z - 10}`, `${X + 10} ${Y + 10} ${Z - 10}`], [`${X - 10} ${Y + 1} ${Z + 10}`, `${X + 10} ${Y + 10} ${Z + 10}`], [`${X - 10} ${Y + 1} ${Z - 10}`, `${X - 10} ${Y + 10} ${Z + 10}`], [`${X + 10} ${Y + 1} ${Z - 10}`, `${X + 10} ${Y + 10} ${Z + 10}`]]) {
    await rcon(`fill ${a} ${b} glass`);
  }
  await rcon(`fill ${X - 10} ${Y + 11} ${Z - 10} ${X + 10} ${Y + 11} ${Z + 10} glass`);
  await reset();
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);

  begin('图纸：方块名写错、字符没在图例里');
  const badName = await session.act({ action: 'design', name: '错的', text: '图例：\n# oak_plank\n第1层：\n###\n#X#' });
  note(badName.slice(0, 300));
  check(/X/.test(badName) && !/存好了/.test(badName), '字符不在图例里：读不了，说出是哪个字符');
  const badName2 = await session.act({ action: 'design', name: '错的2', text: '图例：\n# oak_plank\n第1层：\n###' });
  note(badName2.slice(0, 300));
  check(/oak_planks/.test(badName2) && !/存好了/.test(badName2), '方块名写错：不存，列出相近的名字（oak_planks）');

  begin('参考图纸：小木屋，材料不够时说清缺多少');
  const tpl = await session.act({ action: 'template', name: 'cabin' });
  note(tpl.split('\n').slice(-12).join(' | ').slice(0, 400));
  check(/149 块/.test(tpl) && /存好了/.test(tpl), '参考图纸给了预览（149 块）并存好了');
  const cabinOrigin = { x: X - 8, y: Y + 1, z: Z - 8 };
  const poor = await act('build', { name: 'cabin', text: `${cabinOrigin.x} ${cabinOrigin.y} ${cabinOrigin.z}` });
  check(/没成/.test(poor) && /oak_planks/.test(poor), `材料不够：不开工，说清缺什么（${poor.slice(0, 120)}）`);

  begin('盖小木屋（参考图纸，149 块）');
  await rcon(`give ${NAME} oak_planks 140`);
  await rcon(`give ${NAME} oak_log 12`);
  await rcon(`give ${NAME} glass_pane 4`);
  await rcon(`give ${NAME} oak_door 1`);
  await rcon(`give ${NAME} cobblestone 64`);
  await sleep(1000);
  // 虚影：开工时整座房子都在（149 块 + 门的上半格），盖到一半少了，盖完一个不剩
  const ghosts = async () => Number((await rcon('execute if entity @e[type=block_display,tag=dsh_ghost]')).match(/count:\s*(\d+)/i)?.[1] ?? 0);
  const ghostCounts: number[] = [];
  const cabin = await step('build', { name: 'cabin', text: `${cabinOrigin.x} ${cabinOrigin.y} ${cabinOrigin.z}` }, {
    ok: /：做完了/, timeoutMs: 600_000,
    onStart: async () => {
      ghostCounts.push(await ghosts());
      await sleep(40_000);
      ghostCounts.push(await ghosts());
    },
  });
  ghostCounts.push(await ghosts());
  note(`虚影个数：开工 ${ghostCounts[0]}、40 秒后 ${ghostCounts[1]}、盖完 ${ghostCounts[2]}`);
  check(ghostCounts[0] === 150, `开工时整座虚影都在（${ghostCounts[0]}，应为 150）`);
  check(ghostCounts[1] > 0 && ghostCounts[1] < ghostCounts[0], `盖的时候虚影一块块变少（${ghostCounts[1]}）`);
  check(ghostCounts[2] === 0, `盖完虚影都撤了（还剩 ${ghostCounts[2]}）`);
  note(`她看到的：${cabin.slice(0, 300)}`);
  const cabinWrong = await wrongBlocks(TEMPLATES.cabin.text, cabinOrigin);
  check(cabinWrong.length === 0, `每块都对（不对的 ${cabinWrong.length} 块：${cabinWrong.slice(0, 5).join('；')}）`);
  const cabinKeep = new Set(placements(parseBlueprint(TEMPLATES.cabin.text).blueprint!, cabinOrigin).map((p) => `${p.x},${p.y},${p.z}`));
  const cabinLeft = await leftovers({ x1: cabinOrigin.x - 2, y1: Y + 1, z1: cabinOrigin.z - 2, x2: cabinOrigin.x + 8, y2: Y + 8, z2: cabinOrigin.z + 7 }, cabinKeep);
  check(cabinLeft.length === 0, `脚手架拆干净了（还剩 ${cabinLeft.length} 块：${cabinLeft.slice(0, 5).join('；')}）`);

  begin('盖瞭望塔（8 层高，要垫方块爬上去，盖完拆脚手架）');
  await session.act({ action: 'template', name: 'tower' });
  await reset();
  await rcon(`give ${NAME} cobblestone 192`);
  await rcon(`give ${NAME} dirt 32`);
  await rcon(`give ${NAME} oak_door 1`);
  await sleep(1000);
  const towerOrigin = { x: X + 2, y: Y + 1, z: Z + 2 };
  const tower = await step('build', { name: 'tower', text: `${towerOrigin.x} ${towerOrigin.y} ${towerOrigin.z}` }, { ok: /：做完了/, timeoutMs: 600_000 });
  note(`她看到的：${tower.slice(0, 300)}`);
  const towerWrong = await wrongBlocks(TEMPLATES.tower.text, towerOrigin);
  check(towerWrong.length === 0, `每块都对（不对的 ${towerWrong.length} 块：${towerWrong.slice(0, 5).join('；')}）`);
  const towerKeep = new Set(placements(parseBlueprint(TEMPLATES.tower.text).blueprint!, towerOrigin).map((p) => `${p.x},${p.y},${p.z}`));
  const towerLeft = await leftovers({ x1: towerOrigin.x - 3, y1: Y + 1, z1: towerOrigin.z - 3, x2: towerOrigin.x + 7, y2: Y + 10, z2: towerOrigin.z + 7 }, towerKeep);
  check(towerLeft.length === 0, `脚手架拆干净了（还剩 ${towerLeft.length} 块：${towerLeft.slice(0, 5).join('；')}）`);

  begin('楼梯的朝向（四个方向各一级）');
  const stairs = '图例：\n# cobblestone\nN oak_stairs facing=north\nE oak_stairs facing=east\nS oak_stairs facing=south\nW oak_stairs facing=west\n第1层：\n#####\n#N#E#\n#####\n#S#W#\n#####';
  const designed = await session.act({ action: 'design', name: '楼梯', text: stairs });
  check(/存好了/.test(designed), '楼梯图纸存好了');
  await reset();
  await rcon(`give ${NAME} cobblestone 32`);
  await rcon(`give ${NAME} oak_stairs 8`);
  await sleep(1000);
  const stairsOrigin = { x: X - 8, y: Y + 1, z: Z + 3 };
  const stairsLine = await step('build', { name: '楼梯', text: `${stairsOrigin.x} ${stairsOrigin.y} ${stairsOrigin.z}` }, { ok: /：做完了/ });
  note(`她看到的：${stairsLine.slice(0, 300)}`);
  const stairsWrong = await wrongBlocks(stairs, stairsOrigin);
  check(stairsWrong.length === 0, `朝向都对（不对的：${stairsWrong.join('；')}）`);
}

/** 这些格子里有几格是这种方块 */
async function countBlocks(cells: { x: number; y: number; z: number }[], block: string): Promise<number> {
  let n = 0;
  for (const c of cells) if (/passed|通过/i.test(await rcon(`execute if block ${c.x} ${c.y} ${c.z} ${block}`))) n += 1;
  return n;
}
async function countEntities(type: string): Promise<number> {
  const m = (await rcon(`execute if entity @e[type=${type},x=${X},y=${Y},z=${Z},distance=..30]`)).match(/count:\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

/** 种地、收庄稼、繁殖、剪羊毛 */
async function farmCases(): Promise<void> {
  await rcon(`fill ${X - 9} ${Y + 1} ${Z - 9} ${X + 9} ${Y + 6} ${Z + 9} air`);
  await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
  // 一块 4×4 的草地，长着草，东边一条水渠；东南角一块没水的泥地
  await rcon(`fill ${X - 8} ${Y} ${Z - 8} ${X - 5} ${Y} ${Z - 5} grass_block`);
  await rcon(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X - 5} ${Y + 1} ${Z - 6} short_grass`);
  await rcon(`fill ${X - 4} ${Y} ${Z - 8} ${X - 4} ${Y} ${Z - 5} water`);
  await reset();
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);
  const field: { x: number; y: number; z: number }[] = [];
  for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) field.push({ x: X - 8 + dx, y: Y + 1, z: Z - 8 + dz });

  begin('种地：没锄头、没种子');
  const noHoe = await act('farm', { name: 'wheat_seeds', text: `${X - 8} ${Y} ${Z - 8}`, index: 4 });
  check(/没成/.test(noHoe) && /hoe/.test(noHoe), `没锄头：不开工，说要锄头（${noHoe.slice(0, 120)}）`);

  begin('种地：清草、锄地、播种（旁边有水渠）');
  await rcon(`give ${NAME} wooden_hoe 1`);
  await rcon(`give ${NAME} wheat_seeds 20`);
  await sleep(800);
  const planted = await step('farm', { name: 'wheat_seeds', text: `${X - 8} ${Y} ${Z - 8}`, index: 4 }, { ok: /：做完了/ });
  check(!/no water/.test(planted), '有水渠：没说缺水');
  check((await countBlocks(field, 'wheat')) === 16, `16 格都种上了小麦（种上 ${await countBlocks(field, 'wheat')} 格）`);
  check((await countBlocks(field.map((c) => ({ ...c, y: Y })), 'farmland')) === 16, '16 格都是耕地');

  begin('种地：没水的地会说（从水渠里出发）');
  await rcon(`give ${NAME} carrot 4`);
  await rcon(`tp ${NAME} ${X - 4} ${Y} ${Z - 6}`);
  await sleep(1500);
  const dryLine = await step('farm', { name: 'carrot', text: `${X + 3} ${Y + 1} ${Z + 3}`, index: 2 }, { ok: /：做完了/, gain: { carrot: -4 } });
  check(/no water/.test(dryLine), `说了没水长得慢（${dryLine.slice(0, 200)}）`);

  begin('收庄稼：还没熟');
  const unripe = await step('harvest', { name: 'wheat' }, { ok: /：做完了/, gain: { wheat: 0 } });
  check(/none ripe/.test(unripe), `说了还没熟、长到第几阶段（${unripe.slice(0, 200)}）`);

  begin('收庄稼：熟了收、补种');
  await rcon(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X - 5} ${Y + 1} ${Z - 5} wheat[age=7] replace wheat`);
  await sleep(500);
  await step('harvest', { name: 'wheat' }, { ok: /：做完了/, atLeast: { wheat: 16 } });
  // 补种的是刚种下的（有水，几秒内可能已经长了一阶）：16 格都有小麦、没有一格是熟的
  const replanted = await countBlocks(field, 'wheat');
  const stillRipe = await countBlocks(field, 'wheat[age=7]');
  check(replanted === 16 && stillRipe === 0, `16 格都补种回去了（有小麦 ${replanted} 格，熟的 ${stillRipe} 格）`);

  begin('繁殖：没饲料');
  await rcon(`summon cow ${X + 2} ${Y + 1} ${Z - 2}`);
  await rcon(`summon cow ${X + 3} ${Y + 1} ${Z - 2}`);
  await rcon(`clear ${NAME} wheat`);
  await sleep(800);
  const noFood = await act('breed', { name: 'cow', index: 1 });
  check(/没成/.test(noFood) && /wheat/.test(noFood), `没小麦：说要 wheat（${noFood.slice(0, 120)}）`);

  begin('繁殖：两头牛喂小麦');
  await rcon(`give ${NAME} wheat 4`);
  await sleep(800);
  const cows0 = await countEntities('cow');
  const bred = await step('breed', { name: 'cow', index: 1 }, { ok: /：做完了/, gain: { wheat: -2 } });
  check((await countEntities('cow')) === cows0 + 1, `多了一头小牛（${cows0} → ${await countEntities('cow')}）；她看到的：${bred.slice(0, 160)}`);

  begin('剪羊毛');
  await rcon(`summon sheep ${X - 2} ${Y + 1} ${Z + 4} {Color:0b}`);
  await rcon(`summon sheep ${X - 3} ${Y + 1} ${Z + 5} {Color:0b}`);
  await rcon(`give ${NAME} shears 1`);
  await sleep(800);
  await step('shear', { index: 2 }, { ok: /：做完了/, atLeast: { white_wool: 2 } });

  begin('挖坑引水：dig 挖掉指定那一格，再倒水（胡萝卜地旁边）');
  await rcon(`give ${NAME} water_bucket 1`);
  await sleep(800);
  await step('dig', { text: `${X + 5} ${Y} ${Z + 3}` }, { ok: /：做完了/, gain: { dirt: 1 } });
  check(/passed/i.test(await rcon(`execute if block ${X + 5} ${Y} ${Z + 3} air`)), '那一格挖空了');
  await step('bucket', { name: 'water_bucket', text: `${X + 5} ${Y} ${Z + 3}` }, { ok: /：做完了/, gain: { water_bucket: -1, bucket: 1 } });
  check(/passed/i.test(await rcon(`execute if block ${X + 5} ${Y} ${Z + 3} water[level=0]`)), '坑里是一格水源（胡萝卜地有水了）');
  await rcon(`setblock ${X + 6} ${Y + 1} ${Z + 6} stone`);
  await sleep(500);
  const stone = await act('dig', { text: `${X + 6} ${Y + 1} ${Z + 6}` });
  check(/没成/.test(stone) && /wooden_pickaxe/.test(stone), `没镐子挖石头：说要什么镐（${stone.slice(0, 140)}）`);
  await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
}

/** 世界日志：她写的（目标、图纸、地点）、身体自动记的（盖的、种的、床、死），下一局开局接上；换了世界、主人清空 */
async function journalCases(): Promise<void> {
  const { WorldJournal, journalFile } = await import('../src/games/minecraft/journal.js');
  const server = `127.0.0.1:${Number(props['server-port'] || 25565)}`;
  await rcon(`fill ${X - 9} ${Y + 1} ${Z - 9} ${X + 9} ${Y + 6} ${Z + 9} air`);
  await rcon(`fill ${X - 9} ${Y} ${Z - 9} ${X + 9} ${Y} ${Z + 9} dirt`);
  await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
  await reset();
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);

  begin('日志：第一次来这个世界');
  check(/第一次来这个世界/.test(firstStart), `开局说了第一次来（${firstStart.split('\n').slice(-1)[0].slice(0, 80)}）`);

  begin('日志：她写的（目标、地点、图纸）');
  note(await session.act({ action: 'goal', text: '在空岛上盖一个家' }));
  const home = await session.act({ action: 'mark', name: '家' });
  note(home);
  check(/记下了：「家」在 \(1000, 201, 1000\)/.test(home), 'mark 不填坐标：记她站的地方');
  note(await session.act({ action: 'mark', name: '矿洞', text: `${X - 5} ${Y - 3} ${Z + 4}` }));
  note(await session.act({ action: 'mark', name: '临时', text: `${X} ${Y} ${Z}` }));
  const removed = await session.act({ action: 'mark', name: '临时', text: '删掉' });
  check(/删掉了/.test(removed), `mark 填「删掉」：删了（${removed}）`);
  const pillar = '图例：\n# cobblestone\n第1层：\n##\n第2层：\n##';
  check(/存好了/.test(await session.act({ action: 'design', name: '小石台', text: pillar })), '图纸存好了');

  begin('日志：身体自动记的（盖的、种的、床、死）');
  await rcon(`give ${NAME} cobblestone 8`);
  await rcon(`give ${NAME} wooden_hoe 1`);
  await rcon(`give ${NAME} wheat_seeds 4`);
  await rcon(`give ${NAME} white_bed 1`);
  await sleep(1000);
  await step('build', { name: '小石台', text: `${X + 3} ${Y + 1} ${Z - 3}` }, { ok: /：做完了/ });
  await step('farm', { name: 'wheat_seeds', text: `${X - 4} ${Y} ${Z - 4}`, index: 2 }, { ok: /：做完了/ });
  await rcon('time set 13000');
  await sleep(1000);
  await step('sleep', {}, { ok: /做完了/ });
  await rcon('time set day');
  await rcon(`tp ${NAME} ${X + 2} ${Y + 1} ${Z + 2}`);
  await sleep(1500);
  await rcon(`kill ${NAME}`);
  await sleep(4000);
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);
  const whole = await session.act({ action: 'journal' });
  note(whole.replace(/\n/g, ' | ').slice(0, 600));
  check(/目标：在空岛上盖一个家/.test(whole), '目标记下了');
  check(/家 \(1000, 201, 1000\)/.test(whole) && /矿洞 \(995, 197, 1004\)/.test(whole) && !/临时/.test(whole), '地点：家、矿洞在，删掉的不在');
  check(/「小石台」在 \(1003, 201, 997\)，盖完了/.test(whole), '盖过的建筑：名字、坐标、盖完了');
  check(/wheat_seeds 2×2 在 \(996, 200, 996\)/.test(whole), '种过的地');
  check(/床（复活点）：/.test(whole), '床记下了');
  check(/死过 1 次，最近一次在 \(1002, 201, 1002\)/.test(whole), '死在哪记下了');
  check(/存着的图纸：小石台/.test(whole), '图纸在日志里');

  begin('日志：下一局开局接上');
  await session.stop();
  session = newSession();
  const again = await session.start();
  note(again.replace(/\n/g, ' | ').slice(0, 700));
  check(/你在这里玩过 1 次，上次是/.test(again), '说了玩过几次、上次什么时候');
  check(/目标：在空岛上盖一个家/.test(again) && /家 \(1000, 201, 1000\)/.test(again) && /「小石台」/.test(again), '目标、地点、建筑都在');
  check(/你的目标：在空岛上盖一个家/.test((await session.wait(AbortSignal.timeout(3000), 2000)).notes.join(' ')), '目标接上了（每个时刻都提醒）');
  const rebuild = session.refuse({ action: 'build', name: '小石台', text: `${X - 6} ${Y + 1} ${Z + 3}` });
  check(rebuild === null, `上一局的图纸能直接 build（${rebuild ?? '可以'}）`);

  begin('日志：服务器换了新世界、主人清空');
  const file = journalFile(JOURNAL_DIR, server, NAME);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const realSeed = data.seed;
  check(!!realSeed, `记下了世界种子（${realSeed}）`);
  const swapped = WorldJournal.open(JOURNAL_DIR, server, NAME, '12345');
  check(/换了一个新世界/.test(swapped.note ?? '') && /第一次来/.test(swapped.journal.intro()), '种子对不上：旧的收起来，开新的一本');
  check(fs.readdirSync(JOURNAL_DIR).some((f) => f.includes('.old-world-')), '旧日志改名留着');
  fs.writeFileSync(file, JSON.stringify(data));
  check(WorldJournal.clear(JOURNAL_DIR, server, NAME) && WorldJournal.read(JOURNAL_DIR, server, NAME) === null, '清空以后设置面板读到的是「还没玩过」');
  check(fs.readdirSync(JOURNAL_DIR).some((f) => f.includes('.cleared-')), '清空的改名留着');
}

/** 等她看到某一行（换维度这类不是她动作结果的事） */
async function waitLine(match: RegExp, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = lines.find((l) => match.test(l));
    if (hit) {
      lines.splice(lines.indexOf(hit), 1);
      return hit;
    }
    const m = await session.wait(AbortSignal.timeout(Math.min(10_000, end - Date.now())), 10_000);
    lines.push(...m.lines);
  }
  return null;
}

async function dimensionNow(): Promise<string> {
  return String((await body().command<any>('snapshot', {}, 10_000))?.world?.dimension ?? '');
}

/** 桶、浇黑曜石、挖黑曜石、搭门框、点火、去下界再回来 */
async function netherCases(): Promise<void> {
  await rcon(`fill ${X - 9} ${Y + 1} ${Z - 9} ${X + 9} ${Y + 6} ${Z + 9} air`);
  await rcon(`fill ${X - 9} ${Y} ${Z - 9} ${X + 9} ${Y} ${Z + 9} dirt`);
  await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
  await reset();
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);
  const is = async (x: number, y: number, z: number, block: string) => /passed/i.test(await rcon(`execute if block ${x} ${y} ${z} ${block}`));

  begin('桶：装水');
  await rcon(`setblock ${X + 4} ${Y} ${Z + 4} water`);
  await rcon(`give ${NAME} bucket 1`);
  await sleep(1000);
  await step('bucket', { name: 'bucket', text: `${X + 4} ${Y} ${Z + 4}` }, { ok: /：做完了/, gain: { bucket: -1, water_bucket: 1 } });
  check(await is(X + 4, Y, Z + 4, 'air'), '水被装走了，那一格空了');

  begin('桶：往岩浆源旁边倒水，浇出黑曜石，再把水装回来');
  await rcon(`setblock ${X + 4} ${Y} ${Z + 4} lava`);
  await sleep(500);
  const poured = await step('bucket', { name: 'water_bucket', text: `${X + 5} ${Y + 1} ${Z + 4}` }, { ok: /：做完了/, gain: { water_bucket: -1, bucket: 1 } });
  check(await is(X + 4, Y, Z + 4, 'obsidian'), '岩浆源变成了黑曜石');
  check(/obsidian/.test(poured), `告诉她变成了黑曜石（${poured.slice(0, 160)}）`);
  await step('bucket', { name: 'bucket', text: `${X + 5} ${Y + 1} ${Z + 4}` }, { ok: /：做完了/, gain: { water_bucket: 1 } });
  await rcon(`give ${NAME} bucket 1`);
  await sleep(800);
  const empty = await act('bucket', { name: 'bucket', text: `${X + 6} ${Y + 1} ${Z + 4}` });
  check(/没成/.test(empty) && /not water or lava/.test(empty), `空的格子装不起来，说了那里不是水（${empty.slice(0, 120)}）`);

  begin('挖黑曜石（钻石镐）');
  await rcon(`give ${NAME} diamond_pickaxe 1`);
  await sleep(800);
  await step('collect', { name: 'obsidian', index: 1 }, { ok: /做完了/, gain: { obsidian: 1 }, timeoutMs: 120_000 });

  begin('搭门框（参考图纸，10 块黑曜石）、打火石点火');
  await rcon(`give ${NAME} obsidian 9`);
  await rcon(`give ${NAME} flint_and_steel 1`);
  await rcon(`give ${NAME} cobblestone 16`);
  await sleep(1000);
  const tpl = await session.act({ action: 'template', name: 'nether_portal' });
  check(/共 10 块/.test(tpl) && /存好了/.test(tpl), '参考图纸：10 块黑曜石');
  const o = { x: X - 5, y: Y + 1, z: Z - 6 };
  await step('build', { name: 'nether_portal', text: `${o.x} ${o.y} ${o.z}` }, { ok: /：做完了/, gain: { obsidian: -10 }, timeoutMs: 300_000 });
  const lit = await step('use', { name: 'flint_and_steel', text: `${o.x + 1} ${o.y} ${o.z}` }, { ok: /：做完了/ });
  check(/lit up/.test(lit), `说了传送门亮了（${lit.slice(0, 160)}）`);
  check(await is(o.x + 1, o.y + 1, o.z, 'nether_portal') && await is(o.x + 2, o.y + 3, o.z, 'nether_portal'), '门框里是传送门');

  begin('走进传送门，到下界');
  await rcon(`give ${NAME} white_bed 1`);
  await sleep(800);
  const into = await act('go', { text: `${o.x + 1} ${o.y + 1} ${o.z}` }, 60_000);
  const arrived = await waitLine(/穿过传送门，到了下界/, 30_000);
  note(arrived ?? '（没等到）');
  check(!!arrived, `她知道到了下界（go：${into.slice(0, 100)}）`);
  check(/nether/.test(await dimensionNow()), '身体在下界');

  begin('在下界：床不能睡、水倒出来就蒸发');
  const bed = await act('sleep', {});
  check(/没成/.test(bed) && /explode/.test(bed), `不放床，说了会爆炸（${bed.slice(0, 140)}）`);
  const here = (await body().command<any>('snapshot', {}, 10_000))?.body?.position;
  const p = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
  note(`她在下界 ${p.x} ${p.y} ${p.z}`);
  // 门是东西向的：往南或往北一两格是门外（新生成的门两边有黑曜石平台）
  let outside: { x: number; y: number; z: number } | null = null;
  for (const dz of [1, -1, 2, -2]) {
    const q = { x: p.x, y: p.y, z: p.z + dz };
    const free = /passed/i.test(await rcon(`execute in minecraft:the_nether if block ${q.x} ${q.y} ${q.z} air`));
    const floor = /failed|未通过/i.test(await rcon(`execute in minecraft:the_nether if block ${q.x} ${q.y - 1} ${q.z} #minecraft:air`)) && !/passed/i.test(await rcon(`execute in minecraft:the_nether if block ${q.x} ${q.y - 1} ${q.z} lava`));
    if (free && floor) { outside = q; break; }
  }
  check(!!outside, `门外有地方站（${outside ? `${outside.x} ${outside.y} ${outside.z}` : '没有'}）`);
  if (outside) {
    const water = await act('bucket', { name: 'water_bucket', text: `${outside.x} ${outside.y} ${outside.z}` });
    check(/evaporated/.test(water), `下界里水倒出来就蒸发（${water.slice(0, 140)}）`);

    begin('从下界的门走回来（人还站在门里：身体先退一步再进）');
    await act('go', { text: `${p.x} ${p.y} ${p.z}` }, 60_000);
    const back = await waitLine(/穿过传送门，到了主世界/, 30_000);
    note(back ?? '（没等到）');
    check(!!back && /overworld/.test(await dimensionNow()), '回到了主世界');
    const book = await session.act({ action: 'journal' });
    note(book.replace(/\n/g, ' | ').slice(0, 500));
    check(/传送门：主世界 \(\d+, \d+, \d+\) ↔ 下界/.test(book), '传送门两头记进了日志');
  }
  // 拆掉门框，免得后面的测试走进去
  await rcon(`fill ${o.x} ${o.y} ${o.z} ${o.x + 3} ${o.y + 4} ${o.z} air`);
  if (!/overworld/.test(await dimensionNow())) {
    await rcon(`execute in minecraft:overworld run tp ${NAME} ${X} ${Y + 1} ${Z}`);
    await sleep(3000);
  }
}

/** 形状图纸（不连服务器也能查的：尺寸、空心封闭、开口、cut、引用、出错的说法）+ 创造模式一层层盖 */
async function creativeCases(): Promise<void> {
  const { parseShapes } = await import('../src/games/minecraft/shapes.js');
  const { placements } = await import('../src/games/minecraft/blueprint.js');
  const cellsOf = (bp: any) => new Set(placements(bp, { x: 0, y: 0, z: 0 }).map((p) => `${p.x},${p.y},${p.z}`));
  const none = () => undefined;

  begin('形状：尺寸和对称');
  let r = parseShapes('materials: Q=quartz_block\nsphere Q center 0 0 0 radius 6', none);
  check(r.blueprint?.width === 13 && r.blueprint?.height === 13 && r.blueprint?.depth === 13, `半径 6 的球 13×13×13（${r.blueprint?.width}×${r.blueprint?.height}×${r.blueprint?.depth}）`);
  r = parseShapes('pyramid sandstone center 0 0 0 radius 4 height 5', none);
  check(r.blueprint?.width === 9 && r.blueprint?.height === 5, `金字塔 9 宽 5 高（${r.blueprint?.width}×${r.blueprint?.height}）`);

  begin('形状：空心封闭、开口、cut、拱、引用别的图纸');
  r = parseShapes('sphere stone center 0 0 0 radius 8 hollow 1', none);
  const shell = cellsOf(r.blueprint!);
  const seen = new Set(['0,0,0']);
  const queue = [[0, 0, 0]];
  let leaked = false;
  while (queue.length && !leaked) {
    const [x, y, z] = queue.pop()!;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = [x + dx, y + dy, z + dz];
      const k = n.join(',');
      if (seen.has(k) || shell.has(k)) continue;
      if (n.some((v) => Math.abs(v) > 10)) { leaked = true; break; }
      seen.add(k);
      queue.push(n);
    }
  }
  check(!shell.has('0,0,0') && !leaked, `空心球：里面空、外壳不漏（外壳 ${shell.size} 块）`);
  const tower = 'materials: S=stone_bricks Q=quartz_block\ncylinder S center 0 0 0 radius 5 height 8 hollow 1 open top\nsphere Q center 0 8 0 radius 5 top hollow 1\ncone copper_block center 0 14 0 radius 1 height 3\ncut box from -1 1 -6 to 1 3 -4';
  r = parseShapes(tower, none);
  const t = cellsOf(r.blueprint!);
  check(t.has('0,0,0') && !t.has('0,5,0') && !t.has('0,9,0'), '塔有地板，塔身和穹顶里面是空的');
  check(!t.has('0,7,0') && !t.has('0,8,0'), '塔顶（open top）和穹顶的切面都没封：塔和穹顶之间是通的');
  check(!t.has('0,2,-5') && t.has('0,4,-5') && t.has('0,0,-5'), '门洞挖出来了（门上面、门下面还是墙）');
  r = parseShapes('arch stone center 0 0 0 radius 3 length 5 axis x hollow 1', none);
  const a = cellsOf(r.blueprint!);
  check(a.has('0,3,0') && a.has('0,0,3') && !a.has('0,1,0'), '拱：拱顶有、两脚着地、拱洞里空');
  const plank = parseShapes('box oak_planks from 0 0 0 to 1 1 0', none).blueprint!;
  r = parseShapes('box stone from 0 0 0 to 4 0 4\nblueprint 小板 at 1 1 1', (n) => (n === '小板' ? plank : undefined));
  const b = cellsOf(r.blueprint!);
  check(b.has('1,1,1') && b.has('2,2,1') && b.size === 29, `blueprint 引用放对了（${b.size} 块）`);

  begin('形状：写错了会说清楚');
  for (const [text, want] of [['sphere Q center 0 0', /center/], ['sphere Z center 0 0 0 radius 2', /materials/], ['box stone from 0 0 0 to 300 1 1', /太大/], ['torus stone center 0 0 0', /box/], ['blueprint 没有的 at 0 0 0', /没有叫/]] as [string, RegExp][]) {
    const e = parseShapes(text, none);
    check(!e.blueprint && want.test(e.errors[0] ?? ''), `「${text}」→ ${e.errors[0]}`);
  }

  // ---- 创造模式：开一局创造模式（在原来的场地东边 60 格的空中） ----
  begin('创造模式：开局切成创造');
  await session.stop();
  session = newSession(true);
  const start = await session.start();
  note(start.split('\n')[0]);
  await sleep(1500);
  check(/passed|Test passed/i.test(await rcon(`execute if entity @a[name=${NAME},gamemode=creative]`)), '她是创造模式');
  const C = { x: X + 60, y: Y + 1, z: Z };
  for (let y = C.y - 2; y <= C.y + 30; y++) await rcon(`fill ${C.x - 30} ${y} ${C.z - 12} ${C.x + 30} ${y} ${C.z + 12} air`);

  begin('创造模式：形状图纸设计、看切片、一层层盖出来');
  const designed = await session.act({ action: 'design', name: '穹顶塔', text: tower });
  note(designed.split('\n').slice(0, 2).join(' | '));
  check(/存好了/.test(designed) && /创造模式不用材料/.test(designed) && /宽 11.*深 11.*高 17/.test(designed), '存好了，11×11×17，说了不用材料');
  const slice = await session.act({ action: 'view', name: '穹顶塔', index: 3 });
  check(/第 3 层/.test(slice) && /S\.+S/.test(slice), `view 看得到第 3 层的切片（墙中间是空的）`);
  const built = await act('build', { name: '穹顶塔', text: `${C.x} ${C.y} ${C.z}` }, 120_000);
  check(/：做完了/.test(built), `盖完了（${built.slice(0, 120)}）`);
  const is = async (dx: number, dy: number, dz: number, block: string) => /passed/i.test(await rcon(`execute if block ${C.x + dx} ${C.y + dy} ${C.z + dz} ${block}`));
  const wall = await is(5, 3, 0, 'stone_bricks');
  const dome = await is(0, 13, 0, 'quartz_block');
  const spire = await is(0, 16, 0, 'copper_block');
  if (!(wall && dome && spire)) note(`那三格现在是：${await rcon(`execute if block ${C.x + 5} ${C.y + 3} ${C.z} air`)} / ${await rcon(`execute if block ${C.x} ${C.y + 13} ${C.z} air`)} / ${await rcon(`execute if block ${C.x} ${C.y + 16} ${C.z} air`)}`);
  check(wall && dome && spire, `墙、穹顶顶上、尖顶都在（墙 ${wall}，穹顶 ${dome}，尖顶 ${spire}）`);
  check(await is(0, 5, 0, 'air') && await is(0, 9, 0, 'air') && await is(0, 2, -5, 'air'), '塔里面、穹顶里面、门洞是空的');
  const ghosts = Number((await rcon('execute if entity @e[type=block_display,tag=dsh_ghost]')).match(/count:\s*(\d+)/i)?.[1] ?? 0);
  check(ghosts === 0, `虚影撤干净了（还剩 ${ghosts}）`);

  begin('创造模式：字符图的门上下两半都在');
  await session.act({ action: 'template', name: 'cabin' });
  const cabin = { x: C.x + 12, y: C.y, z: C.z - 3 };
  const cabinLine = await act('build', { name: 'cabin', text: `${cabin.x} ${cabin.y} ${cabin.z}` }, 120_000);
  check(/：做完了/.test(cabinLine), `小木屋盖完了（${cabinLine.slice(0, 100)}）`);
  check(/passed/i.test(await rcon(`execute if block ${cabin.x + 3} ${cabin.y + 1} ${cabin.z + 5} oak_door[half=lower,facing=north]`))
    && /passed/i.test(await rcon(`execute if block ${cabin.x + 3} ${cabin.y + 2} ${cabin.z + 5} oak_door[half=upper,facing=north]`)), '门：下半、上半都在，朝向对');

  begin('创造模式：盖到一半停下');
  const big = 'sphere glass center 0 20 0 radius 20 hollow 1';
  check(/存好了/.test(await session.act({ action: 'design', name: '大玻璃球', text: big })), '大玻璃球（41 宽）存好了');
  const startBig = await session.act({ action: 'build', name: '大玻璃球', text: `${C.x - 30} ${C.y} ${C.z}` });
  note(startBig.split('\n')[0]);
  await sleep(4000);
  const stopped = await session.act({ action: 'stop' });
  check(/停下了/.test(stopped), `stop 停下了（${stopped.slice(0, 60)}）`);
  await sleep(1500);
  const top = /passed/i.test(await rcon(`execute if block ${C.x - 30} ${C.y + 40} ${C.z} glass`));
  check(!top, '没盖完（顶上还没有）');
  const ghosts2 = Number((await rcon('execute if entity @e[type=block_display,tag=dsh_ghost]')).match(/count:\s*(\d+)/i)?.[1] ?? 0);
  check(ghosts2 === 0, `停下以后虚影撤了（还剩 ${ghosts2}）`);

  begin('创造模式：日志记下了盖好的建筑');
  const book = await session.act({ action: 'journal' });
  check(/「穹顶塔」在 \(1060, 201, 1000\)，盖完了/.test(book), '穹顶塔记进了日志');

  // 收拾：拆掉盖的东西，切回生存（后面的测试是生存的）
  for (let y = C.y - 2; y <= C.y + 42; y++) await rcon(`fill ${C.x - 52} ${y} ${C.z - 22} ${C.x + 20} ${y} ${C.z + 22} air`);
  await session.stop();
  session = newSession(false);
  await session.start();
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
}

async function reset(): Promise<void> {
  await rcon(`clear ${NAME}`);
  await rcon(`effect clear ${NAME}`);
  await rcon(`effect give ${NAME} saturation 2 20`);
  await rcon(`kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`);
}

function newSession(creative = false): MinecraftSession {
  return new MinecraftSession({
    creative,
    workerPath: path.join(ROOT, 'packages', 'dsh-game', 'lib', 'minecraft-worker.cjs'),
    host: '127.0.0.1', port: Number(props['server-port'] || 25565), username: NAME,
    record: () => {}, camera: null, rcon: RCON, journalDir: JOURNAL_DIR,
    log: (text) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`),
  });
}
/** 第一次开局时她看到的（日志测试看「第一次来这个世界」） */
let firstStart = '';

async function main(): Promise<void> {
  const mobSpawning = (await rcon('gamerule doMobSpawning')).match(/(true|false)/)?.[1] ?? 'true';
  await rcon('gamerule doMobSpawning false');
  await rcon('time set day');
  fs.rmSync(JOURNAL_DIR, { recursive: true, force: true });
  session = newSession();
  try {
    firstStart = await session.start();
    note(firstStart.split('\n')[0]);
    await buildArena();
    await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
    await reset();
    await sleep(2000);
    if (SUITE === 'all' || SUITE === 'basic') await basicCases();
    if (SUITE === 'all' || SUITE === 'edge') await edgeCases();
    if (SUITE === 'all' || SUITE === 'build') await buildCases();
    if (SUITE === 'all' || SUITE === 'farm') await farmCases();
    if (SUITE === 'all' || SUITE === 'journal') await journalCases();
    if (SUITE === 'all' || SUITE === 'nether') await netherCases();
    if (SUITE === 'all' || SUITE === 'creative') await creativeCases();
  } finally {
    await session.stop().catch(() => {});
    await rcon(`forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
    await rcon(`gamerule doMobSpawning ${mobSpawning}`);
    await rcon('time set day');
  }
  report();
}

/** 基本操作：采集、合成、熔炼、排队、放置、寻找、装备、丢捡、战斗、吃、躲、睡、逃、停 */
async function basicCases(): Promise<void> {
  {
    begin('采集原木');
    await step('collect', { name: 'oak_log', index: 5 }, { atLeast: { oak_log: 5 } });

    begin('合成木板（数量）');
    await step('craft', { name: 'oak_planks', index: 8 }, { gain: { oak_planks: 8, oak_log: -2 }, noDrops: true });

    begin('合成木棍、工作台');
    await step('craft', { name: 'stick', index: 4 }, { gain: { stick: 4 }, noDrops: true });
    await step('craft', { name: 'crafting_table', index: 1 }, { gain: { crafting_table: 1 }, noDrops: true });

    begin('合成木镐（要工作台，自己放）');
    await step('craft', { name: 'wooden_pickaxe', index: 1 }, { gain: { wooden_pickaxe: 1 }, noDrops: true });

    begin('采集圆石（用木镐）');
    // 石镐 3 个 + 熔炉 8 个
    await step('collect', { name: 'cobblestone', index: 11 }, { atLeast: { cobblestone: 11 } });

    begin('合成石镐、熔炉');
    await step('craft', { name: 'stone_pickaxe', index: 1 }, { gain: { stone_pickaxe: 1 }, noDrops: true });
    await step('craft', { name: 'furnace', index: 1 }, { gain: { furnace: 1 }, noDrops: true });

    begin('采集铁矿（挖下来是粗铁）');
    await step('collect', { name: 'iron_ore', index: 3 }, { atLeast: { raw_iron: 3 } });

    begin('采集煤');
    await step('collect', { name: 'coal', index: 2 }, { atLeast: { coal: 2 } });

    begin('熔炼铁锭');
    await step('smelt', { name: 'iron_ingot', index: 3 }, { gain: { iron_ingot: 3 }, noDrops: true });

    begin('排队：连着合成火把和木棍');
    // 两件一起下，第二件排在第一件后面；两件都做完以后看总数（单件的背包变化这里分不开）
    const torch0 = await serverCount('torch');
    const first = act('craft', { name: 'torch', index: 4 });
    await sleep(300);
    const second = act('craft', { name: 'stick', index: 4 });
    const [l1, l2] = await Promise.all([first, second]);
    check(/做完了/.test(l1) && /做完了/.test(l2), '两件都做完了');
    check((await serverCount('torch')) - torch0 === 4, `火把多了 ${(await serverCount('torch')) - torch0}（应为 4）`);
    check((await droppedNearby()) === 0, '脚边没有掉落物');
    await inventoryMatches(['torch', 'stick', 'coal']);

    begin('合成床（羊毛 + 木板）');
    await rcon(`give ${NAME} white_wool 3`);
    await sleep(800);
    await step('craft', { name: 'white_bed', index: 1 }, { gain: { white_bed: 1 }, noDrops: true });

    begin('放方块');
    await rcon(`give ${NAME} cobblestone 2`);
    await sleep(800);
    const placeAt = `${X + 2} ${Y + 1} ${Z - 2}`;
    await step('place', { name: 'cobblestone', text: placeAt }, { ok: /：做完了/, gain: { cobblestone: -1 } });
    check(/passed/i.test(await rcon(`execute if block ${placeAt} cobblestone`)), '那个位置真的放了圆石');

    begin('找方块、找生物');
    const foundOre = await session.act({ action: 'find', name: 'coal_ore' });
    note(foundOre.slice(0, 160));
    check(/找到了/.test(foundOre) || /没找到/.test(foundOre), '找方块有回答');
    await rcon(`summon cow ${X + 3} ${Y + 1} ${Z + 3}`);
    await sleep(1000);
    const foundCow = await session.act({ action: 'find', name: 'cow' });
    note(foundCow.slice(0, 160));
    check(/找到了/.test(foundCow), '找到了牛');

    begin('装备：拿工具、穿盔甲');
    await rcon(`give ${NAME} iron_helmet 1`);
    await sleep(800);
    const eq1 = await session.act({ action: 'equip', name: 'stone_pickaxe' });
    note(eq1.slice(0, 160));
    check(/做完了/.test(eq1), '拿上石镐');
    const eq2 = await session.act({ action: 'equip', name: 'iron_helmet' });
    note(eq2.slice(0, 160));
    check(/做完了/.test(eq2), '穿上铁头盔');
    const hud = await body().command<any>('hud-state', {}, 5000);
    check(hud?.armor === 2, `HUD 的盔甲值 ${hud?.armor}（应为 2）`);
    check(/stone_pickaxe/.test(JSON.stringify(hud?.hotbar?.[hud?.selected])), `HUD 选中的是石镐（${JSON.stringify(hud?.hotbar?.[hud?.selected])}）`);

    begin('丢东西、再捡回来');
    await rcon(`give ${NAME} dirt 5`);
    await sleep(800);
    await step('drop', { name: 'dirt', index: 3 }, { ok: /：做完了/, gain: { dirt: -3 } });
    await sleep(2500);
    await step('pickup', {}, { atLeast: { dirt: 3 } });

    begin('打牛');
    await step('attack', { name: 'cow', index: 1 }, { ok: /做完了/ });

    begin('吃东西（饿了自动吃）');
    await rcon(`give ${NAME} bread 4`);
    await rcon(`effect give ${NAME} hunger 20 120`);
    await sleep(8000);
    const food0 = (await body().command<any>('status', {}, 5000)).food;
    note(`饿了以后饱食度 ${food0}`);
    await rcon(`effect clear ${NAME} hunger`);
    await sleep(8000);
    const food1 = (await body().command<any>('status', {}, 5000)).food;
    check(food1 >= 16 || (await serverCount('bread')) < 4, `自动吃了面包（饱食度 ${food0} → ${food1}，面包剩 ${await serverCount('bread')}）`);
    await inventoryMatches(['bread']);

    begin('躲地下（挖三格封顶）');
    await step('hide', {}, { ok: /做完了/ });
    await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
    await sleep(1500);

    begin('晚上睡觉（背包里的床）');
    await rcon('time set 13000');
    await rcon(`kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..40]`);
    await sleep(1000);
    await step('sleep', {}, { ok: /做完了/ });

    begin('逃跑');
    await rcon(`summon zombie ${X + 3} ${Y + 1} ${Z}`);
    await rcon(`summon zombie ${X + 4} ${Y + 1} ${Z + 1}`);
    await sleep(500);
    await step('flee', {}, { ok: /做完了|没成/ });
    await rcon(`kill @e[type=zombie,x=${X},y=${Y},z=${Z},distance=..40]`);

    begin('停下：采集到一半 stop');
    await rcon(`give ${NAME} iron_axe 1`);
    await sleep(800);
    const startReply = await session.act({ action: 'collect', name: 'cobblestone', index: 30 });
    note(startReply.slice(0, 80));
    await sleep(4000);
    const stopReply = await session.act({ action: 'stop' });
    note(stopReply.slice(0, 120));
    check(/停下了/.test(stopReply), 'stop 有回答');
    await sleep(2000);
    const cursor = await body().command<any>('hud-state', {}, 5000);
    check(!!cursor, '停下以后身体还在');
    await inventoryMatches();
  }
}

function report(): void {
  console.log('\n========== 结果');
  for (const r of results) console.log(`${r.ok ? '通过' : '失败'}  ${r.name}${r.notes.length ? `\n      ${r.notes.join('\n      ')}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
