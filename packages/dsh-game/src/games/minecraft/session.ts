/**
 * Minecraft（Java 版）：大肥鱼以 DaFeiYu 的身份进一个服务器自己玩。
 *
 * 和别的游戏不一样：世界不会停下来等她。所以
 *   - 身体（子进程里的 mineflayer）一直在动：她下的长动作（采集、合成、走路、打怪……）在后台做，
 *     game_act 立刻返回；吃东西、还手、浮出水面这些反射也一直开着
 *   - 时刻由事件触发：动作做完 / 失败、挨打、天黑天亮、死了、饿了、游戏里有人说话、有人进出
 *   - 每个时刻都带她现在的状态（位置、昼夜、血量、饥饿、目标、正在做的事、背包、附近的怪）
 *   - 她用 goal 写下的长期目标存在这里，每个时刻都附上，换多少轮都不会忘
 */

import { randomUUID } from 'node:crypto';
import type { GameAction, GameActionSpec, GameSession, LiveSource, Moment, RunEvent } from '../types.js';
import type { MinecraftActionResult, MinecraftEnvironmentSnapshot, MinecraftHudState, MinecraftObservedEntity } from './body/contracts.js';
import type { MinecraftRuntimeEvent, MinecraftStatus } from './body/protocol.js';
import { MinecraftRuntimeManager } from './body/runtimeManager.js';
import { rcon, type RconTarget } from './rcon.js';
import { CameraClient, findJava, findMinecraftRoot } from './camera.js';

export interface MinecraftOptions {
  /** 打包好的身体子进程（lib/minecraft-worker.cjs） */
  workerPath: string;
  host: string;
  port: number;
  username: string;
  record: (event: RunEvent) => void;
  /** 她在游戏里做的事（给舞台终端显示） */
  onAction?: (text: string) => void;
  /** 摄像机客户端（真的 Minecraft 客户端，旁观模式挂在她身上）；null = 不开。要有 RCON 才能把它切成旁观 */
  camera?: { name: string; clientDir: string; java: string; gameDir: string; hudPort: number } | null;
  log?: (text: string) => void;
  /** 给主人看的状态变了（摄像机开没开起来）：推一次游戏状态 */
  onStateChange?: () => void;
  /** 自己服务器的 RCON：有的话，旁观的玩家会被自动挂到她身上（她复活、换维度、对方被甩开时重新挂） */
  rcon?: RconTarget | null;
}

/** 隔多久把旁观者重新挂一次（对方按了 Shift 被甩开时，最多这么久就挂回来） */
const RESPECTATE_MS = 30_000;

/** 身体在后台做的一件事 */
interface Running {
  id: string;
  /** 给她看的说法：「采集 oak_log ×8」 */
  label: string;
  startedAt: number;
  /** 开始时的背包（算进度用） */
  inventory: Record<string, number>;
}

const POLL_MS = 2000;
/** 摄像机窗口上的 HUD 多久刷新一次 */
const HUD_MS = 250;
/** 什么都没发生时，game_continue 最多等多久就回来给她看一眼现状 */
const IDLE_MAX_MS = 120_000;

const ACTIONS: GameActionSpec[] = [
  { action: 'goal', description: '写下 / 改掉你的长期目标（比如「打败末影龙」「盖一个小木屋」），之后每个时刻都会提醒你', params: { text: '目标' } },
  { action: 'collect', description: '采集一种东西：自己找、走过去、挖、捡起来，直到背包里多了这么多（后台做）。各种原木（oak_log、spruce_log……）算同一种，砍的是最近的树；木板、木棍、工作台用哪种木头都行', params:{ name: '物品的英文 id，比如 oak_log、cobblestone、iron_ore', index: '数量（默认 1）' } },
  { action: 'craft', description: '合成（需要工作台的会自己找或放一个；缺的中间材料会先合成）（后台做）', params: { name: '物品的英文 id，比如 crafting_table、wooden_pickaxe、torch', index: '数量（默认 1）' } },
  { action: 'smelt', description: '用熔炉烧东西（后台做）', params: { name: '要得到的东西的英文 id，比如 iron_ingot、cooked_beef', index: '数量（默认 1）' } },
  { action: 'go', description: '走到一个坐标（后台做）', params: { text: '坐标「x y z」' } },
  { action: 'go_to_player', description: '走到一个玩家身边（后台做）', params: { name: '玩家名' } },
  { action: 'follow', description: '一直跟着一个玩家走，直到你做别的事或 stop', params: { name: '玩家名' } },
  { action: 'attack', description: '去打附近的生物（后台做）', params: { name: '生物的英文 id，比如 zombie、cow', index: '打几只（默认 1）' } },
  { action: 'place', description: '在一个坐标放一个方块', params: { name: '方块的英文 id', text: '坐标「x y z」' } },
  { action: 'find', description: '找附近的某种方块或生物在哪（马上返回位置）', params: { name: '方块或生物的英文 id' } },
  { action: 'equip', description: '拿在手上，或者穿上盔甲', params: { name: '物品的英文 id' } },
  { action: 'drop', description: '把东西丢在地上（给别的玩家）', params: { name: '物品的英文 id', index: '数量（默认 1）' } },
  { action: 'pickup', description: '捡起附近地上的掉落物（后台做）' },
  { action: 'hide', description: '原地往下挖两格钻进去、用一块方块（泥土、圆石、木板……）封住头顶，躲怪过夜；出来时 go 回原来的坐标（后台做）' },
  { action: 'flee', description: '朝远离附近怪物的方向跑开十几格（后台做）' },
  { action: 'sleep', description: '睡觉跳过夜晚：附近有床就去睡，没有就放下背包里的床（只有晚上、附近没怪时能睡）（后台做）' },
  { action: 'chat', description: '在游戏的聊天栏里打字（游戏里的玩家才看得到；你回复里写的话是说出口的，不会进游戏聊天）', params: { text: '要发的话' } },
  { action: 'stop', description: '停下正在做的事' },
];

