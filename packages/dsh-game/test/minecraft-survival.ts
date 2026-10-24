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
/** 跑哪些：basic（基本操作）、edge（名字、配方回环、掉落和数量）、build（盖房子）、farm（种地、养动物）、journal（世界日志）、不填 = 全部 */
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
  check((await countBlocks(field, 'wheat[age=0]')) === 16, `16 格都补种回去了（${await countBlocks(field, 'wheat[age=0]')} 格）`);

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

async function reset(): Promise<void> {
  await rcon(`clear ${NAME}`);
  await rcon(`effect clear ${NAME}`);
  await rcon(`effect give ${NAME} saturation 2 20`);
  await rcon(`kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`);
}

function newSession(): MinecraftSession {
  return new MinecraftSession({
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
