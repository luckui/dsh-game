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
import { RconLink, rcon as rconRaw, type RconTarget } from '../src/games/minecraft/rcon.js';

const ROOT = path.resolve(process.argv[2] ?? '.');
/** 跑哪些：basic（基本操作）、edge（名字、配方回环、掉落和数量、氧气只算自己的；breath 只跑氧气这项）、build（盖房子）、farm（种地、养动物）、journal（世界日志）、nether（桶、黑曜石、下界传送门）、creative（形状图纸、创造模式一层层盖）、rcon（跟拍用的常开 RCON 连接：连发的命令每条都执行）、live（第一场直播报的身体问题）、不填 = 全部 */
const SUITE = process.argv[3] ?? 'all';
const props = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.mc-server', 'server.properties'), 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const RCON: RconTarget = { host: '127.0.0.1', port: Number(props['rcon.port'] || 25575), password: props['rcon.password'] };
const NAME = 'SelfTest';
// 离她的世界远一点（她在 1000 附近盖了岛、教堂、灯塔）：场地和她的建筑互不碰
const X = 5000, Y = 200, Z = 5000;
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
  if (!/^开始|排上了|^先停下/.test(reply)) return reply;
  const label = reply.match(/^开始(.+?)。/)?.[1] ?? reply.match(/「(.+?)」排上了/)?.[1] ?? reply.match(/^先停下.+?，开始(.+?)[；。（]/)?.[1] ?? '';
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
  // 底下一层基岩、四周和顶上是屏障（挖不动、看不见）：寻路器为了够下面的东西把地板挖穿、凿墙出去，就会从 200 格高摔下去
  await rcon(`fill ${X - 10} ${Y - 5} ${Z - 10} ${X + 10} ${Y - 5} ${Z + 10} bedrock`);
  await rcon(`fill ${X - 10} ${Y + 7} ${Z - 10} ${X + 10} ${Y + 7} ${Z + 10} barrier`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z - 10} ${X + 10} ${Y + 6} ${Z - 10} barrier`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z + 10} ${X + 10} ${Y + 6} ${Z + 10} barrier`);
  await rcon(`fill ${X - 10} ${Y + 1} ${Z - 10} ${X - 10} ${Y + 6} ${Z + 10} barrier`);
  await rcon(`fill ${X + 10} ${Y + 1} ${Z - 10} ${X + 10} ${Y + 6} ${Z + 10} barrier`);
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

  begin('不把脚下挖空：浮空的小平台，正下方 10 格有羊毛');
  {
    const F = { x: X - 14, y: Y, z: Z - 14 };
    await rcon(`fill ${F.x - 1} ${F.y} ${F.z - 1} ${F.x + 1} ${F.y} ${F.z + 1} dirt`);
    await rcon(`setblock ${F.x} ${F.y - 10} ${F.z} white_wool`);
    await rcon(`tp ${NAME} ${F.x + 0.5} ${F.y + 1} ${F.z + 0.5}`);
    await sleep(1500);
    const wool = await act('collect', { name: 'white_wool', index: 1 }, 90_000);
    const pos = (await rcon(`data get entity ${NAME} Pos`)).match(/-?\d+(\.\d+)?(?=d)/g)?.map(Number) ?? [];
    check(pos.length === 3 && pos[1] >= F.y && /passed/i.test(await rcon(`execute if block ${F.x} ${F.y} ${F.z} dirt`)), `没把平台挖穿掉下去（她在 y=${pos[1]?.toFixed(1)}；${wool.slice(0, 100)}）`);
    await rcon(`fill ${F.x - 1} ${F.y - 10} ${F.z - 1} ${F.x + 1} ${F.y} ${F.z + 1} air`);
    await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
    await sleep(1500);
  }

  begin('砍树：旁边地上有别的东西，报的背包变化要和真实一致');
  await reset();
  await rcon(`summon item ${X + 2} ${Y + 1} ${Z + 5} {Item:{id:"minecraft:stick",count:3}}`);
  await rcon(`summon item ${X + 3} ${Y + 1} ${Z + 6} {Item:{id:"minecraft:apple",count:1}}`);
  await sleep(500);
  await step('collect', { name: 'oak_log', index: 4 }, { atLeast: { oak_log: 4 } });

  await breathCases();
}

/** 氧气只算她自己的：旁边的生物在水里憋气，她站在岸上，氧气不该跟着掉 */
async function breathCases(): Promise<void> {
  begin('氧气：旁边水里有憋着气的猪，她在岸上，氧气一直是满的');
  // 玻璃罩着一格 1×2 的水，猪整个泡在里面（无敌：一直憋着气、一直淹，不会死），离她 10 来格
  const P = { x: X - 11, y: Y + 2, z: Z + 11 };
  await rcon(`fill ${P.x - 1} ${P.y - 1} ${P.z - 1} ${P.x + 1} ${P.y + 2} ${P.z + 1} glass hollow`);
  await rcon(`fill ${P.x} ${P.y} ${P.z} ${P.x} ${P.y + 1} ${P.z} water`);
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1000);
  const where = async () => (await rcon(`data get entity ${NAME} Pos`)).match(/-?\d+(\.\d+)?(?=d)/g)?.map(Number) ?? [];
  const start = await where();
  for (let i = 0; i < 2; i++) await rcon(`summon pig ${P.x + 0.5} ${P.y} ${P.z + 0.5} {Air:0s,Invulnerable:1b}`);
  const seen: number[] = [];
  const heard: string[] = [];
  for (let i = 0; i < 12; i++) {
    heard.push(...(await session.wait(AbortSignal.timeout(500), 500)).lines);
    const snap = await body().command<any>('snapshot', {}, 10_000);
    seen.push(Number(snap?.body?.oxygen));
  }
  // 身体以为要淹死会自己去找空气（她收到「憋死」那句要等它找完）：再听一会儿
  for (let i = 0; i < 10; i++) heard.push(...(await session.wait(AbortSignal.timeout(1000), 1000)).lines);
  const end = await where();
  const moved = start.length === 3 && end.length === 3 ? Math.hypot(end[0] - start[0], end[2] - start[2]) : NaN;
  check(seen.every((o) => o === 20), `身体报的氧气都是 20（${seen.join(' ')}）`);
  check(!heard.some((l) => /憋死/.test(l)), `她没收到「在水里憋死」${heard.length ? `（她收到：${heard.join(' / ').slice(0, 200)}）` : ''}`);
  check(moved < 1, `身体没自己跑去找空气（挪了 ${moved.toFixed(1)} 格）`);
  await rcon(`kill @e[type=pig,x=${P.x},y=${P.y},z=${P.z},distance=..3]`);
  await rcon(`fill ${P.x - 1} ${P.y - 1} ${P.z - 1} ${P.x + 1} ${P.y + 2} ${P.z + 1} air`);
}

// ---------- 第一场直播（2026-10-25）报的身体问题：每项先在这里复现，修好以后留着防回退 ----------
/** 开阔的场地（逃跑要跑得开）：61×61 草地，下面五层土、再下面基岩 */
const LX = 5300, LY = 200, LZ = 5000;
async function buildLiveArena(): Promise<void> {
  await rcon(`forceload add ${LX - 32} ${LZ - 32} ${LX + 32} ${LZ + 32}`);
  await sleep(1500);
  for (let y = LY - 6; y <= LY + 10; y++) await rcon(`fill ${LX - 30} ${y} ${LZ - 30} ${LX + 30} ${y} ${LZ + 30} air`);
  await rcon(`fill ${LX - 30} ${LY - 6} ${LZ - 30} ${LX + 30} ${LY - 6} ${LZ + 30} bedrock`);
  for (let y = LY - 5; y < LY; y++) await rcon(`fill ${LX - 30} ${y} ${LZ - 30} ${LX + 30} ${y} ${LZ + 30} dirt`);
  await rcon(`fill ${LX - 30} ${LY} ${LZ - 30} ${LX + 30} ${LY} ${LZ + 30} grass_block`);
  await rcon(`kill @e[type=!player,x=${LX},y=${LY},z=${LZ},distance=..45]`);
}
async function liveReset(at = { x: LX, z: LZ }): Promise<void> {
  await act('stop');
  await rcon(`kill @e[type=!player,x=${LX},y=${LY},z=${LZ},distance=..45]`);
  await rcon(`clear ${NAME}`);
  await rcon(`effect give ${NAME} resistance 120 4 true`);
  await rcon(`tp ${NAME} ${at.x + 0.5} ${LY + 1} ${at.z + 0.5}`);
  await sleep(1500);
}
async function heldItem(): Promise<string> {
  return (await rcon(`data get entity ${NAME} SelectedItem.id`)).match(/"minecraft:([a-z_]+)"/)?.[1] ?? 'nothing';
}
async function herPos(): Promise<number[]> {
  return (await rcon(`data get entity ${NAME} Pos`)).match(/-?\d+(\.\d+)?(?=d)/g)?.map(Number) ?? [];
}