const LONG = new Set(['collect', 'craft', 'smelt', 'go', 'go_to_player', 'attack', 'pickup', 'hide', 'flee', 'sleep']);

const ERROR_TEXT: Record<string, string> = {
  not_connected: '还没进游戏',
  target_not_found: '附近没找到',
  path_unreachable: '走不过去（路被挡住或者太远）',
  blocked: '卡住了，走不动',
  missing_tool: '缺合适的工具',
  missing_item: '缺材料',
  inventory_full: '背包满了',
  unknown_item: '没有这个东西（英文 id 不对，或者它不是能这样得到的）',
  unsafe: '太危险，停下了',
  died: '死了，停下了',
  timeout: '太久没做完，停下了',
  cancelled: '停下了',
  recipe_unavailable: '合不出来（没有配方，或者缺工作台 / 材料）',
  inventory_desync: '背包对不上，停下了',
  craft_rejected: '合成被游戏拒绝了',
  adapter_error: '出错了',
};

export class MinecraftSession implements GameSession {
  readonly id = 'minecraft';
  readonly title = 'Minecraft';
  readonly realtime = true;
  readonly facts: string;

  private runtime: MinecraftRuntimeManager | null = null;
  private status: MinecraftStatus | null = null;
  private snapshot: MinecraftEnvironmentSnapshot | null = null;
  private seq = 0;
  private lines: string[] = [];
  private urgent = false;
  private wake: (() => void) | null = null;
  private running: Running | null = null;
  /** 排着队等身体做的长动作（她一次下了好几个，按顺序做） */
  private queue: { bodyAction: string; args: Record<string, unknown>; label: string }[] = [];
  private goal = '';
  private players = new Set<string>();
  private spectators = new Set<string>();
  private poller: NodeJS.Timeout | null = null;
  private lastHealth: number | null = null;
  private lastPhase: string | null = null;
  private seenHostiles = new Set<string>();
  private nudged = false;
  private firstMoment = true;
  private disconnected = false;
  private lastDimension: string | null = null;
  private lastRespectate = 0;
  private camera: CameraClient | null = null;
  private hudTimer: NodeJS.Timeout | null = null;
  private hudBusy = false;
  /** 摄像机的人称（F5 三档循环：她的视角 → 背后 → 正面）；新开的客户端是她的视角 */
  perspective: 'first' | 'back' | 'front' = 'first';
  private cameraSeen = false;
  private lastCameraCheck = 0;
  /** 给主人看的摄像机状态（「游戏」标签页显示） */
  private cameraNoteText = '';
  private set cameraNote(text: string) {
    this.cameraNoteText = text;
    this.options.onStateChange?.();
  }

  get screenNote(): string {
    return this.cameraNoteText;
  }
  private unsubscribe: (() => void) | null = null;
  finished = false;

  constructor(private readonly options: MinecraftOptions) {
    this.facts = [
      '【游戏】Minecraft（Java 版，生存模式）。你以玩家 DaFeiYu 的身份在一个服务器里，自己决定玩什么、怎么玩。',
      '【你的身体】你下的动作由身体去做：采集、合成、走路、打怪这些要花时间的事在后台做，game_act 会马上回来，做完或卡住了在下一个时刻告诉你，原因写在里面。'
        + '身体一次做一件事：身体在忙时再下的长动作会排队，按顺序做；想马上换成别的事，先 stop（停下正在做的，并清空排队）。饿了自己吃、被怪打会还手、掉进水里会往上游，这些不用你管。',
      '【世界不会等你】你说话、想事情的时候，游戏里的时间照样在走：天会黑，怪会刷出来。用 game_continue 看发生了什么，它在有事发生时（或者最多两分钟）回来。',
      '【名字】物品、方块、生物都用游戏里的英文 id：oak_log（橡木原木）、cobblestone（圆石）、crafting_table（工作台）、wooden_pickaxe（木镐）、iron_ingot（铁锭）、zombie（僵尸）……',
      '【目标】长期想做的事用 goal 写下来，每个时刻都会提醒你，换多少轮都不会忘。',
      '【说话】你回复里写的话是说出口的（主人和观众听得到）；游戏里的玩家要用 chat 才看得到。',
      formatActionList(),
    ].join('\n');
  }

  async start(): Promise<string> {
    if (this.runtime && this.status?.connected) return this.describeNow('还在游戏里');
    const runtime = this.runtime ?? new MinecraftRuntimeManager({ workerPath: this.options.workerPath });
    this.runtime = runtime;
    this.unsubscribe ??= runtime.onEvent((event) => this.onBodyEvent(event));
    try {
      this.status = await runtime.command<MinecraftStatus>('connect', {
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        companion: false,
      }, 60_000);
    } catch (err) {
      return `进不了服务器 ${this.options.host}:${this.options.port}：${(err as Error).message}。主人要先开好服务器（Java 版）。`;
    }
    this.disconnected = false;
    void this.startCamera();
    for (const p of this.status.players) if (p !== this.status.username && p !== this.cameraName) this.players.add(p);
    this.options.record({ type: 'start', game: 'minecraft' });
    await this.refresh();
    this.lastHealth = this.snapshot?.body?.health ?? null;
    this.lastPhase = phaseOf(this.snapshot?.world?.timeOfDay);
    this.poller = setInterval(() => void this.poll().catch(() => {}), POLL_MS);
    return this.describeNow(`进了服务器 ${this.options.host}:${this.options.port}`);
  }