/** 只跑名字里带这个的几项（mc-selftest.mjs live 直播3）；不填就全跑 */
const PICK = (process.argv[4] ?? '').replace(/\s/g, '');
const want = (label: string) => !PICK || label.replace(/\s/g, '').includes(PICK);

async function liveCases(): Promise<void> {
  await buildLiveArena();

  if (want('直播 1：打怪先拿最好的武器，打完换回原来手里的')) {
    begin('直播 1：打怪先拿最好的武器，打完换回原来手里的');
    {
      await liveReset();
      await rcon(`give ${NAME} cobblestone 59`);
      await rcon(`give ${NAME} stone_pickaxe 1`);
      await rcon(`give ${NAME} diamond_sword 1`);
      await sleep(800);
      await session.act({ action: 'equip', name: 'cobblestone' });
      await rcon(`summon husk ${LX + 3} ${LY + 1} ${LZ} {NoAI:1b}`);
      const seen = new Set<string>();
      let watching = true;
      const line = await act('attack', { name: 'husk', index: 1 }, 90_000, async () => {
        while (watching) {
          seen.add(await heldItem());
          await sleep(300);
        }
      });
      watching = false;
      check(/：做完了/.test(line), `打死了（${line.slice(0, 100)}）`);
      check(seen.has('diamond_sword'), `打的时候拿的是钻石剑（看到手里拿过：${[...seen].join('、')}）`);
      await sleep(500);
      check((await heldItem()) === 'cobblestone', `打完换回圆石（手里是 ${await heldItem()}）`);
    }
  }

  if (want('直播 7：采集被叫停以后马上逃跑，要真的跑开')) {
    begin('直播 7：采集被叫停以后马上逃跑，要真的跑开');
    {
      await liveReset();
      await rcon(`give ${NAME} stone_pickaxe 1`);
      await rcon(`fill ${LX + 20} ${LY + 1} ${LZ + 20} ${LX + 22} ${LY + 2} ${LZ + 22} stone`);
      await rcon(`summon zombie ${LX - 3} ${LY + 1} ${LZ} {NoAI:1b}`);
      await sleep(800);
      await session.act({ action: 'collect', name: 'cobblestone', index: 8 });
      await sleep(2500);
      await act('stop');
      const start = await herPos();
      const line = await act('flee', {}, 60_000);
      const end = await herPos();
      const moved = start.length && end.length ? Math.hypot(end[0] - start[0], end[2] - start[2]) : 0;
      check(/：做完了/.test(line), `逃跑做完了（${line.slice(0, 160)}）`);
      check(moved >= 8, `跑开了 ${moved.toFixed(1)} 格（至少 8）`);
    }
  }

  if (want('直播 7：正在采集时下逃跑，马上开始，不排队')) {
    begin('直播 7：正在采集时下逃跑，马上开始，不排队');
    {
      await liveReset();
      await rcon(`give ${NAME} stone_pickaxe 1`);
      await rcon(`fill ${LX + 20} ${LY + 1} ${LZ + 20} ${LX + 22} ${LY + 2} ${LZ + 22} stone`);
      await rcon(`summon zombie ${LX - 3} ${LY + 1} ${LZ} {NoAI:1b}`);
      await sleep(800);
      await session.act({ action: 'collect', name: 'cobblestone', index: 8 });
      await sleep(2500);
      const line = await act('flee', {}, 60_000);
      note(`逃跑：${line.slice(0, 200)}`);
      check(/^逃开怪物：做完了/.test(line), `逃跑马上开始、做完了（${line.slice(0, 120)}）`);
      check(/接着做排着的「采集 cobblestone/.test(line), '逃完接着采集');
      await act('stop');
    }
  }

  if (want('直播 1/7：采集时挨打，身体停下采集、拿上武器还手，告诉她')) {
    begin('直播 1/7：采集时挨打，身体停下采集、拿上武器还手，告诉她');
    {
      await liveReset();
      await rcon(`effect clear ${NAME} resistance`);
      await rcon(`effect give ${NAME} resistance 120 1 true`);
      await rcon(`give ${NAME} stone_pickaxe 1`);
      await rcon(`give ${NAME} diamond_sword 1`);
      await rcon(`fill ${LX + 8} ${LY + 1} ${LZ - 1} ${LX + 10} ${LY + 2} ${LZ + 1} stone`);
      await sleep(800);
      const seen = new Set<string>();
      let watching = true;
      const watcher = (async () => { while (watching) { seen.add(await heldItem()); await sleep(250); } })();
      const heard: string[] = [];
      const line = await act('collect', { name: 'cobblestone', index: 12 }, 120_000, async () => {
        await sleep(3000);
        await rcon(`summon husk ${LX + 6} ${LY + 1} ${LZ + 3}`);
      });
      for (let i = 0; i < 15; i++) {
        heard.push(...(await session.wait(AbortSignal.timeout(1000), 1000)).lines);
        if (heard.some((l) => /身体拿上武器还手/.test(l))) break;
      }
      watching = false;
      await watcher;
      note(`她听到：${heard.join(' / ').slice(0, 300)}`);
      check(/hit her|挨打|fight back/.test(line), `采集停下了，说了是挨打（${line.slice(0, 160)}）`);
      check(heard.some((l) => /被 husk 打了，身体拿上武器还手/.test(l)), '告诉她身体还手了');
      check(seen.has('diamond_sword'), `还手时拿的是钻石剑（手里拿过：${[...seen].join('、')}）`);
      await rcon(`kill @e[type=husk,x=${LX},y=${LY},z=${LZ},distance=..45]`);
    }
  }

  if (want('直播 7：逃跑时挨打，接着跑，不回头打')) {
    begin('直播 7：逃跑时挨打，接着跑，不回头打');
    for (let i = 0; i < 2; i++) {
      await liveReset();
      await rcon(`effect clear ${NAME} resistance`);
      await rcon(`effect give ${NAME} resistance 120 1 true`);
      await rcon(`give ${NAME} diamond_sword 1`);
      // 血厚的尸壳，一出来就追着打；她马上开始逃（跑的时候挨打，不该回头打）
      await rcon(`summon husk ${LX + 3} ${LY + 1} ${LZ} {Health:100f,attributes:[{id:"minecraft:max_health",base:100}]}`);
      const start = await herPos();
      const line = await act('flee', {}, 60_000);
      const end = await herPos();
      const moved = start.length && end.length ? Math.hypot(end[0] - start[0], end[2] - start[2]) : 0;
      check(/逃开怪物：做完了/.test(line) && moved >= 8, `第 ${i + 1} 次：跑开了 ${moved.toFixed(1)} 格（${line.slice(0, 140)}）`);
    }
    await rcon(`kill @e[type=husk,x=${LX},y=${LY},z=${LZ},distance=..45]`);
  }

  if (want('直播 3：find 给出每一处的坐标和距离')) {
    begin('直播 3：find 给出每一处的坐标和距离');
    {
      await liveReset();
      const ores = [[LX + 5, LY - 2, LZ + 3], [LX - 4, LY - 3, LZ + 7], [LX + 9, LY - 4, LZ - 6]];
      for (const [x, y, z] of ores) await rcon(`setblock ${x} ${y} ${z} diamond_ore`);
      await sleep(800);
      const found = await session.act({ action: 'find', name: 'diamond_ore' });
      note(found.replace(/\n/g, ' / ').slice(0, 300));
      for (const [x, y, z] of ores) check(found.includes(`${x} ${y} ${z}`), `列出了 ${x} ${y} ${z}`);
      check(/离你 \d+ 格/.test(found), '说了多远');
      for (const [x, y, z] of ores) await rcon(`setblock ${x} ${y} ${z} dirt`);
    }
  }

  if (want('直播 2：背包满了要直说，列出能丢的')) {
    begin('直播 2：背包满了要直说，列出能丢的');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    // 35 格塞满：圆石、花岗岩、闪长岩、泥土、沙砾各 7 组（每组 64）
    for (const junk of ['cobblestone', 'granite', 'diorite', 'dirt', 'gravel']) await rcon(`give ${NAME} ${junk} ${64 * 7}`);
    await rcon(`setblock ${LX + 2} ${LY} ${LZ} diamond_ore`);
    await sleep(1000);
    const line = await act('collect', { name: 'diamond_ore', index: 1 }, 90_000);
    note(line.slice(0, 300));
    check(/背包满/.test(line), `说了背包满了（${line.slice(0, 160)}）`);
    check(/cobblestone/.test(line) && /drop/.test(line), '列出了能丢的、说了用 drop');
    check(!/chest/.test(line), '没说箱子');
    // 照它说的丢掉一种杂物（一次丢 448 个，不止一组），就地丢、不走开，再采就采到了
    const before = await herPos();
    const dropped = await session.act({ action: 'drop', name: 'granite', index: 448 });
    const after = await herPos();
    note(dropped.slice(0, 160));
    check((await serverCount('granite')) === 0, `花岗岩一次丢完了（还剩 ${await serverCount('granite')}）`);
    check(before.length > 0 && after.length > 0 && Math.hypot(after[0] - before[0], after[2] - before[2]) < 1, '就地丢，没走开');
    await rcon(`kill @e[type=item,x=${LX},y=${LY},z=${LZ},distance=..10]`);
    const again = await act('collect', { name: 'diamond_ore', index: 1 }, 90_000);
    check((await serverCount('diamond')) === 1, `丢完再采，采到钻石了（${again.slice(0, 100)}）`);
    await rcon(`setblock ${LX + 2} ${LY} ${LZ} grass_block`);
  }

  if (want('直播 6：做长动作时 equip、drop、find 马上做，长动作不停')) {
    begin('直播 6：做长动作时 equip、drop、find 马上做，长动作不停');
    await liveReset();
    await rcon(`give ${NAME} stone_pickaxe 1`);
    await rcon(`give ${NAME} diamond_sword 1`);
    await rcon(`give ${NAME} dirt 10`);
    await rcon(`fill ${LX + 15} ${LY + 1} ${LZ + 15} ${LX + 17} ${LY + 2} ${LZ + 17} stone`);
    await sleep(800);
    const start = await session.act({ action: 'collect', name: 'cobblestone', index: 6 });
    await sleep(2000);
    const eq = await session.act({ action: 'equip', name: 'diamond_sword' });
    note(`equip：${eq.slice(0, 120)}`);
    check(!/要等它做完/.test(eq) && /做完了|拿上/.test(eq), `equip 马上做了（${eq.slice(0, 100)}）`);
    const dr = await session.act({ action: 'drop', name: 'dirt', index: 10 });
    check(!/要等它做完/.test(dr) && (await serverCount('dirt')) === 0, `drop 马上做了（${dr.slice(0, 100)}）`);
    const fd = await session.act({ action: 'find', name: 'stone' });
    check(/找到了/.test(fd), `find 马上做了（${fd.slice(0, 80)}）`);
    // 长动作没被打断：最后采到 6 个圆石
    const label = start.match(/^开始(.+?)。/)?.[1] ?? '';
    let done = '';
    for (let i = 0; i < 60 && !done; i++) {
      lines.push(...(await session.wait(AbortSignal.timeout(3000), 3000)).lines);
      done = lines.find((l) => l.startsWith(`${label}：`)) ?? '';
    }
    if (done) lines.splice(lines.indexOf(done), 1);
    check(/：做完了/.test(done), `采集照常做完了（${done.slice(0, 120)}）`);
  }

  if (want('直播 5：埋在石头里的一窝矿都采到')) {
    begin('直播 5：埋在石头里的一窝矿都采到');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    // 一大块石头（东边 3 格起，7×5×7），里面埋三块钻石矿：离石头表面 2~3 格，哪一面都露不出来
    await rcon(`fill ${LX + 3} ${LY + 1} ${LZ - 3} ${LX + 9} ${LY + 5} ${LZ + 3} stone`);
    const ores = [[LX + 5, LY + 2, LZ], [LX + 6, LY + 2, LZ], [LX + 6, LY + 3, LZ + 1]];
    for (const [x, y, z] of ores) await rcon(`setblock ${x} ${y} ${z} diamond_ore`);
    await sleep(1000);
    const t0 = Date.now();
    const line = await act('collect', { name: 'diamond_ore', index: 3 }, 180_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    note(line.slice(0, 240));
    check((await serverCount('diamond')) === 3, `三块都采到了（${await serverCount('diamond')} 个，${secs} 秒）`);
    check(secs <= 90, `90 秒内（用了 ${secs} 秒）`);
    await rcon(`fill ${LX + 3} ${LY + 1} ${LZ - 3} ${LX + 9} ${LY + 5} ${LZ + 3} air`);
  }

  if (want('直播 5：远处石头里的矿')) {
    begin('直播 5：远处石头里的矿（15~25 格外，中间全是石头）');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    // 地下：一整块 41×12×41 的石头，她在中间一个 3×3×3 的小洞里
    for (let y = LY - 5; y <= LY + 6; y++) await rcon(`fill ${LX - 20} ${y} ${LZ - 20} ${LX + 20} ${y} ${LZ + 20} stone`);
    await rcon(`fill ${LX - 1} ${LY + 1} ${LZ - 1} ${LX + 1} ${LY + 3} ${LZ + 1} air`);
    const ores = [[LX + 15, LY + 1, LZ + 2], [LX - 3, LY - 2, LZ + 18], [LX - 17, LY + 4, LZ - 12]];
    for (const [x, y, z] of ores) await rcon(`setblock ${x} ${y} ${z} diamond_ore`);
    await rcon(`tp ${NAME} ${LX + 0.5} ${LY + 1} ${LZ + 0.5}`);
    await sleep(1500);
    const t0 = Date.now();
    const line = await act('collect', { name: 'diamond_ore', index: 3 }, 400_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    note(line.slice(0, 300));
    note(`采到 ${await serverCount('diamond')} 个，${secs} 秒`);
    check((await serverCount('diamond')) === 3 || /走不到|cannot reach|could not/.test(line), `要么都采到，要么说清哪几块为什么采不到（${line.slice(0, 160)}）`);
    check(secs <= 180, `3 分钟内有结果（用了 ${secs} 秒）`);
    for (let y = LY - 5; y <= LY + 6; y++) await rcon(`fill ${LX - 20} ${y} ${LZ - 20} ${LX + 20} ${y} ${LZ + 20} air`);
    for (let y = LY - 5; y < LY; y++) await rcon(`fill ${LX - 20} ${y} ${LZ - 20} ${LX + 20} ${y} ${LZ + 20} dirt`);
    await rcon(`fill ${LX - 20} ${LY} ${LZ - 20} ${LX + 20} ${LY} ${LZ + 20} grass_block`);
  }

  if (want('直播 8：矿道里挂着洞穴藤蔓')) {
    begin('直播 8：矿道里挂着洞穴藤蔓，照样走过去采矿');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    // 东边一块石头，挖一条 1×2、12 格长的矿道；矿道上半格每隔一格挂一株洞穴藤蔓；尽头一块钻石矿
    await rcon(`fill ${LX + 2} ${LY + 1} ${LZ - 2} ${LX + 16} ${LY + 4} ${LZ + 2} stone`);
    await rcon(`fill ${LX + 2} ${LY + 1} ${LZ} ${LX + 14} ${LY + 2} ${LZ} air`);
    for (let x = LX + 4; x <= LX + 12; x += 2) await rcon(`setblock ${x} ${LY + 2} ${LZ} cave_vines_plant`);
    await rcon(`setblock ${LX + 15} ${LY + 1} ${LZ} diamond_ore`);
    await sleep(1000);
    const t0 = Date.now();
    const line = await act('collect', { name: 'diamond_ore', index: 1 }, 180_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    note(line.slice(0, 240));
    check((await serverCount('diamond')) === 1, `采到了（${secs} 秒）`);
    check(secs <= 40, `40 秒内（用了 ${secs} 秒）`);
    await rcon(`fill ${LX + 2} ${LY + 1} ${LZ - 2} ${LX + 16} ${LY + 4} ${LZ + 2} air`);
  }

  if (want('直播 11：死亡提示按死亡不掉落说')) {
    begin('直播 11：死亡提示按「死亡不掉落」的实际设置说');
    const was = (await rcon('gamerule keepInventory')).match(/(true|false)/)?.[1] ?? 'false';
    for (const keep of ['true', 'false']) {
      await liveReset();
      await rcon(`gamerule keepInventory ${keep}`);
      await rcon(`effect clear ${NAME}`);
      await sleep(500);
      await rcon(`kill ${NAME}`);
      const heard: string[] = [];
      for (let i = 0; i < 10 && !heard.some((l) => /你死了/.test(l)); i++) heard.push(...(await session.wait(AbortSignal.timeout(1000), 1000)).lines);
      const line = heard.find((l) => /你死了/.test(l)) ?? '';
      note(`keepInventory=${keep}：${line}`);
      check(keep === 'true' ? /还在身上/.test(line) && !/掉在死的地方/.test(line) : /掉在死的地方/.test(line) && !/还在身上/.test(line), `keepInventory=${keep} 说得对（${line.slice(0, 80)}）`);
      await sleep(3000);
    }
    await rcon(`gamerule keepInventory ${was}`);
  }

  if (want('直播 12：目标标上写的时间')) {
    begin('直播 12：目标是她的原话，标上写的时间');
    await session.act({ action: 'goal', text: '一身钻石装备：现在有 7 颗，还要挖 17 颗' });
    const notes = (await session.wait(AbortSignal.timeout(3000), 2000)).notes.join(' ');
    note(notes.slice(0, 200));
    check(/你的目标（你 \d\d:\d\d 写的）：一身钻石装备/.test(notes), '每个时刻的提醒里标了写的时间');
  }

  if (want('倒水：庄稼和草旁边挖坑倒水')) {
    begin('倒水：庄稼和草旁边挖坑倒水（不同站位，水要进坑、不冲庄稼）');
    for (let round = 0; round < 2; round++) {
      for (const [label, sx, sz] of [['田的斜对角', LX + 4.5, LZ + 4.5], ['田上', LX + 4.5, LZ + 3.5], ['草地上', LX + 6.5, LZ + 3.5], ['离坑两格', LX + 7.5, LZ + 5.5]] as const) {
        await liveReset({ x: Math.floor(sx), z: Math.floor(sz) });
        await rcon(`fill ${LX + 1} ${LY + 1} ${LZ + 1} ${LX + 9} ${LY + 1} ${LZ + 7} short_grass replace air`);
        await rcon(`fill ${LX + 3} ${LY} ${LZ + 3} ${LX + 4} ${LY} ${LZ + 4} farmland[moisture=7]`);
        await rcon(`fill ${LX + 3} ${LY + 1} ${LZ + 3} ${LX + 4} ${LY + 1} ${LZ + 4} carrots`);
        await rcon(`give ${NAME} water_bucket 1`);
        await rcon(`tp ${NAME} ${sx} ${LY + 1} ${sz}`);
        await sleep(1200);
        await act('dig', { text: `${LX + 5} ${LY} ${LZ + 3}` }, 60_000);
        const line = await act('bucket', { name: 'water_bucket', text: `${LX + 5} ${LY} ${LZ + 3}` }, 60_000);
        const source = /passed/i.test(await rcon(`execute if block ${LX + 5} ${LY} ${LZ + 3} water[level=0]`));
        const crops = Number((await rcon(`execute if blocks ${LX + 3} ${LY + 1} ${LZ + 3} ${LX + 4} ${LY + 1} ${LZ + 4} ${LX + 3} ${LY + 1} ${LZ + 3} all`)).match(/count: (\d+)/)?.[1] ?? -1);
        let carrots = 0;
        for (const [x, z] of [[3, 3], [3, 4], [4, 3], [4, 4]]) if (/passed/i.test(await rcon(`execute if block ${LX + x} ${LY + 1} ${LZ + z} carrots`))) carrots++;
        void crops;
        check(source && carrots === 4, `第 ${round + 1} 轮 ${label}：坑里是水源 ${source}，胡萝卜还剩 ${carrots}/4（${line.slice(0, 120)}）`);
        await rcon(`fill ${LX + 1} ${LY - 1} ${LZ + 1} ${LX + 9} ${LY - 1} ${LZ + 7} dirt`);
        await rcon(`fill ${LX + 1} ${LY} ${LZ + 1} ${LX + 9} ${LY} ${LZ + 7} grass_block`);
        await rcon(`fill ${LX + 1} ${LY + 1} ${LZ + 1} ${LX + 9} ${LY + 2} ${LZ + 7} air`);
      }
    }
  }

  if (want('直播：go 在地下挖穿石头')) {
    begin('直播：go 在地下一路挖过去（40 格实心石头，不用一格格 dig）');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    for (let y = LY - 5; y <= LY + 6; y++) await rcon(`fill ${LX - 22} ${y} ${LZ - 5} ${LX + 22} ${y} ${LZ + 5} stone`);
    await rcon(`fill ${LX - 21} ${LY + 1} ${LZ - 1} ${LX - 19} ${LY + 3} ${LZ + 1} air`);
    await rcon(`tp ${NAME} ${LX - 19.5} ${LY + 1} ${LZ + 0.5}`);
    await sleep(1500);
    const t0 = Date.now();
    const line = await act('go', { text: `${LX + 20} ${LY + 1} ${LZ}` }, 400_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const end = await herPos();
    note(line.slice(0, 200));
    check(/：做完了/.test(line) && end.length > 0 && Math.abs(end[0] - (LX + 20.5)) < 3, `挖过去了（${secs} 秒，停在 ${end.map((n) => n.toFixed(0)).join(' ')}）`);
    for (let y = LY - 5; y <= LY + 6; y++) await rcon(`fill ${LX - 22} ${y} ${LZ - 5} ${LX + 22} ${y} ${LZ + 5} air`);
    for (let y = LY - 5; y < LY; y++) await rcon(`fill ${LX - 22} ${y} ${LZ - 5} ${LX + 22} ${y} ${LZ + 5} dirt`);
    await rcon(`fill ${LX - 22} ${LY} ${LZ - 5} ${LX + 22} ${LY} ${LZ + 5} grass_block`);
  }

  if (want('盾牌：equip 放进副手')) {
    begin('盾牌：equip shield 放进副手');
    await liveReset();
    await rcon(`give ${NAME} shield 1`);
    await rcon(`give ${NAME} iron_sword 1`);
    await sleep(800);
    const r = await session.act({ action: 'equip', name: 'shield' });
    await sleep(500);
    const off = await rcon(`data get entity ${NAME} equipment.offhand.id`);
    const off2 = await rcon(`data get entity ${NAME} Inventory[{Slot:-106b}].id`);
    note(`equip：${r.slice(0, 80)}；副手：${off} / ${off2}`);
    check(/shield/.test(off + off2), '盾在副手');
    await session.act({ action: 'equip', name: 'iron_sword' });
    await sleep(500);
    check((await heldItem()) === 'iron_sword' && /shield/.test((await rcon(`data get entity ${NAME} equipment.offhand.id`)) + (await rcon(`data get entity ${NAME} Inventory[{Slot:-106b}].id`))), '再拿剑：剑在手上、盾还在副手');
  }

  if (want('盾牌：打骷髅')) {
    begin('盾牌：晚上打两只骷髅（真实伤害，不给免伤）：带盾不死、都打死；不带盾作对照');
    await rcon('time set 18000');
    const fight = async (withShield: boolean) => {
      await liveReset();
      await rcon(`effect clear ${NAME}`);
      await rcon(`give ${NAME} iron_sword 1`);
      if (withShield) await rcon(`give ${NAME} shield 1`);
      await sleep(800);
      if (withShield) await session.act({ action: 'equip', name: 'shield' });
      await session.act({ action: 'equip', name: 'iron_sword' });
      await rcon(`effect give ${NAME} instant_health 1 5 true`);
      await sleep(500);
      await rcon(`summon skeleton ${LX + 12} ${LY + 1} ${LZ + 2}`);
      await rcon(`summon skeleton ${LX + 12} ${LY + 1} ${LZ - 2}`);
      const t0 = Date.now();
      const line = await act('attack', { name: 'skeleton', index: 2 }, 120_000);
      const heard: string[] = [];
      for (let i = 0; i < 3; i++) heard.push(...(await session.wait(AbortSignal.timeout(1000), 1000)).lines);
      const died = [line, ...heard].some((l) => /死了/.test(l));
      const health = Number((await rcon(`data get entity ${NAME} Health`)).match(/([\d.]+)f/)?.[1] ?? -1);
      const left = Number((await rcon(`execute if entity @e[type=skeleton,x=${LX},y=${LY},z=${LZ},distance=..40]`)).match(/count: (\d+)/)?.[1] ?? 0);
      note(`${withShield ? '带盾' : '不带盾'}：${Math.round((Date.now() - t0) / 1000)} 秒，死了 ${died}，剩血 ${health}，剩骷髅 ${left}；${line.slice(0, 120)}`);
      const raised = /shield/.test(await rcon(`data get entity ${NAME} SelectedItem.id`)) ? 'held' : '';
      void raised;
      await rcon(`kill @e[type=skeleton,x=${LX},y=${LY},z=${LZ},distance=..60]`);
      await rcon(`kill @e[type=arrow,x=${LX},y=${LY},z=${LZ},distance=..60]`);
      return { died, health, left };
    };
    const without: Array<{ died: boolean; health: number; left: number }> = [];
    const shielded: Array<{ died: boolean; health: number; left: number }> = [];
    for (let i = 0; i < 3; i++) {
      without.push(await fight(false));
      shielded.push(await fight(true));
    }
    for (const [i, r] of shielded.entries()) check(!r.died && r.left === 0, `带盾第 ${i + 1} 场：没死、两只都打死（剩血 ${r.health}，剩 ${r.left} 只）`);
    const lost = (rs: typeof shielded) => (rs.reduce((a, r) => a + (r.died ? 20 : 20 - r.health), 0) / rs.length).toFixed(1);
    note(`平均掉血：带盾 ${lost(shielded)}，不带盾 ${lost(without)}（死了算掉 20）`);
    await rcon('time set day');
  }

  if (want('浮空平台：不追够不着的东西')) {
    begin('浮空平台：下面 10 格的羊毛够不着、地上的掉落物走不到，都不能把她引下平台（连做 3 遍）');
    for (let i = 0; i < 3; i++) {
      await liveReset();
      const F = { x: LX + 10, y: LY + 12, z: LZ + 10 };
      await rcon(`fill ${F.x - 1} ${F.y} ${F.z - 1} ${F.x + 1} ${F.y} ${F.z + 1} dirt`);
      await rcon(`setblock ${F.x} ${F.y - 10} ${F.z} white_wool`);
      for (const [dx, dz] of [[3, 0], [0, 4], [-3, 2]]) await rcon(`summon item ${F.x + dx + 0.5} ${LY + 1} ${F.z + dz + 0.5} {Item:{id:"minecraft:stick",count:1}}`);
      await rcon(`tp ${NAME} ${F.x + 0.5} ${F.y + 1} ${F.z + 0.5}`);
      await sleep(1500);
      const line = await act('collect', { name: 'white_wool', index: 1 }, 120_000);
      const pos = await herPos();
      note(line.slice(0, 200));
      check(pos.length === 3 && pos[1] >= F.y, `第 ${i + 1} 遍：还在平台上（y=${pos[1]?.toFixed(1)}）`);
      check(!/做完了/.test(line) && !/breaking 1 white_wool/.test(line) && /never got within reach|no progress/.test(line), `第 ${i + 1} 遍：没说采到，说了够不着（${line.slice(0, 160)}）`);
      await rcon(`fill ${F.x - 1} ${F.y - 10} ${F.z - 1} ${F.x + 1} ${F.y} ${F.z + 1} air`);
    }
  }

  if (want('直播 5：采够数时说旁边还剩几块')) {
    begin('直播 5：一窝 4 块钻石矿只采 1 块，告诉她旁边还剩哪 3 块');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    await rcon(`fill ${LX + 3} ${LY + 1} ${LZ - 2} ${LX + 7} ${LY + 4} ${LZ + 2} stone`);
    const ores = [[LX + 3, LY + 1, LZ], [LX + 4, LY + 1, LZ], [LX + 4, LY + 2, LZ], [LX + 5, LY + 1, LZ + 1]];
    for (const [x, y, z] of ores) await rcon(`setblock ${x} ${y} ${z} diamond_ore`);
    await sleep(1000);
    const line = await act('collect', { name: 'diamond_ore', index: 1 }, 90_000);
    note(line.slice(0, 300));
    const left = [];
    for (const [x, y, z] of ores) if (/passed/i.test(await rcon(`execute if block ${x} ${y} ${z} diamond_ore`))) left.push(`${x} ${y} ${z}`);
    check(left.length === 3 && left.every((p) => line.includes(p)), `剩下的 3 块都列出来了（剩 ${left.join('；')}）`);
    await rcon(`fill ${LX + 3} ${LY + 1} ${LZ - 2} ${LX + 7} ${LY + 4} ${LZ + 2} air`);
  }

  if (want('服务器驳回挖掘')) {
    begin('服务器驳回挖掘（冒险模式不让挖）：不能说挖到了，以服务器为准');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    await rcon(`fill ${LX + 2} ${LY + 1} ${LZ - 1} ${LX + 2} ${LY + 2} ${LZ + 1} dirt`);
    await rcon(`gamemode adventure ${NAME}`);
    await sleep(1000);
    const line = await act('collect', { name: 'dirt', index: 1 }, 90_000);
    const dug = await act('dig', { text: `${LX + 2} ${LY + 1} ${LZ}` }, 60_000);
    await rcon(`gamemode survival ${NAME}`);
    note(line.slice(0, 220));
    note(dug.slice(0, 220));
    const still = /passed/i.test(await rcon(`execute if block ${LX + 2} ${LY + 1} ${LZ} dirt`));
    check(still, '服务器那边泥土还在');
    check(!/做完了/.test(line) && !/breaking [1-9]/.test(line), `collect 没说挖到（${line.slice(0, 140)}）`);
    check(!/做完了/.test(dug), `dig 没说挖掉了（${dug.slice(0, 140)}）`);
    await rcon(`fill ${LX + 2} ${LY + 1} ${LZ - 1} ${LX + 2} ${LY + 2} ${LZ + 1} air`);
  }

  if (want('倒水：站在熟胡萝卜里')) {
    begin('倒水：她站在长熟的胡萝卜那一格里（坑就在旁边），水要进坑');
    for (let i = 0; i < 4; i++) {
      await liveReset({ x: LX + 4, z: LZ + 3 });
      await rcon(`fill ${LX + 3} ${LY} ${LZ + 3} ${LX + 4} ${LY} ${LZ + 4} farmland[moisture=7]`);
      await rcon(`fill ${LX + 3} ${LY + 1} ${LZ + 3} ${LX + 4} ${LY + 1} ${LZ + 4} carrots[age=7]`);
      await rcon(`setblock ${LX + 5} ${LY} ${LZ + 3} air`);
      await rcon(`give ${NAME} water_bucket 1`);
      await rcon(`tp ${NAME} ${LX + 4.5} ${LY + 1} ${LZ + 3.5}`);
      await sleep(1200);
      const line = await act('bucket', { name: 'water_bucket', text: `${LX + 5} ${LY} ${LZ + 3}` }, 60_000);
      const source = /passed/i.test(await rcon(`execute if block ${LX + 5} ${LY} ${LZ + 3} water[level=0]`));
      let carrots = 0;
      for (const [x, z] of [[3, 3], [3, 4], [4, 3], [4, 4]]) if (/passed/i.test(await rcon(`execute if block ${LX + x} ${LY + 1} ${LZ + z} carrots`))) carrots++;
      check(source && carrots === 4, `第 ${i + 1} 遍：坑里是水源 ${source}，胡萝卜还剩 ${carrots}/4（${line.slice(0, 140)}）`);
      await rcon(`fill ${LX + 1} ${LY - 1} ${LZ + 1} ${LX + 9} ${LY - 1} ${LZ + 7} dirt`);
      await rcon(`fill ${LX + 1} ${LY} ${LZ + 1} ${LX + 9} ${LY} ${LZ + 7} grass_block`);
      await rcon(`fill ${LX + 1} ${LY + 1} ${LZ + 1} ${LX + 9} ${LY + 2} ${LZ + 7} air`);
    }
  }

  if (want('直播 4：看门狗（单测）')) {
    begin('直播 4：看门狗（单测）：不动就报、在挖或在走近不报');
    const { stallWatch } = await import('../src/games/minecraft/body/mineflayerAdapter.js');
    const { Vec3 } = await import('vec3');
    {
      const fake: any = { entity: { position: new Vec3(0, 0, 0) } };
      let cancelled = false;
      const w = stallWatch(fake, new Vec3(10, 0, 0), 2000, () => { cancelled = true; });
      const t0 = Date.now();
      const err = await w.stalled.catch((e: Error) => e);
      check(Date.now() - t0 >= 2000 && Date.now() - t0 < 3500 && cancelled, `不动：${Date.now() - t0} ms 报错并取消`);
      check(/no progress toward it for 2 s \(stuck at 0 0 0, still 11 blocks away\)/.test(String(err?.message)), `原因：${err?.message}`);
    }
    {
      const fake: any = { entity: { position: new Vec3(0, 0, 0) }, targetDigBlock: {} };
      let cancelled = false;
      const w = stallWatch(fake, new Vec3(3, 0, 0), 1500, () => { cancelled = true; });
      await sleep(3000);
      w.stop();
      check(!cancelled, '一直在挖：不报');
    }
    {
      const fake: any = { entity: { position: new Vec3(0, 0, 0) } };
      let cancelled = false;
      const w = stallWatch(fake, new Vec3(30, 0, 0), 1500, () => { cancelled = true; });
      for (let i = 0; i < 8; i++) { await sleep(400); fake.entity.position = new Vec3(i + 1, 0, 0); }
      w.stop();
      check(!cancelled, '一直在走近：不报');
    }
  }

  if (want('直播 4/10：走路来回晃、不靠近')) {
    begin('直播 4/10：走路来回晃、一直不靠近目标，要很快报出来');
    await liveReset();
    await sleep(500);
    // 每 0.5 秒在两个离目标一样远的点之间来回传：人一直在动，但离目标没近过
    let wobbling = true;
    const wobble = (async () => {
      let k = 0;
      while (wobbling) { await rcon(`tp ${NAME} ${LX + 0.5} ${LY + 1} ${LZ + (k++ % 2 ? 3.5 : 0.5)}`); await sleep(500); }
    })();
    const t0 = Date.now();
    const line = await act('go', { text: `${LX - 28} ${LY + 1} ${LZ + 2}` }, 400_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    wobbling = false;
    await wobble;
    note(line.slice(0, 260));
    check(secs <= 45, `45 秒内报出来（用了 ${secs} 秒）`);
    check(/没走到|Could not reach|closer/.test(line), `说了没走到、为什么（${line.slice(0, 160)}）`);
  }

  if (want('直播 4：走不动时采集要很快报出来')) {
    begin('直播 4：走不动时采集要很快报出来（一直被传回原地：寻路器一直试、人一步没挪）');
    await liveReset();
    await rcon(`give ${NAME} iron_pickaxe 1`);
    await rcon(`setblock ${LX + 10} ${LY + 1} ${LZ} diamond_ore`);
    await sleep(1000);
    // 每 0.5 秒把她传回原地：寻路器以为在走，人一直在原地
    let holding = true;
    const hold = (async () => { while (holding) { await rcon(`tp ${NAME} ${LX + 0.5} ${LY + 1} ${LZ + 0.5}`); await sleep(500); } })();
    const t0 = Date.now();
    const line = await act('collect', { name: 'diamond_ore', index: 1 }, 240_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    holding = false;
    await hold;
    note(line.slice(0, 300));
    check(secs <= 45, `45 秒内报出来（用了 ${secs} 秒）`);
    check(/5310 201 5000/.test(line) && /no progress|never got within reach|still there/.test(line), `说了卡在哪一块、为什么（${line.slice(0, 160)}）`);
    await rcon(`setblock ${LX + 10} ${LY + 1} ${LZ} air`);

    // 矿在 20 格外，每 0.2 秒传回原地：根本走不近，15 秒后看门狗放弃这一块
    await rcon(`setblock ${LX + 20} ${LY + 1} ${LZ} diamond_ore`);
    await sleep(800);
    holding = true;
    const hold2 = (async () => { while (holding) { await rcon(`tp ${NAME} ${LX + 0.5} ${LY + 1} ${LZ + 0.5}`); await sleep(200); } })();
    const t1 = Date.now();
    const line2 = await act('collect', { name: 'diamond_ore', index: 1 }, 240_000);
    const secs2 = Math.round((Date.now() - t1) / 1000);
    holding = false;
    await hold2;
    note(line2.slice(0, 300));
    check(secs2 <= 45 && /5320 201 5000/.test(line2) && /no progress|never got within reach/.test(line2), `走不近：${secs2} 秒报出来、说了没进展（${line2.slice(0, 160)}）`);
    await rcon(`setblock ${LX + 20} ${LY + 1} ${LZ} air`);
  }

  if (want('直播 7：苦力怕在旁边时逃跑（直播里每次 0 秒就失败：寻路目标被改了）')) {
    begin('直播 7：苦力怕在旁边时逃跑（直播里每次 0 秒就失败：寻路目标被改了）');
    for (let i = 0; i < 3; i++) {
      await liveReset();
      await rcon(`summon creeper ${LX + 3} ${LY + 1} ${LZ} {NoAI:1b}`);
      await sleep(1500);
      const start = await herPos();
      const line = await act('flee', {}, 60_000);
      const end = await herPos();
      const moved = start.length && end.length ? Math.hypot(end[0] - start[0], end[2] - start[2]) : 0;
      check(/：做完了/.test(line) && moved >= 5, `第 ${i + 1} 次：跑开了 ${moved.toFixed(1)} 格（${line.slice(0, 140)}）`);
    }
  }

}

/**
 * 跟拍用的常开 RCON 连接（RconLink）：同一个事件循环里连发的命令（换机位就是 kill + summon + spectate 连着发）每条都要执行。
 * 原版 RCON 一次读只处理一个包，几条被合进同一个 TCP 段就一条都不执行、还断开连接；本机上也复现得出来
 */
async function rconCases(): Promise<void> {
  const tag = 'dsh_linktest';
  const count = async () => Number((await rcon(`execute if entity @e[tag=${tag}]`)).match(/count: (\d+)/)?.[1] ?? 0);
  const summon = `summon item_display ${X} ${Y + 10} ${Z} {Tags:["${tag}"]}`;
  await rcon(`kill @e[tag=${tag}]`);
  const link = new RconLink(RCON);
  try {
    begin('RCON 常连接：还没连上时连发 3 条');
    for (let i = 0; i < 3; i++) link.send(summon);
    await sleep(1500);
    check((await count()) === 3, `3 条都执行了（${await count()}）`);

    begin('RCON 常连接：连上以后同一个循环里连发 3 条');
    for (let i = 0; i < 3; i++) link.send(summon);
    await sleep(1500);
    check((await count()) === 6, `一共 6 个（${await count()}）`);

    begin('RCON 常连接：每 0.1 秒一条 tp 连续 3 秒，再 kill');
    for (let i = 0; i < 30; i++) {
      link.send(`tp @e[tag=${tag}] ${X} ${Y + 10 + i * 0.1} ${Z}`);
      await sleep(100);
    }
    link.send(`kill @e[tag=${tag}]`);
    await sleep(1500);
    check((await count()) === 0, `连接没断，kill 也执行了（还剩 ${await count()}）`);
  } finally {
    link.close();
    await rcon(`kill @e[tag=${tag}]`);
  }
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
  await rcon(`fill ${X - 10} ${Y + 7} ${Z - 10} ${X + 10} ${Y + 7} ${Z + 10} air replace barrier`);
  for (const [a, b] of [[`${X - 10} ${Y + 1} ${Z - 10}`, `${X + 10} ${Y + 10} ${Z - 10}`], [`${X - 10} ${Y + 1} ${Z + 10}`, `${X + 10} ${Y + 10} ${Z + 10}`], [`${X - 10} ${Y + 1} ${Z - 10}`, `${X - 10} ${Y + 10} ${Z + 10}`], [`${X + 10} ${Y + 1} ${Z - 10}`, `${X + 10} ${Y + 10} ${Z + 10}`]]) {
    await rcon(`fill ${a} ${b} barrier`);
  }
  await rcon(`fill ${X - 10} ${Y + 11} ${Z - 10} ${X + 10} ${Y + 11} ${Z + 10} barrier`);
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

  // 站在耕地上（15/16 高）挖旁边一格：土落在坑底，寻路器按格子往下取整会以为够得着、一步不动（以前一半会捡不到）
  begin('耕地上挖坑：土掉在坑底也要捡回来（连做 3 遍）');
  for (let i = 0; i < 3; i++) {
    await rcon(`setblock ${X + 5} ${Y} ${Z + 4} dirt`);
    await rcon(`kill @e[type=item,x=${X + 5},y=${Y},z=${Z + 4},distance=..3]`);
    await rcon(`tp ${NAME} ${X + 4.5} ${Y + 1} ${Z + 3.5}`);
    await sleep(1000);
    const before = await serverCount('dirt');
    const line = await act('dig', { text: `${X + 5} ${Y} ${Z + 4}` }, 60_000);
    check((await serverCount('dirt')) === before + 1, `第 ${i + 1} 遍：土捡回来了（${line.slice(0, 80)}）`);
  }
  await rcon(`setblock ${X + 5} ${Y} ${Z + 4} dirt`);

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
  check(home.includes(`记下了：「家」在 (${X}, ${Y + 1}, ${Z})`), 'mark 不填坐标：记她站的地方');
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
  check(whole.includes(`家 (${X}, ${Y + 1}, ${Z})`) && whole.includes(`矿洞 (${X - 5}, ${Y - 3}, ${Z + 4})`) && !/临时/.test(whole), '地点：家、矿洞在，删掉的不在');
  check(whole.includes(`「小石台」在 (${X + 3}, ${Y + 1}, ${Z - 3})，盖完了`), '盖过的建筑：名字、坐标、盖完了');
  check(whole.includes(`wheat_seeds 2×2 在 (${X - 4}, ${Y}, ${Z - 4})`), '种过的地');
  check(/床（复活点）：/.test(whole), '床记下了');
  check(whole.includes(`死过 1 次，最近一次在 (${X + 2}, ${Y + 1}, ${Z + 2})`), '死在哪记下了');
  check(/存着的图纸：小石台/.test(whole), '图纸在日志里');

  begin('日志：下一局开局接上');
  await session.stop();
  session = newSession();
  const again = await session.start();
  note(again.replace(/\n/g, ' | ').slice(0, 700));
  check(/你在这里玩过 1 次，上次是/.test(again), '说了玩过几次、上次什么时候');
  check(/目标：在空岛上盖一个家/.test(again) && again.includes(`家 (${X}, ${Y + 1}, ${Z})`) && /「小石台」/.test(again), '目标、地点、建筑都在');
  check(/你的目标（上一局写的）：在空岛上盖一个家/.test((await session.wait(AbortSignal.timeout(3000), 2000)).notes.join(' ')), '目标接上了（每个时刻都提醒）');
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

  begin('形状：宽松的写法（cut 带了材料、materials 里定义空气）也读得懂');
  r = parseShapes('materials: S=stone air=air Z=air\nbox S from 0 0 0 to 4 3 4\ncut box air from 1 1 1 to 3 2 3\nbox Z from 0 3 0 to 0 3 0', none);
  const loose = r.blueprint ? cellsOf(r.blueprint) : new Set<string>();
  check(!!r.blueprint && !loose.has('2,1,2') && loose.has('0,0,0') && r.blueprint.layers[3][0][0] === '.', `读得懂（${r.errors.join('；') || '没报错'}）`);

  begin('形状：repeat、mirror、坡屋顶');
  const at = (bp: any) => new Map(placements(bp, { x: 0, y: 0, z: 0 }).map((p: any) => [`${p.x},${p.y},${p.z}`, `${p.name}${p.props.facing ? `:${p.props.facing}` : ''}${p.props.hinge ? `:${p.props.hinge}` : ''}`]));
  r = parseShapes('box glass from 0 0 0 to 0 1 0 repeat 4 step 3 0 0', none);
  const rep = at(r.blueprint!);
  check(rep.size === 8 && rep.has('9,1,0') && !rep.has('12,0,0'), `repeat：4 份，每份挪 3 格（${rep.size} 块）`);
  r = parseShapes('box stone from 2 0 0 to 4 0 0 mirror x\nbox oak_stairs[facing=east] from 5 0 0 to 5 0 0 mirror x\nbox oak_door[facing=south,hinge=left] from 2 1 3 to 2 1 3 mirror x', none);
  const mir = at(r.blueprint!);
  check(mir.get('-3,0,0') === 'stone' && mir.get('5,0,0') === 'oak_stairs:east' && mir.get('-5,0,0') === 'oak_stairs:west' && mir.get('-2,1,3') === 'oak_door:south:right',
    `mirror x：东西对称、楼梯朝向翻过来、门的合页左右对调（${mir.get('-5,0,0')}、${mir.get('-2,1,3')}）`);
  r = parseShapes('roof spruce_stairs from -3 0 -2 to 3 0 2 gable fill oak_planks', none);
  const gable = at(r.blueprint!);
  check(gable.get('0,0,-2') === 'spruce_stairs:south' && gable.get('0,0,2') === 'spruce_stairs:north' && gable.get('0,2,0') === 'spruce_planks' && gable.get('-3,1,0') === 'oak_planks' && r.blueprint!.height === 3,
    `人字顶：北坡朝南、南坡朝北、屋脊是木板、两头补了三角墙（屋脊 ${gable.get('0,2,0')}）`);
  r = parseShapes('roof stone_brick_stairs from -3 0 -3 to 3 0 3 hip overhang 1', none);
  const hip = at(r.blueprint!);
  check(hip.get('-4,0,0') === 'stone_brick_stairs:east' && hip.get('4,0,0') === 'stone_brick_stairs:west' && hip.get('0,4,0') === 'stone_bricks' && r.blueprint!.width === 9,
    `四坡顶（屋檐出 1 格）：西坡朝东、东坡朝西、尖顶是石砖（${hip.get('0,4,0')}）`);
  r = parseShapes('roof oak_planks from 0 0 0 to 4 0 4', none);
  check(!r.blueprint && /楼梯/.test(r.errors[0] ?? ''), `屋顶材料不是楼梯会说（${r.errors[0]}）`);

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
  const png = (session as any).takeImage();
  check(!!png && png.data[0] === 0x89 && png.data.length > 5000 && /附了一张渲染图/.test(designed), `design 附了渲染图（${png ? `${png.data.length} 字节` : '没有'}）`);
  if (png) fs.writeFileSync(path.join(ROOT, 'packages', 'dsh-game', 'test', '.out', 'preview-tower.png'), png.data);
  const slice = await session.act({ action: 'view', name: '穹顶塔', index: 3 });
  const cut = (session as any).takeImage();
  check(!!cut && /切开图/.test(slice), 'view 附了切开图');
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

  begin('创造模式：go 飞过去（从有顶的小屋里出发：先走出门再起飞；飞到天上，再飞回平台）');
  // 一块平台，上面一间有顶的玻璃小屋，南面开门
  const P = { x: C.x - 20, y: C.y, z: C.z };
  await rcon(`fill ${P.x - 4} ${P.y - 1} ${P.z - 4} ${P.x + 4} ${P.y - 1} ${P.z + 6} stone`);
  await rcon(`fill ${P.x - 2} ${P.y} ${P.z - 2} ${P.x + 2} ${P.y + 3} ${P.z + 2} glass hollow`);
  await rcon(`fill ${P.x} ${P.y} ${P.z + 2} ${P.x} ${P.y + 1} ${P.z + 2} air`);
  await rcon(`tp ${NAME} ${P.x + 0.5} ${P.y} ${P.z + 0.5}`);
  await sleep(2000);
  const sky = { x: P.x + 6, y: P.y + 25, z: P.z + 10 };
  const flew = await act('go', { text: `${sky.x} ${sky.y} ${sky.z}` }, 90_000);
  const pos = (await body().command<any>('snapshot', {}, 10_000))?.body?.position;
  note(`飞完在 ${pos ? `${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}` : '不知道'}`);
  check(/做完了/.test(flew) && !!pos && pos.y > P.y + 10, `从屋里出来飞上去了（${flew.slice(0, 100)}）`);
  const back = await act('go', { text: `${P.x} ${P.y} ${P.z + 5}` }, 90_000);
  check(/做完了/.test(back), `飞回平台了（${back.slice(0, 100)}）`);

  begin('创造模式：带人字顶的小屋（楼梯朝向在世界里也对）');
  const hut = 'materials: P=oak_planks T=spruce_stairs\nbox P from -3 0 -2 to 3 3 2 hollow 1 open top\nroof T from -3 4 -2 to 3 4 2 gable fill P overhang 1';
  check(/存好了/.test(await session.act({ action: 'design', name: '小屋', text: hut })), '小屋存好了');
  (session as any).takeImage();
  const H = { x: C.x + 12, y: C.y, z: C.z + 8 };
  const hutLine = await act('build', { name: '小屋', text: `${H.x} ${H.y} ${H.z}` }, 120_000);
  check(/：做完了/.test(hutLine), `盖完了（${hutLine.slice(0, 80)}）`);
  const isAt = async (dx: number, dy: number, dz: number, b: string) => /passed/i.test(await rcon(`execute if block ${H.x + dx} ${H.y + dy} ${H.z + dz} ${b}`));
  check(await isAt(0, 4, -3, 'spruce_stairs[facing=south]') && await isAt(0, 4, 3, 'spruce_stairs[facing=north]') && await isAt(0, 7, 0, 'spruce_planks'), '世界里：北坡楼梯朝南、南坡朝北、屋脊在顶上');

  begin('创造模式：要用的东西直接拿（种地不用先找锄头和种子；合成、采集不用做）');
  await rcon(`clear ${NAME}`);
  await rcon(`fill ${C.x + 20} ${C.y - 1} ${C.z - 2} ${C.x + 24} ${C.y - 1} ${C.z + 2} grass_block`);
  await sleep(1000);
  const farmed = await act('farm', { name: 'wheat_seeds', text: `${C.x + 21} ${C.y - 1} ${C.z - 1}`, index: 3 }, 120_000);
  check(/：做完了/.test(farmed), `背包空着也种上了（${farmed.slice(0, 120)}）`);
  const crafted = await session.act({ action: 'craft', name: 'wooden_hoe' });
  check(/创造模式不用合成/.test(crafted), `合成：说了不用（${crafted.slice(0, 60)}）`);

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

  begin('site：选好地方放出草稿虚影，改图纸虚影跟着变，build 不写坐标就盖在那里');
  const countGhosts = async () => Number((await rcon('execute if entity @e[type=block_display,tag=dsh_ghost]')).match(/count:\s*(\d+)/i)?.[1] ?? 0);
  await session.act({ action: 'design', name: '小亭子', text: 'materials: S=stone_bricks Q=quartz_block\nbox S from -2 0 -2 to 2 0 2\nbox Q from -2 1 -2 to -2 3 -2\nbox Q from 2 1 -2 to 2 3 -2\nbox Q from -2 1 2 to -2 3 2\nbox Q from 2 1 2 to 2 3 2\npyramid S center 0 4 0 radius 3 height 3' });
  const spot = { x: C.x - 10, y: C.y, z: C.z - 8 };
  const sited = await session.act({ action: 'site', name: '小亭子', text: `${spot.x} ${spot.y} ${spot.z}` });
  note(sited);
  const g1 = await countGhosts();
  check(/虚影/.test(sited) && g1 > 20, `放出了草稿虚影（${g1} 块）`);
  const redesigned = await session.act({ action: 'design', name: '小亭子', text: 'materials: S=stone_bricks Q=quartz_block\nbox S from -3 0 -3 to 3 0 3\nbox Q from -3 1 -3 to -3 4 -3\nbox Q from 3 1 -3 to 3 4 -3\nbox Q from -3 1 3 to -3 4 3\nbox Q from 3 1 3 to 3 4 3\npyramid S center 0 5 0 radius 4 height 4' });
  (session as any).takeImage();
  await sleep(1000);
  const g2 = await countGhosts();
  check(/虚影/.test(redesigned) && g2 > g1, `改大以后虚影跟着变了（${g1} → ${g2} 块）`);
  const builtAtSite = await act('build', { name: '小亭子' }, 120_000);
  check(/：做完了/.test(builtAtSite) && /passed/i.test(await rcon(`execute if block ${spot.x + 3} ${spot.y + 4} ${spot.z + 3} quartz_block`)), `不写坐标盖在了选好的地方（${builtAtSite.slice(0, 80)}）`);
  await sleep(1500);
  check((await countGhosts()) === 0, '盖完草稿虚影撤了');

  begin('look：周围地形的俯视图（场地旁边的真实地形）');
  // 场地旁边的自然地形（从高处落下去）
  await rcon(`tp ${NAME} ${X + 40} 140 ${Z + 40}`);
  await sleep(8000);
  const looked = await session.act({ action: 'look' });
  const map = (session as any).takeImage();
  note(looked.replace(/\n/g, ' | ').slice(0, 400));
  if (map) fs.writeFileSync(path.join(ROOT, 'packages', 'dsh-game', 'test', '.out', 'look.png'), map.data);
  check(!!map && map.data[0] === 0x89 && /水占 \d+%/.test(looked) && /俯视图/.test(looked), '给了俯视图和文字（水占多少、平地）');
  await rcon(`tp ${NAME} ${X} ${Y + 1} ${Z}`);
  await sleep(1500);

  begin('创造模式：日志记下了盖好的建筑');
  const book = await session.act({ action: 'journal' });
  check(book.includes(`「穹顶塔」在 (${C.x}, ${C.y}, ${C.z})，盖完了`), '穹顶塔记进了日志');

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

/** 装好游戏的 .minecraft（图纸渲染图要用游戏 jar）：开发时开局设置里填的那个 */
const CLIENT_DIR = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, '.dsh-home', 'dsh-game', 'minecraft-setup.json'), 'utf8')).clientDir ?? '');
  } catch {
    return '';
  }
})();

function newSession(creative = false): MinecraftSession {
  return new MinecraftSession({
    creative,
    clientDir: CLIENT_DIR,
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
    if (SUITE === 'breath') await breathCases();
    if (SUITE === 'all' || SUITE === 'rcon') await rconCases();
    if (SUITE === 'all' || SUITE === 'live') await liveCases();
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