  async wait(signal: AbortSignal, maxMs: number): Promise<Moment> {
    const limit = Math.min(maxMs, IDLE_MAX_MS);
    const deadline = Date.now() + limit;
    while (!this.urgent && !this.lines.length && !this.nudged && !this.disconnected && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); this.wake = null; resolve(); };
        this.wake = done;
        signal.addEventListener('abort', done, { once: true });
      });
    }
    const reason = this.disconnected ? 'disconnected' : this.nudged ? 'owner' : this.lines.length ? 'event' : 'timeout';
    this.nudged = false;
    this.urgent = false;
    await this.refresh().catch(() => {});
    return this.moment(reason);
  }

  refuse(action: GameAction): string | null {
    if (!ACTIONS.some((a) => a.action === action.action)) return `没有这个动作：${action.action}。\n${formatActionList()}`;
    if (!this.runtime || !this.status?.connected) return '还没进游戏（先 game_start）。';
    if (['collect', 'craft', 'smelt', 'go_to_player', 'follow', 'attack', 'find', 'equip', 'drop', 'place'].includes(action.action) && !action.name?.trim()) return `${action.action} 要填 name。`;
    if (['go', 'place'].includes(action.action) && !parseXyz(action.text)) return `${action.action} 要在 text 里填坐标「x y z」。`;
    if (['goal', 'chat'].includes(action.action) && !action.text?.trim()) return `${action.action} 要填 text。`;
    if (this.running && ['find', 'equip', 'drop', 'place'].includes(action.action)) {
      return `身体正在${this.running.label}，${action.action} 要等它做完，或者先 stop。`;
    }
    return null;
  }

  async act(action: GameAction): Promise<string> {
    const runtime = this.runtime;
    if (!runtime) return '还没进游戏。';
    const name = action.name?.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_') ?? '';
    const count = Math.max(1, Math.min(64, Math.round(action.index ?? 1)));
    const xyz = parseXyz(action.text);
    switch (action.action) {
      case 'goal':
        this.goal = action.text!.trim();
        this.note(`目标：${this.goal}`);
        return `记下了，目标：${this.goal}`;
      case 'chat':
        await runtime.command('say', { message: action.text!.trim() });
        this.note(`聊天栏：${action.text!.trim()}`);
        return '发到游戏聊天栏了。';
      case 'stop': {
        const was = this.running;
        const dropped = this.queue.length;
        this.queue = [];
        this.running = null;
        await runtime.command('stop', {});
        return was ? `停下了（原来在${was.label}${dropped ? `，排着的 ${dropped} 件也取消了` : ''}）。` : '本来就没在做什么。';
      }
      case 'find': {
        const block = await this.body('search_block', { block: name, radius: 64, count: 3 }, 30_000);
        if (block.outcome === 'succeeded') return `找到了：${block.summary}`;
        const entity = await this.body('search_entity', { entity: name, radius: 64 }, 30_000);
        if (entity.outcome === 'succeeded') return `找到了：${entity.summary}`;
        return `附近 64 格内没找到 ${name}。`;
      }
      case 'equip': {
        const r = await this.body('equip', { item: name }, 20_000);
        return describeResult(r, `拿上 ${name}`);
      }
      case 'drop': {
        const r = await this.body('drop_item', { item: name, count }, 20_000);
        return describeResult(r, `丢下 ${name} ×${count}`);
      }
      case 'place': {
        const r = await this.body('place_block', { block: name, position: xyz }, 60_000);
        return describeResult(r, `在 ${fmtXyz(xyz!)} 放 ${name}`);
      }
      case 'follow': {
        this.queue = [];
        await this.replaceRunning();
        const r = await this.body('follow_player', { player: action.name!.trim() }, 30_000);
        if (r.outcome === 'succeeded') this.running = { id: r.actionId, label: `跟着 ${action.name!.trim()} 走`, startedAt: Date.now(), inventory: {} };
        return describeResult(r, `跟着 ${action.name!.trim()}`);
      }
      default:
        break;
    }
    if (!LONG.has(action.action)) return `没有这个动作：${action.action}`;
    const [bodyAction, args, label] = ((): [string, Record<string, unknown>, string] => {
      switch (action.action) {
        case 'collect': return ['collect_item', { item: name, quantity: count, radius: 64 }, `采集 ${name} ×${count}`];
        case 'craft': return ['craft_item', { item: name, quantity: count }, `合成 ${name} ×${count}`];
        case 'smelt': return ['smelt_item', { item: name, quantity: count }, `烧 ${name} ×${count}`];
        case 'go': return ['go_to', { position: xyz, range: 1 }, `走到 ${fmtXyz(xyz!)}`];
        case 'go_to_player': return ['navigate_to_player', { player: action.name!.trim(), range: 2, timeoutMs: 120_000 }, `走到 ${action.name!.trim()} 身边`];
        case 'attack': return ['attack_entity', { entity: name, quantity: count, kill: true, radius: 32 }, `打 ${name} ×${count}`];
        case 'hide': return ['hide', {}, '躲到地下'];
        case 'flee': return ['flee', {}, '逃开怪物'];
        case 'sleep': return ['sleep', {}, '睡觉'];
        default: return ['pickup_drops', { radius: 12 }, '捡附近的掉落物'];
      }
    })();
    if (this.running) {
      this.queue.push({ bodyAction, args, label });
      return `身体正在${this.running.label}，「${label}」排上了（前面还有 ${this.queue.length} 件，包括正在做的）。`;
    }
    this.begin(bodyAction, args, label);
    return `开始${label}。做完或卡住了会在下一个时刻告诉你。`;
  }

  /** 身体开始做一件长动作（做完自动接着做排队的下一件） */
  private begin(bodyAction: string, args: Record<string, unknown>, label: string): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const id = randomUUID();
    const running: Running = { id, label, startedAt: Date.now(), inventory: { ...(this.snapshot?.body?.inventory ?? {}) } };
    this.running = running;
    this.options.onAction?.(label);
    this.options.record({ type: 'act', text: label });
    void runtime.command<MinecraftActionResult>('execute-action', { id, name: bodyAction, args }, 0)
      .then(async (r) => {
        // 矿石、石头这类：挖下来掉的是别的东西（iron_ore 掉 raw_iron），按「物品」找不到来源 → 按方块再来一次
        if (bodyAction === 'collect_item' && r.outcome === 'failed' && /cannot resolve source blocks/.test(String(r.error?.details?.message ?? r.summary)) && this.running === running) {
          const blockArgs = { block: args.item, quantity: args.quantity, maxCount: args.quantity, radius: args.radius };
          r = await runtime.command<MinecraftActionResult>('execute-action', { id, name: 'collect_item', args: blockArgs }, 0);
        }
        this.finishRunning(running, r);
      })
      .catch((err) => this.finishRunning(running, null, (err as Error).message));
  }

  nudge(): void {
    this.nudged = true;
    this.wake?.();
  }

  /** 她这一轮结束了：世界不会停，身体照样做手上的事、照样自保 */
  pause(): void {}

  async stop(): Promise<void> {
    this.finished = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.hudTimer) clearInterval(this.hudTimer);
    this.hudTimer = null;
    this.camera?.stop();
    this.camera = null;
    const runtime = this.runtime;
    this.runtime = null;
    if (!runtime) return;
    await runtime.command('disconnect', {}, 10_000).catch(() => {});
    await runtime.shutdown();
  }

  // ───────────────────────── 身体 ─────────────────────────

  /** 让身体马上做一件短的事，等结果（身体在做长动作时不插队，见 refuse） */
  private async body(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<MinecraftActionResult> {
    return this.runtime!.command<MinecraftActionResult>('execute-action', { id: randomUUID(), name, args }, timeoutMs);
  }

  /** 新的长动作要开始：停掉正在做的（返回原来在做什么） */
  private async replaceRunning(): Promise<string | null> {
    const was = this.running;
    if (!was) return null;
    this.running = null;
    await this.runtime?.command('cancel-action', { actionId: was.id }, 10_000).catch(() => {});
    await this.runtime?.command('stop', {}, 10_000).catch(() => {});
    return was.label;
  }

  private finishRunning(running: Running, result: MinecraftActionResult | null, error?: string): void {
    // 被新动作顶掉的：不用再报
    if (this.running !== running && result?.outcome === 'cancelled') return;
    if (this.running === running) this.running = null;
    const seconds = Math.round((Date.now() - running.startedAt) / 1000);
    const text = result ? describeResult(result, running.label) : `${running.label}：出错了（${error}）`;
    this.options.onAction?.(text);
    const next = !this.running && !this.disconnected ? this.queue.shift() : undefined;
    this.push(`${text}（用了 ${seconds} 秒）${next ? `；接着做排着的「${next.label}」` : ''}`, true);
    if (next) this.begin(next.bodyAction, next.args, next.label);
  }

  private onBodyEvent(event: MinecraftRuntimeEvent): void {
    switch (event.kind) {
      case 'chat':
        if (event.player !== this.options.username) this.push(`【游戏聊天】${event.player}：${event.message}`, true);
        break;
      case 'players': {
        if (this.cameraName && event.players.includes(this.cameraName) && !this.cameraSeen) void this.cameraJoined();
        this.cameraSeen = !!this.cameraName && event.players.includes(this.cameraName);
        const now = new Set(event.players.filter((p) => p !== this.options.username && p !== this.cameraName));
        for (const p of now) if (!this.players.has(p)) this.push(`${p} 进了游戏`, false);
        for (const p of this.players) if (!now.has(p)) this.push(`${p} 离开了游戏`, false);
        this.players = now;
        break;
      }
      case 'death':
        // 正在做的事由身体自己报（死的时候它会停掉并回报），这里不清，免得两边对不上
        this.queue = [];
        this.push(`你死了${event.position ? `（在 ${fmtXyz(event.position)}）` : ''}。会在出生点复活，身上的东西掉在死的地方，几分钟内回去还能捡。`, true);
        setTimeout(() => void this.attachSpectators(), 3000);
        break;
      case 'food-shortage':
        this.push(`饿了（饥饿值 ${event.food}/20），背包里没有能吃的。`, true);
        break;
      case 'food-recovered':
        this.push(`不饿了（饥饿值 ${event.food}/20）。`, false);
        break;
      case 'oxygen-danger':
        this.push(event.recovered ? '差点在水里憋死，身体游上来了。' : '在水里快憋死了，身体没能游上来！', true);
        break;
      case 'creeper-evaded':
        this.push(event.ok ? '苦力怕贴过来，身体先躲开了。' : '苦力怕贴过来，身体想躲开但没躲掉！', true);
        break;
      case 'movement-blocked':
        this.push(`跟着 ${event.player} 走的时候被挡住了，过不去（离他 ${Math.round(event.distance)} 格）。`, true);
        break;
      case 'disconnected':
        this.status = this.status ? { ...this.status, connected: false } : null;
        this.disconnected = true;
        this.running = null;
        this.queue = [];
        this.push(`和服务器断开了：${event.reason}`, true);
        break;
      default:
        break;
    }
  }

  /** 每 2 秒看一眼：挨打、昼夜变化、怪物靠近 */
  private async poll(): Promise<void> {
    if (!this.runtime || this.disconnected) return;
    await this.refresh();
    const s = this.snapshot;
    const health = s?.body?.health;
    if (typeof health === 'number' && this.lastHealth !== null && health < this.lastHealth - 0.5) {
      const near = hostiles(s).filter((e) => e.distance <= 8).map(fmtEntity);
      this.push(`挨打了：血量 ${fmt1(this.lastHealth)} → ${fmt1(health)}/20${near.length ? `，附近有 ${near.join('、')}` : ''}`, health <= 10);
    }
    if (typeof health === 'number') this.lastHealth = health;
    const phase = phaseOf(s?.world?.timeOfDay);
    if (phase && this.lastPhase && phase !== this.lastPhase) {
      if (phase === '夜晚') this.push('天黑了，外面会刷出怪物。', false);
      if (phase === '白天') this.push('天亮了。', false);
    }
    if (phase) this.lastPhase = phase;
    const dimension = String(s?.world?.dimension ?? '');
    const moved = this.lastDimension !== null && dimension !== this.lastDimension;
    this.lastDimension = dimension;
    if (moved || Date.now() - this.lastRespectate >= RESPECTATE_MS) void this.attachSpectators();
    void this.keepCameraAttached();
    // 新出现在 12 格内的敌对生物（同一只只报一次）
    for (const e of hostiles(s).filter((h) => h.distance <= 12)) {
      const key = `${e.name}@${Math.round(e.position.x / 4)},${Math.round(e.position.z / 4)}`;
      if (this.seenHostiles.has(key)) continue;
      this.seenHostiles.add(key);
      if (this.seenHostiles.size > 200) this.seenHostiles.clear();
      this.push(`${fmtEntity(e)} 靠过来了`, false);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.runtime || this.disconnected) return;
    this.snapshot = await this.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {}, 10_000);
    const status = await this.runtime.command<MinecraftStatus>('status', {}, 10_000).catch(() => null);
    if (status) {
      const before = this.spectators;
      this.spectators = new Set(status.spectators ?? []);
      if ([...this.spectators].some((p) => !before.has(p))) void this.attachSpectators();
    }
  }

  private get cameraName(): string {
    return this.options.camera?.name ?? '';
  }

  /** 开摄像机客户端（和服务器同一个游戏版本），它进服后切成旁观、挂到她身上 */
  private async startCamera(): Promise<void> {
    const cam = this.options.camera;
    if (!cam || this.camera) return;
    if (!this.options.rcon) {
      this.cameraNote = '没开摄像机客户端：要先在插件设置里填自己服务器的 RCON 密码（摄像机要切成旁观模式）。';
      return;
    }
    const version = this.status?.version ?? '';
    const root = findMinecraftRoot(cam.clientDir, version);
    if (!root) {
      this.cameraNote = `没开摄像机客户端：没找到装好的 Minecraft ${version}（在插件设置里填 .minecraft 目录，用 HMCL 或官方启动器装好这个版本）。`;
      return;
    }
    this.perspective = 'first';
    this.camera = new CameraClient({
      root, version, username: cam.name, host: this.options.host, port: this.options.port,
      gameDir: cam.gameDir, java: findJava(cam.java, root), hudPort: cam.hudPort, log: this.options.log,
    });
    this.cameraNote = `摄像机客户端（${cam.name}，Minecraft ${version}）正在打开，进服后会自动挂到她身上。`;
    try {
      await this.camera.start();
      this.hudTimer ??= setInterval(() => void this.pushHud(), HUD_MS);
      this.cameraNote = `她的画面在摄像机客户端窗口里（${cam.name}，跟着她的视角）。直播时 OBS 抓这个窗口${cam.hudPort ? `，血量、快捷栏这些用浏览器源 http://127.0.0.1:${cam.hudPort}/ 叠在上面（和窗口一样大）` : ''}。`;
    } catch (err) {
      this.camera = null;
      this.cameraNote = `摄像机客户端没开起来：${(err as Error).message}`;
    }
  }

  /** 直播时上舞台的画面：摄像机挂在她身上之后，OBS 抓摄像机窗口，HUD 网页叠在上面 */
  liveSource(): LiveSource | null {
    const window = this.camera?.running && this.cameraSeen ? this.camera.obsWindow : null;
    if (!window) return null;
    const overlay = this.camera!.hudUrl;
    return overlay ? { window, overlay } : { window };
  }

  /** 摄像机挂在她身上时，窗口上的 HUD 画她的血、饱食度、快捷栏 */
  private async pushHud(): Promise<void> {
    const camera = this.camera;
    if (!camera?.running || !this.cameraSeen || !this.runtime || this.disconnected || this.hudBusy) return;
    this.hudBusy = true;
    try {
      const state = await this.runtime.command<MinecraftHudState | null>('hud-state', {}, 2000).catch(() => null);
      if (state) camera.showHud(state);
    } finally {
      this.hudBusy = false;
    }
  }

  /** 切换摄像机的人称：按需要的次数发 F5 */
  async setClientView(mode: string): Promise<string> {
    const order = ['first', 'back', 'front'] as const;
    const want = order.indexOf(mode as (typeof order)[number]);
    if (want < 0) return `没有这个视角：${mode}`;
    if (!this.camera?.running) return '摄像机客户端没开。';
    const presses = (want - order.indexOf(this.perspective) + 3) % 3;
    if (presses && !(await this.camera.pressKey(0x74, 0x3f, presses))) return '没能给摄像机窗口发按键。';
    this.perspective = order[want];
    this.options.onStateChange?.();
    return 'ok';
  }

  /** 摄像机进服了：切成旁观；挂到她身上由 keepCameraAttached 负责（刚进服还在加载地形时挂不上） */
  private async cameraJoined(): Promise<void> {
    const target = this.options.rcon;
    if (!target) return;
    await rcon(target, `gamemode spectator ${this.cameraName}`).catch(() => {});
    this.lastCameraCheck = 0;
  }

  /** 摄像机没挂在她身上（坐标对不上）就挂上：刚进服、她复活、换维度、被甩开时都会这样；挂着的不动它，画面不闪 */
  private async keepCameraAttached(): Promise<void> {
    const target = this.options.rcon;
    const me = this.snapshot?.body?.position;
    if (!target || !this.cameraSeen || !me) return;
    if (Date.now() - this.lastCameraCheck < 10_000) return;
    this.lastCameraCheck = Date.now();
    const reply = await rcon(target, `data get entity ${this.cameraName} Pos`).catch(() => '');
    const nums = reply.match(/-?\d+(\.\d+)?(?=d)/g)?.map(Number);
    const attached = nums && nums.length >= 3 && Math.hypot(nums[0] - me.x, nums[1] - me.y, nums[2] - me.z) < 2;
    if (!attached) await rcon(target, `spectate ${this.options.username} ${this.cameraName}`).catch(() => {});
  }

  /** 把旁观模式的玩家挂到她身上（第一人称跟着她；F5 换第三人称）。没配 RCON 就什么都不做 */
  private async attachSpectators(): Promise<void> {
    const target = this.options.rcon;
    this.lastRespectate = Date.now();
    if (!target || !this.spectators.size || this.disconnected) return;
    for (const name of this.spectators) {
      if (name === this.cameraName) continue;
      await rcon(target, `spectate ${this.options.username} ${name}`).catch(() => {});
    }
  }

  /** 在线的其他玩家（旁观模式的标出来：隐身、碰不到，也走不到他身边） */
  private others(): string[] {
    return [...this.players].filter((p) => p !== this.cameraName).map((p) => (this.spectators.has(p) ? `${p}（旁观模式：隐身，碰不到，也走不到他身边）` : p));
  }

  // ───────────────────────── 时刻 ─────────────────────────

  private push(line: string, urgent: boolean): void {
    this.lines.push(line);
    if (this.lines.length > 40) this.lines.splice(0, this.lines.length - 40);
    if (urgent) this.urgent = true;
    this.options.record({ type: 'line', who: '', text: line, label: null, mode: 'play' });
    // 不急的事攒一攒（2 秒内的一起交），急的马上交
    if (urgent) this.wake?.();
    else setTimeout(() => this.wake?.(), POLL_MS);
  }

  /** 她自己做的事（写目标、发聊天）：记一笔，但不算新时刻 */
  private note(text: string): void {
    this.options.record({ type: 'act', text });
    this.options.onAction?.(text);
  }

  private moment(reason: string): Moment {
    const s = this.snapshot;
    const lines = this.lines;
    this.lines = [];
    const notes: string[] = [];
    notes.push(this.goal ? `你的目标：${this.goal}` : '你还没写下目标（想做什么可以用 goal 写下来）。');
    if (this.running) {
      const progress = inventoryChange(this.running.inventory, s?.body?.inventory);
      notes.push(`身体正在：${this.running.label}（${Math.round((Date.now() - this.running.startedAt) / 1000)} 秒了${progress ? `，到现在背包 ${progress}` : ''}）`);
    } else {
      notes.push('身体现在空着。');
    }
    if (this.queue.length) notes.push(`排着队：${this.queue.map((q) => q.label).join(' → ')}`);
    if (s?.body) notes.push(`背包：${formatInventory(s.body.inventory)}`);
    const near = (s?.nearby.entities ?? []).filter((e) => e.distance <= 24).slice(0, 8).map(fmtEntity);
    if (near.length) notes.push(`附近 24 格内：${near.join('、')}`);
    const moment: Moment = {
      seq: ++this.seq,
      reason,
      where: this.whereText(),
      lines,
      onStage: this.others(),
      notes,
      ...(this.firstMoment ? { actions: ACTIONS } : {}),
    };
    this.firstMoment = false;
    this.options.record({ type: 'moment', seq: moment.seq, reason, where: moment.where, lines: lines.length });
    return moment;
  }

  private whereText(): string {
    const s = this.snapshot;
    if (!s?.body) return this.status?.connected ? '在游戏里' : '没在游戏里';
    const dim = { overworld: '主世界', the_nether: '下界', the_end: '末地' }[String(s.world?.dimension ?? '').replace('minecraft:', '')] ?? String(s.world?.dimension ?? '');
    const phase = phaseOf(s.world?.timeOfDay) ?? '';
    const weather = s.world?.weather && s.world.weather !== 'clear' ? `·${s.world.weather === 'rain' ? '下雨' : s.world.weather === 'thunder' ? '打雷' : s.world.weather}` : '';
    return `${dim} ${fmtXyz(s.body.position)} · ${phase}${weather} · 血量 ${fmt1(s.body.health)}/20 · 饥饿 ${Math.round(s.body.food)}/20`;
  }

  private describeNow(head: string): string {
    const s = this.snapshot;
    const parts = [`${head}。现在：${this.whereText()}。`];
    if (s?.body) parts.push(`背包：${formatInventory(s.body.inventory)}。`);
    const others = this.others();
    parts.push(others.length ? `在线的其他玩家：${others.join('、')}。` : '服务器里现在只有你。');
    return parts.join('\n');
  }
}

// ───────────────────────── 小工具 ─────────────────────────

function formatActionList(): string {
  return [
    '【你能做的事】（用 game_act）',
    ...ACTIONS.map((a) => {
      const params = Object.entries(a.params ?? {}).map(([k, how]) => `${k}=${how}`);
      return `- action=${a.action}${params.length ? `，${params.join('，')}` : ''}：${a.description}`;
    }),
  ].join('\n');
}

function describeResult(r: MinecraftActionResult, label: string): string {
  if (r.outcome === 'succeeded') return `${label}：做完了（${r.summary}）${formatDelta(r.inventoryDelta)}`;
  if (r.outcome === 'partial') return `${label}：只做了一部分（${r.summary}）${formatDelta(r.inventoryDelta)}`;
  if (r.outcome === 'cancelled') return `${label}：停下了`;
  const code = r.error?.code ?? 'adapter_error';
  const detail = typeof r.error?.details?.message === 'string' ? r.error.details.message : r.summary;
  return `${label}：没成，${ERROR_TEXT[code] ?? code}（${detail}）${formatDelta(r.inventoryDelta)}`;
}

function formatDelta(delta: Record<string, number> | undefined): string {
  const parts = Object.entries(delta ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n > 0 ? '+' : ''}${n}`);
  return parts.length ? `；背包变化：${parts.join('，')}` : '';
}

/** 背包从 before 到 after 的变化：「+7 spruce_log，-1 stick」（没变是空字符串） */
function inventoryChange(before: Record<string, number>, after: Record<string, number> | undefined): string {
  if (!after) return '';
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const parts: string[] = [];
  for (const k of keys) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d) parts.push(`${d > 0 ? '+' : ''}${d} ${k}`);
  }
  return parts.join('，');
}

function formatInventory(inv: Record<string, number> | undefined): string {
  const entries = Object.entries(inv ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '空的';
  return entries.slice(0, 24).map(([k, n]) => `${k}×${n}`).join('、') + (entries.length > 24 ? ` 等 ${entries.length} 种` : '');
}

function hostiles(s: MinecraftEnvironmentSnapshot | null): MinecraftObservedEntity[] {
  return (s?.nearby.entities ?? []).filter((e) => e.hostile);
}

function fmtEntity(e: MinecraftObservedEntity): string {
  return `${e.name}（${Math.round(e.distance)} 格）`;
}

function phaseOf(timeOfDay: number | undefined): string | null {
  if (typeof timeOfDay !== 'number') return null;
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  if (t < 12000) return '白天';
  if (t < 13800) return '黄昏';
  if (t < 22200) return '夜晚';
  return '清晨';
}

function parseXyz(text: string | undefined): { x: number; y: number; z: number } | null {
  const nums = (text ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number);
  if (!nums || nums.length < 3) return null;
  return { x: nums[0], y: nums[1], z: nums[2] };
}

function fmtXyz(p: { x: number; y: number; z: number }): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
}

function fmt1(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
