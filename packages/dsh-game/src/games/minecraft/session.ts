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
import path from 'node:path';
import type { GameAction, GameActionSpec, GameSession, LiveSource, Moment, RunEvent } from '../types.js';
import type { MinecraftActionResult, MinecraftEnvironmentSnapshot, MinecraftHudState, MinecraftObservedEntity } from './body/contracts.js';
import type { MinecraftRuntimeEvent, MinecraftStatus } from './body/protocol.js';
import { MinecraftRuntimeManager } from './body/runtimeManager.js';
import { QUICK_ACTIONS } from './body/protocol.js';
import { RconLink, rcon, rconBatch, type RconTarget } from './rcon.js';
import type { FollowPose } from './body/followCam.js';
import { CameraClient, findJava, findMinecraftRoot } from './camera.js';
import { TEMPLATES, clearCells, describeBlueprint, ghostCells, layerSlice, materials, outlineCells, parseBlueprint, placements, type Blueprint, type ParseResult } from './blueprint.js';
import { GhostBuild } from './ghost.js';
import { isShapeText, parseShapes } from './shapes.js';
import { placeLayers, worldBase } from './creative.js';
import { BlockColors, VIEW_LABELS, renderBlueprint } from './preview.js';
import { describeTerrain, findFlatSpots, renderTerrain } from './terrainMap.js';
import type { TerrainScan } from './body/terrain.js';
import { GameJar } from './gameJar.js';
import { WorldJournal, dimensionName } from './journal.js';

export interface MinecraftOptions {
  /** 打包好的身体子进程（lib/minecraft-worker.cjs） */
  workerPath: string;
  host: string;
  port: number;
  username: string;
  record: (event: RunEvent) => void;
  /** 她在游戏里做的事（给舞台终端显示） */
  onAction?: (text: string) => void;
  /** 开局前的检查：有问题返回原因（开局设置不对时不开局） */
  preflight?: () => Promise<string | null>;
  /** 摄像机客户端（真的 Minecraft 客户端，旁观模式挂在她身上）；null = 不开。要有 RCON 才能把它切成旁观 */
  camera?: { name: string; clientDir: string; java: string; gameDir: string; hudPort: number } | null;
  log?: (text: string) => void;
  /** 给主人看的状态变了（摄像机开没开起来）：推一次游戏状态 */
  onStateChange?: () => void;
  /** 自己服务器的 RCON：有的话，旁观的玩家会被自动挂到她身上（她复活、换维度、对方被甩开时重新挂） */
  rcon?: RconTarget | null;
  /** 世界日志放在哪（一个服务器上的一个她一本，见 journal.ts）；不给就不记 */
  journalDir?: string | null;
  /** 创造模式（开局用 RCON 切过去；盖房子用 RCON 一层层放，见 creative.ts）。要有 rcon */
  creative?: boolean;
  /** 装好游戏的 .minecraft（图纸渲染图从这个版本的 jar 里拿方块颜色）；空 = 官方启动器的默认位置 */
  clientDir?: string;
}

/** 隔多久把旁观者重新挂一次（对方按了 Shift 被甩开时，最多这么久就挂回来） */
const RESPECTATE_MS = 30_000;
/** 跟拍镜头多久挪一次（镜头实体的 teleport_duration 是 3 刻 = 0.15 秒：总在往最新的位置滑，不会停一下再走） */
const FOLLOW_MS = 100;

type JournalMeta =
  | { kind: 'build'; name: string; origin: { x: number; y: number; z: number } }
  | { kind: 'farm'; crop: string; corner: { x: number; y: number; z: number }; size: number }
  | { kind: 'sleep' };

/** 身体在后台做的一件事 */
interface Running {
  id: string;
  /** 给她看的说法：「采集 oak_log ×8」 */
  label: string;
  startedAt: number;
  /** 开始时的背包（算进度用） */
  inventory: Record<string, number>;
  /** 做完要记进世界日志的（盖房子、种地、睡觉） */
  meta?: JournalMeta;
  /** 不是身体做、是这里自己做的（创造模式一层层放）：停下用它 */
  abort?: AbortController;
  /** 交给身体的动作和参数（被自保的事打断以后接着做用） */
  bodyAction?: string;
  args?: Record<string, unknown>;
}

/** 自保的事：不排队，先停下手上的 */
const URGENT = new Set(['attack', 'flee', 'hide']);
/** 被打断以后可以原样再做一遍的（再做一遍不会多做一份）；采集只补剩下的数量 */
const RESUMABLE = new Set(['collect_item', 'go_to', 'navigate_to_player', 'dig_at', 'build_structure', 'pickup_drops', 'harvest_crops', 'farm_plot']);

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
  { action: 'go', description: '走到一个坐标（后台做）：路上挡着的方块会挖开，所以在地下也能直接 go 到几十格外的坐标，身体一路挖过去（40 格石头约 15 秒）；走不到会说停在哪、还差几格、为什么', params: { text: '坐标「x y z」' } },
  { action: 'go_to_player', description: '走到一个玩家身边（后台做）', params: { name: '玩家名' } },
  { action: 'follow', description: '一直跟着一个玩家走，直到你做别的事或 stop', params: { name: '玩家名' } },
  { action: 'attack', description: '去打附近的生物（后台做）：先拿上背包里最好的武器，打完换回原来手里的。打怪、逃跑、躲起来不排队：身体手上的事先停下，做完再接着做（采集、走路、挖、盖房子这类接着做；合成、烧东西不接着做，免得多做一份）', params: { name: '生物的英文 id，比如 zombie、cow', index: '打几只（默认 1）' } },
  { action: 'place', description: '在一个坐标放一个方块', params: { name: '方块的英文 id', text: '坐标「x y z」' } },
  { action: 'look', description: '看看周围的地形：一张以你为中心 65×65 格的俯视图（地面方块的颜色，水是蓝的，越亮越高），加上水占多少、地面多高、附近哪里有平地（中心坐标、大小）。找地方盖房子、找路之前先看一眼' },
  { action: 'find', description: '找附近的某种方块或生物在哪：马上返回每一处的坐标和离你多远（身体在做别的事时也能找）', params: { name: '方块或生物的英文 id' } },
  { action: 'equip', description: '拿在手上，或者穿上盔甲（身体在做别的事时也能马上换）', params: { name: '物品的英文 id' } },
  { action: 'drop', description: '把东西丢在脚边的地上（背包满了丢杂物，或者给旁边的玩家）', params: { name: '物品的英文 id', index: '数量（默认 1；可以超过一组，比如 448）' } },
  { action: 'pickup', description: '捡起附近地上的掉落物（后台做）' },
  { action: 'hide', description: '原地往下挖三格钻进去、用一块方块（泥土、圆石、木板……）封住头顶，躲怪过夜；出来时 go 回原来的坐标（后台做）' },
  { action: 'flee', description: '朝远离附近怪物的方向跑开十几格（后台做）' },
  { action: 'sleep', description: '睡觉跳过夜晚：附近有床就去睡，没有就放下背包里的床（只有晚上、附近没怪时能睡）（后台做）' },
  { action: 'template', description: `看一张常见建筑的参考图纸（存成同名图纸：可以直接 build，也可以照着改了再 design）：${Object.entries(TEMPLATES).map(([id, t]) => `${id}（${t.title}）`).join('、')}`, params: { name: '参考图纸的名字' } },
  { action: 'design', description: '交一张自己画的图纸，看它的正面、侧面、俯视三张投影、材料清单和问题（不会动手盖）。格式：先写「图例：」，每行「字符 方块的英文 id」，楼梯、门这类可以跟 facing=north/south/east/west（放的时候人朝哪边）、half=top/bottom；再写「第1层：」「第2层：」……从下往上一层层画。每层第一行在最北边，往下一行往南一格；每行从左往右是从西往东。「.」是空气（那里原来有东西会挖掉），空格是不管（原来是什么留着什么）。门在上下两层画同一个字符。最大宽 16、深 16、高 12。', params: { name: '给图纸起个名字', text: '图纸' } },
  { action: 'view', description: '看一张图纸某一层的切片（从上往下看这一层，上面是北）：圆顶、塔里面是不是空的、门洞开在哪，投影看不出来时用', params: { name: '图纸的名字', index: '第几层（从下往上数，从 1 开始）' } },
  { action: 'site', description: '给一张图纸选好地方：那里会出现它的虚影（看的人能看到你的设计，摄像机会去看它），之后用 design 改同名图纸，虚影跟着变；build 不写坐标就盖在这里', params: { name: '图纸的名字', text: '坐标「x y z」：图纸放在哪（和 build 的坐标一样）' } },
  { action: 'show', description: '带看的人看一座盖好的建筑：你飞到它东南边斜上方能看全它的地方、面朝它，摄像机绕着它转一圈（一分钟）再回到你身后', params: { name: '建筑的名字（盖过的图纸名）' } },
  { action: 'build', description: '照一张图纸盖起来（后台做；用 site 选过地方的可以不写坐标）：材料不够会告诉你缺多少；够不着的地方身体会垫方块爬上去，盖完拆掉；每盖完一层告诉你一声', params: { name: '图纸的名字（先 design 或 template 过）', text: '坐标「x y z」：图纸第 1 层第一行第一格（西北角、最下面那格）放在哪' } },
  { action: 'farm', description: '开一块地种上（后台做）：清掉地上的草、用锄头锄成耕地、播种。要有锄头（任何材质）和种子；耕地 4 格内有水才长得快（没有水会告诉你）', params: { name: '种子：wheat_seeds（小麦）、carrot、potato、beetroot_seeds（甜菜）', text: '坐标「x y z」：地的西北角（地面那格）', index: '边长（默认 3，最大 9）' } },
  { action: 'harvest', description: '收附近 16 格内熟了的庄稼，捡起来，再补种回去（后台做）；没熟的会告诉你长到第几阶段了', params: { name: '只收哪种：wheat、carrots、potatoes、beetroots（不填就都收）' } },
  { action: 'breed', description: '拿饲料喂附近的动物让它们生小的（后台做）：牛、羊吃 wheat，猪吃 carrot / potato / beetroot，鸡吃种子；喂过的动物 5 分钟后才能再生', params: { name: '动物的英文 id，比如 cow、sheep、pig、chicken', index: '喂几对（默认 1）' } },
  { action: 'shear', description: '用剪刀剪附近羊的羊毛（后台做）；剪过的羊吃了草才会长回来', params: { index: '剪几只（默认 3）' } },
  { action: 'dig', description: '挖掉指定的那一格（后台做）：挖坑、挖水渠、拆东西，掉的东西会捡起来；挖开会让岩浆流进来的不挖', params: { text: '坐标「x y z」' } },
  { action: 'bucket', description: '用桶（后台做）：空桶（bucket）装起那一格的水或岩浆（要是源头，流动的装不起来）；水桶、岩浆桶倒在那一格（那一格要空着）。会告诉你倒完以后那里和旁边变成了什么', params: { name: 'bucket、water_bucket 或 lava_bucket', text: '坐标「x y z」' } },
  { action: 'use', description: '拿着一样东西对一格方块用一下（后台做），比如打火石点火、骨粉催熟', params: { name: '手里拿的东西的英文 id，比如 flint_and_steel', text: '坐标「x y z」：对着这一格方块的上面用' } },
  { action: 'mark', description: '在这个世界的日志里记一个地点（家、矿洞、村庄……），下次来还能找到；同名的会换成新位置', params: { name: '地点的名字', text: '坐标「x y z」（不填就是你现在站的地方）；填「删掉」就把这个地点从日志里删了' } },
  { action: 'journal', description: '看这个世界的整本日志（目标、地点、盖过的房子、种过的地、床、死过的地方、图纸）' },
  { action: 'chat', description: '在游戏的聊天栏里打字（游戏里的玩家才看得到；你回复里写的话是说出口的，不会进游戏聊天）', params: { text: '要发的话' } },
  { action: 'stop', description: '停下正在做的事' },
];

/** 虚影最多放这么多块（每块是一个实体，太多了服务器和看的人都卡） */
const GHOST_MAX = 4000;

const LONG = new Set(['collect', 'craft', 'smelt', 'go', 'go_to_player', 'attack', 'pickup', 'hide', 'flee', 'sleep', 'build', 'farm', 'harvest', 'breed', 'shear', 'bucket', 'use', 'dig']);

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
  dig_rejected: '游戏没让挖（服务器没认这次挖掘，方块还在）',
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
  private queue: { bodyAction: string; args: Record<string, unknown>; label: string; meta?: JournalMeta }[] = [];
  private goal = '';
  /** 她什么时候写下的目标（上一局留下的是 null）：目标是她的原话，里面写的进度会过时，标上时间 */
  private goalAt: number | null = null;
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
  /** 她画好的图纸：名字 → 图纸（这局里一直在） */
  private designs = new Map<string, Blueprint>();
  /** 选好的地方：图纸名 → 坐标和那里的虚影（草稿）。改同名图纸虚影跟着变；build 不写坐标就盖在这里 */
  private sites = new Map<string, { origin: { x: number; y: number; z: number }; ghost: GhostBuild | null }>();
  /** 导播：摄像机离开她，绕着草稿 / 正在盖的建筑慢慢转（她去做别的事、盖完一会儿、太久没动静就回到她身上） */
  private director: { timer: NodeJS.Timeout; until: number; center: { x: number; y: number; z: number } } | null = null;
  /** 图纸渲染图用的方块颜色（没装客户端就是 null） */
  private colors: BlockColors | null | undefined;
  /** 刚做完的那件事附带的图（game_act 取走） */
  private image: { data: Uint8Array; mediaType: 'image/png' } | null = null;
  /** 她这局看过的图（主人在游戏页上翻看），最多留 30 张 */
  private pictures: { id: number; label: string; at: number; data: Uint8Array }[] = [];
  private pictureSeq = 0;
  private journal: WorldJournal | null = null;
  private lastJournalSave = 0;
  private lastDeathAt = 0;
  /** 盖房子的虚影：动作的说法（「盖「小木屋」」）→ 虚影 */
  private ghosts = new Map<string, GhostBuild>();
  private ghostSeq = 0;
  private preflightFailed = false;
  /** 开局前检查没过：这局其实没开 */
  get started(): boolean {
    return !this.preflightFailed;
  }
  private hudTimer: NodeJS.Timeout | null = null;
  private hudBusy = false;
  /** 新开的摄像机挂稳以后切到主人选的视角（只切这一次） */
  private defaultViewSet = false;
  /**
   * 主人选的视角：跟拍（默认：摄像机挂在一个跟着她走的展示实体上，机位见 body/followCam.ts），
   * 或者原版的三档（她的视角、背后、正面：往摄像机窗口按 F5）
   */
  private view: 'follow' | 'first' | 'back' | 'front' = 'follow';
  get perspective(): string {
    return this.view;
  }
  /** 摄像机客户端现在的人称（F5 三档循环：她的视角 → 背后 → 正面）；新开的客户端是她的视角。跟拍时是她的视角（看的是镜头实体的眼睛） */
  private f5: 'first' | 'back' | 'front' = 'first';
  /** 跟拍的镜头实体在哪（null = 摄像机直接挂在她身上：刚开、她钻进了太窄的地方、刚被传送） */
  private followRig: { x: number; y: number; z: number } | null = null;
  private followTimer: NodeJS.Timeout | null = null;
  private followBusy = false;
  private followReset = false;
  /** 摄像机刚进服、刚重新挂到她身上：等客户端加载好周围再放镜头实体 */
  private followPausedUntil = 0;
  private followLink: RconLink | null = null;
  private cameraSeen = false;
  private lastCameraCheck = 0;
  /** 上一次看到她的位置（看她有没有一下子跑远） */
  private lastBodyPos: { x: number; y: number; z: number } | null = null;
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
      ...(options.creative ? ['【创造模式】这局是创造模式：方块随便用、不会少，不会饿、不会受伤，能飞：go 去远一点的地方身体会飞过去（海上、天上都行）。build 不用材料，整座建筑从下往上一层层长出来（几秒到一分钟）；要用的东西（锄头、种子、桶、方块……）身体从创造物品栏直接拿，不用采集、合成。'] : []),
      `【游戏】Minecraft（Java 版，${options.creative ? '创造' : '生存'}模式）。你以玩家 ${options.username} 的身份在一个服务器里，自己决定玩什么、怎么玩。`,
      '【你的身体】你下的动作由身体去做：采集、合成、走路、打怪这些要花时间的事在后台做，game_act 会马上回来，做完或卡住了在下一个时刻告诉你，原因写在里面。'
        + '身体一次做一件事：身体在忙时再下的长动作会排队，按顺序做；想马上换成别的事，先 stop（停下正在做的，并清空排队）。饿了自己吃、被怪打会还手、掉进水里会往上游，这些不用你管。',
      '【世界不会等你】你说话、想事情的时候，游戏里的时间照样在走：天会黑，怪会刷出来。用 game_continue 看发生了什么，它在有事发生时（或者最多两分钟）回来。',
      '【名字】物品、方块、生物都用游戏里的英文 id：oak_log（橡木原木）、cobblestone（圆石）、crafting_table（工作台）、wooden_pickaxe（木镐）、iron_ingot（铁锭）、zombie（僵尸）……',
      '【目标】长期想做的事用 goal 写下来，每个时刻都会提醒你，换多少轮都不会忘。',
      '【盖房子】房子是你自己设计的：用 design 交一张图纸（图例 + 从下往上一层层的字符图），会给你看正面、侧面、俯视三张投影、一张渲染图（用游戏里方块的颜色画的立体图，四个角各看一眼）、材料清单和图上的问题，你看着改；满意了用 build 在一个坐标盖起来，身体照图纸一块块放。template 有几张常见建筑的参考图纸，可以照着改。',
      '【种地】锄头锄过的泥土是耕地，种子种上去过几分钟（游戏时间）一阶一阶长大；耕地离水 4 格以内长得快。熟了用 harvest 收，种子会补种回去。动物用对的饲料喂一对就会生一只小的；栅栏、羊圈可以用 design 画了 build。',
      '【形状图纸】design 除了字符图，也能用形状写（大的、圆的、斜的用这个）。先写一行 materials: Q=quartz_block S=stone_bricks（字母=方块，方块可以带 [facing=north] 这样的状态），再一行一个形状：'
        + 'box M from x y z to x y z；sphere M center x y z radius r（写三个数 rx ry rz 是椭球；加 top / bottom 只要上半 / 下半）；cylinder M center x y z radius r height h（底面中心，默认竖着往上；axis x / z 横着放，沿 +x / +z 方向伸长）；'
        + 'cone M 或 pyramid M center x y z radius r height h（底面中心往上收成尖，加 down 尖朝下）；arch M center x y z radius r length l axis x 或 z（拱：半圆朝上，沿轴伸长）；line M from x y z to x y z；blueprint 图纸名 at x y z（把一张存好的图纸放在这里，西北角最下面对着这个点）。'
        + 'roof 楼梯 from x1 y z1 to x2 y z2（坡屋顶：在这块地上用楼梯一层层往里收，楼梯朝向自动算；加 gable 是人字顶（axis x / z 是屋脊方向，默认顺着长边），加 hip 是四坡顶；ridge 方块 指定屋脊，fill 方块 补人字顶两头的三角墙，overhang n 屋檐往外多出 n 格）。'
        + '形状后面可以加 hollow t（空心，壁厚 t）、open top / bottom / both（空心时那一头不封口；半球和拱的切面本来就是开口）；repeat N step dx dy dz（这一行画 N 份，每份挪一个步长：一排窗、一圈柱子）；mirror x / z / xz（再按 x=0 / z=0 的平面画镜像：对称的两翼，楼梯门的朝向跟着翻）。前面加 cut 是从前面画的形状里挖掉（门洞、窗户），材料写 air 是把世界里那些格子清空。'
        + '坐标都是方块坐标，相对于 build 时给的那个点（形状里的 0 0 0），x 往东、y 往上、z 往南；格子中心落在形状里就算（半径 6 的球 13 格宽）；后写的盖掉先写的。最大 256×256×256、100 万块。用 view 看某一层的切片，附一张只画到那一层的切开图（看里面是不是空的、楼层怎么分）。',
      '【下界】用 10 块黑曜石搭一个门框（参考图纸 nether_portal），拿打火石（flint_and_steel：1 铁锭 + 1 燧石）点门框里面最底下那块的上面，门框里会亮起紫色的传送门；走进去站一会儿就到了下界，从下界的门走回来就回到主世界。黑曜石要钻石镐才挖得动；岩浆源头碰到水会变成黑曜石，流动的岩浆碰到水变成圆石。下界到处是岩浆；床在那里一睡就会爆炸；水倒出来会马上蒸发；猪灵会打没穿金盔甲的人。',
      '【日志】每个世界有一本日志：你的目标、存好的图纸、用 mark 记的地点，还有盖过的房子、种过的地、床、死在哪，下次来这个世界还在。',
      '【说话】你回复里写的话是说出口的（主人和观众听得到）；游戏里的玩家要用 chat 才看得到。',
      formatActionList(),
    ].join('\n');
  }

  async start(): Promise<string> {
    if (this.runtime && this.status?.connected) return this.describeNow('还在游戏里');
    const problem = await this.options.preflight?.().catch((err: Error) => `检查开局设置时出错：${err.message}`);
    if (problem) {
      this.preflightFailed = true;
      return `这局开不了：${problem}。主人要在游戏库的 Minecraft 开局设置里改好。`;
    }
    this.preflightFailed = false;
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
    // 上一局（DSH 被关掉时）可能留着虚影
    if (this.options.rcon) void GhostBuild.clearAll(this.options.rcon);
    // 上一局的导播实体
    if (this.options.rcon) void rcon(this.options.rcon, 'kill @e[type=item_display,tag=dsh_cam]').catch(() => {});
    // 生存 / 创造：按开局设置切过去（上一局可能是另一个模式）
    if (this.options.rcon) await rcon(this.options.rcon, `gamemode ${this.options.creative ? 'creative' : 'survival'} ${this.options.username}`).catch(() => {});
    void this.startCamera();
    for (const p of this.status.players) if (p !== this.status.username && p !== this.cameraName) this.players.add(p);
    this.options.record({ type: 'start', game: 'minecraft' });
    await this.refresh();
    this.lastHealth = this.snapshot?.body?.health ?? null;
    this.lastPhase = phaseOf(this.snapshot?.world?.timeOfDay);
    this.poller = setInterval(() => void this.poll().catch(() => {}), POLL_MS);
    const world = await this.openJournal();
    return [this.describeNow(`进了服务器 ${this.options.host}:${this.options.port}（Minecraft ${this.status?.version ?? '版本不明'}，有哪些方块、物品和配方按这个版本来）`), world].filter(Boolean).join('\n');
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
    if (['collect', 'craft', 'smelt', 'go_to_player', 'follow', 'attack', 'find', 'equip', 'drop', 'place', 'farm', 'breed', 'mark', 'bucket', 'use'].includes(action.action) && !action.name?.trim()) return `${action.action} 要填 name。`;
    if (['go', 'place', 'build', 'farm', 'bucket', 'use', 'dig', 'site'].includes(action.action) && !parseXyz(action.text)
      && !(action.action === 'build' && this.sites.has(action.name?.trim() ?? ''))) return `${action.action} 要在 text 里填坐标「x y z」。`;
    if (['template', 'design', 'build', 'view', 'site'].includes(action.action) && !action.name?.trim()) return `${action.action} 要填 name。`;
    if (action.action === 'site' && !this.designs.has(action.name!.trim())) return `还没有叫「${action.name}」的图纸：先 design 交一张。`;
    if (action.action === 'show' && !action.name?.trim()) return 'show 要填 name（盖过的建筑名）。';
    if (action.action === 'show' && !this.builtAt(action.name!.trim())) return `不知道「${action.name}」盖在哪（日志里没有这座建筑${this.designs.size ? '' : '，也没有它的图纸'}）。`;
    if (action.action === 'site' && !this.options.rcon) return '服务器没开 RCON，放不了虚影（开局设置里填 RCON 密码）。';
    if (action.action === 'view' && !this.designs.has(action.name!.trim())) return `还没有叫「${action.name}」的图纸。`;
    if (action.action === 'design' && !action.text?.trim()) return 'design 要在 text 里放图纸。';
    if (action.action === 'template' && !TEMPLATES[action.name!.trim()]) return `没有这张参考图纸：${action.name}。有：${Object.keys(TEMPLATES).join('、')}`;
    if (action.action === 'build' && !this.designs.has(action.name!.trim())) {
      return `还没有叫「${action.name}」的图纸${this.designs.size ? `（现在有：${[...this.designs.keys()].join('、')}）` : ''}：先 design 交一张，或者 template 拿一张参考图纸。`;
    }
    if (['goal', 'chat'].includes(action.action) && !action.text?.trim()) return `${action.action} 要填 text。`;
    if (this.running && action.action === 'place') {
      return `身体正在${this.running.label}，${action.action} 要等它做完，或者先 stop。`;
    }
    return null;
  }

  async act(action: GameAction): Promise<string> {
    this.image = null;
    const runtime = this.runtime;
    if (!runtime) return '还没进游戏。';
    const name = action.name?.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_') ?? '';
    // 丢东西可以一次丢好几组（背包满了清杂物）；别的动作一次最多 64
    const count = Math.max(1, Math.min(action.action === 'drop' ? 36 * 64 : 64, Math.round(action.index ?? 1)));
    const xyz = parseXyz(action.text) ?? (action.action === 'build' ? this.sites.get(action.name?.trim() ?? '')?.origin ?? null : null);
    // 创造模式：要用的东西从创造物品栏直接拿（和真人一样），不用采集、合成
    if (this.options.creative) {
      if (action.action === 'craft' || action.action === 'collect') return `创造模式不用${action.action === 'craft' ? '合成' : '采集'}：要用什么，身体会从创造物品栏直接拿（种地的锄头和种子、桶、打火石、要放的方块……）。`;
      await this.creativeStock(action.action, name);
    }
    // 去做别的事了：摄像机回到她身上（飞到草稿附近看它不算：离草稿 64 格以内的 go 摄像机接着拍草稿）
    const nearDraft = action.action === 'go' && !!xyz && !!this.director && Math.hypot(xyz.x - this.director.center.x, xyz.z - this.director.center.z) <= 64;
    if (!nearDraft && !['design', 'template', 'view', 'site', 'build', 'show', 'look', 'journal', 'mark', 'goal', 'chat'].includes(action.action)) this.stopDirecting();
    switch (action.action) {
      case 'goal':
        this.goal = action.text!.trim();
        this.goalAt = Date.now();
        this.journal?.setGoal(this.goal);
        this.note(`目标：${this.goal}`);
        return `记下了，目标：${this.goal}`;
      case 'template':
      case 'design': {
        const title = action.name!.trim();
        const text = action.action === 'template' ? TEMPLATES[title].text : action.text!;
        const parsed = this.parseDesign(text);
        if (!parsed.blueprint) {
          return `图纸「${title}」读不了：\n- ${parsed.errors.join('\n- ')}${parsed.warnings.length ? `\n另外：\n- ${parsed.warnings.join('\n- ')}` : ''}`;
        }
        const names = Object.keys(materials(parsed.blueprint));
        const bad = await runtime.command<Record<string, string>>('check-blocks', { names }, 10_000).catch(() => ({}));
        const unknown = Object.values(bad);
        if (!unknown.length) {
          this.designs.set(title, parsed.blueprint);
          this.journal?.saveDesign(title, text);
        }
        const sited = !unknown.length && this.sites.has(title) ? await this.showDraft(title, this.sites.get(title)!.origin) : '';
        const preview = describeBlueprint(title, parsed.blueprint, parsed.warnings, unknown);
        const have = this.snapshot?.body?.inventory ?? {};
        const short = Object.entries(materials(parsed.blueprint)).filter(([n, c]) => (have[n] ?? 0) < c).map(([n, c]) => `${n} 还差 ${c - (have[n] ?? 0)}`);
        const enough = this.options.creative ? '创造模式不用材料。' : short.length ? `照现在的背包，材料${short.join('，')}。` : '材料够了。';
        const picture = unknown.length ? '' : this.preview(parsed.blueprint, `图纸「${title}」`) ? `附了一张渲染图（${VIEW_LABELS}；四个角各看一眼）。` : '';
        return [
          action.action === 'template' ? `参考图纸 ${title}：${TEMPLATES[title].title}\n${text}\n` : '',
          preview,
          unknown.length ? '' : `存好了，可以 build ${title}。${enough}${parsed.blueprint.offset ? `用 view 看切片（共 ${parsed.blueprint.height} 层）。` : ''}${picture}${sited}`,
        ].filter(Boolean).join('\n');
      }
      case 'show': {
        const title = action.name!.trim();
        const where = this.builtAt(title)!;
        const bp = this.designs.get(title)!;
        const b = worldBase(bp, where);
        const center = { x: b.x + bp.width / 2, y: b.y + bp.height / 2, z: b.z + bp.depth / 2 };
        const size = Math.max(bp.width, bp.depth, bp.height);
        // 她：东南边斜上方，离开它的大小那么远，看得到全貌
        const d = size * 0.9 + 6;
        const spot = { x: Math.round(center.x + d * 0.7), y: Math.round(b.y + bp.height * 0.7 + 3), z: Math.round(center.z + d * 0.7) };
        let flown = await this.body('go_to', { position: spot, range: 1 }, 90_000).catch(() => null);
        // 创造模式飞不过去（屋里、山洞里出不来）：直接挪过去，这一下本来就是给镜头的
        if (flown?.outcome !== 'succeeded' && this.options.creative && this.options.rcon) {
          await rcon(this.options.rcon, `tp ${this.options.username} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5}`).catch(() => {});
          flown = { outcome: 'succeeded' } as MinecraftActionResult;
        }
        if (this.options.rcon) await rcon(this.options.rcon, `execute as ${this.options.username} at @s run tp @s ~ ~ ~ facing ${center.x.toFixed(1)} ${center.y.toFixed(1)} ${center.z.toFixed(1)}`).catch(() => {});
        this.directAround(center, size, bp.height, 62_000);
        const there = flown?.outcome === 'succeeded' ? `你在 ${fmtXyz(spot)}，面朝它` : '没飞到看它的地方，摄像机还是会去拍它';
        return `带大家看「${title}」：${there}；摄像机绕着它转一圈（一分钟），然后回到你身后。`;
      }
      case 'site': {
        const title = action.name!.trim();
        const shown = await this.showDraft(title, xyz!);
        return `「${title}」的地方选在 ${fmtXyz(xyz!)}。${shown}之后用 design 改「${title}」，虚影跟着变；build ${title} 不写坐标就盖在这里。`;
      }
      case 'look': {
        const scan = await runtime.command<TerrainScan>('terrain', { radius: 32 }, 20_000);
        const spots = findFlatSpots(scan);
        this.loadColors();
        this.image = { data: renderTerrain(scan, this.colors ?? null, spots), mediaType: 'image/png' };
        this.remember(`周围的地形（${fmtXyz(scan.me)}）`, this.image.data);
        return describeTerrain(scan, spots);
      }
      case 'view': {
        const bp = this.designs.get(action.name!.trim())!;
        const k = Math.max(1, Math.min(bp.height, Math.round(action.index ?? 1)));
        // 切开图：只画到这一层（上面的都拿掉），看得到这一层以里的样子
        const cut = this.preview({ ...bp, layers: bp.layers.slice(0, k), height: k }, `图纸「${action.name!.trim()}」切到第 ${k} 层`);
        return `图纸「${action.name!.trim()}」${layerSlice(bp, k)}${cut ? `\n附了一张切开图：只画到第 ${k} 层，上面的都拿掉了（${VIEW_LABELS}）。` : ''}`;
      }
      case 'mark': {
        if (!this.journal) return '这局没有世界日志（DSH 主目录不可写）。';
        const title = action.name!.trim();
        if (/^(删掉|删除|delete|remove)$/i.test(action.text?.trim() ?? '')) return this.journal.mark(title, null);
        const here = this.snapshot?.body?.position;
        const p = xyz ?? (here ? { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) } : null);
        if (!p) return '不知道你现在在哪，在 text 里填坐标「x y z」。';
        return this.journal.mark(title, { ...p, dimension: this.dimension() });
      }
      case 'journal':
        return this.journal ? this.journal.full() : '这局没有世界日志（DSH 主目录不可写）。';
      case 'chat':
        await runtime.command('say', { message: action.text!.trim() });
        this.note(`聊天栏：${action.text!.trim()}`);
        return '发到游戏聊天栏了。';
      case 'stop': {
        const was = this.running;
        const dropped = this.queue.length;
        this.queue = [];
        this.running = null;
        was?.abort?.abort();
        await runtime.command('stop', {});
        await this.clearGhosts();
        return was ? `停下了（原来在${was.label}${dropped ? `，排着的 ${dropped} 件也取消了` : ''}）。` : '本来就没在做什么。';
      }
      case 'find': {
        // 每一处的坐标和距离（近的在前）：她接着 go 或者 dig 要用
        const where = (r: MinecraftActionResult) => r.observations.map((o) => `- ${fmtFound(o.data)}`).join('\n');
        const block = await this.body('search_block', { block: name, radius: 64, count: 8 }, 30_000);
        if (block.outcome === 'succeeded') return `找到了 ${block.observations.length} 处 ${name}：\n${where(block)}`;
        const entity = await this.body('search_entity', { entity: name, radius: 64 }, 30_000);
        if (entity.outcome === 'succeeded') return `找到了 ${entity.observations.length} 个 ${name}：\n${where(entity)}`;
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
    // 盖房子：先在那个位置放出虚影（有 RCON 时），排着队的也先放
    if (action.action === 'build' && this.options.rcon) {
      const title = action.name!.trim();
      const label = `盖「${title}」`;
      const site = this.sites.get(title);
      if (site) {
        await site.ghost?.clear();
        this.sites.delete(title);
      }
      this.directAt(this.designs.get(title)!, xyz!);
      await this.ghosts.get(label)?.clear();
      const ghost = new GhostBuild(this.options.rcon, `b${++this.ghostSeq}`, this.options.log);
      this.ghosts.set(label, ghost);
      const cells = ghostCells(this.designs.get(title)!, xyz!);
      // 很大的建筑虚影太多（每块是一个实体）：只在不太多时放
      if (cells.length <= GHOST_MAX) await ghost.show(cells);
    }
    const meta: JournalMeta | undefined = action.action === 'build' ? { kind: 'build', name: action.name!.trim(), origin: xyz! }
      : action.action === 'farm' ? { kind: 'farm', crop: name, corner: xyz!, size: Math.max(1, Math.min(9, Math.round(action.index ?? 3))) }
        : action.action === 'sleep' ? { kind: 'sleep' } : undefined;
    if (action.action === 'build') this.journal?.usedDesign(action.name!.trim());
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
        case 'build': {
          const title = action.name!.trim();
          const bp = this.designs.get(title)!;
          if (this.options.creative) return ['creative_build', { title, origin: xyz }, `盖「${title}」`];
          return ['build_structure', { label: `「${title}」`, blocks: placements(bp, xyz!), clear: clearCells(bp, xyz!) }, `盖「${title}」`];
        }
        case 'farm': {
          const size = Math.max(1, Math.min(9, Math.round(action.index ?? 3)));
          return ['farm_plot', { seed: name, corner: xyz, size }, `在 ${fmtXyz(xyz!)} 开 ${size}×${size} 的地种 ${name}`];
        }
        case 'harvest': return ['harvest_crops', { crop: name || undefined, radius: 16, replant: true }, `收${name ? ` ${name}` : '庄稼'}`];
        case 'breed': return ['breed_animals', { animal: name, pairs: Math.min(4, count) }, `喂 ${name} 繁殖`];
        case 'dig': return ['dig_at', { position: xyz }, `挖掉 ${fmtXyz(xyz!)}`];
        case 'bucket': return ['use_bucket', { item: name, position: xyz }, name === 'bucket' ? `用桶装 ${fmtXyz(xyz!)} 的东西` : `把 ${name} 倒在 ${fmtXyz(xyz!)}`];
        case 'use': return ['use_on_block', { item: name, position: xyz, face: 'top' }, `对 ${fmtXyz(xyz!)} 用 ${name}`];
        case 'shear': return ['shear_sheep', { count: Math.min(16, action.index ? count : 3) }, '剪羊毛'];
        default: return ['pickup_drops', { radius: 12 }, '捡附近的掉落物'];
      }
    })();
    // 打怪、逃跑、躲起来不排队：先停下手上的事，自保完再接着做（能接着做的）
    if (this.running && URGENT.has(action.action)) {
      const was = this.running;
      await this.refresh().catch(() => {});
      const again = this.resumeOf(was);
      await this.replaceRunning();
      if (again) this.queue.unshift(again);
      this.begin(bodyAction, args, label, meta);
      const after = again ? `；做完接着${again.label}` : was.abort ? '' : `（${was.label}没有接着做：再做一遍会多做一份，要的话做完再下）`;
      return `先停下${was.label}，开始${label}${after}。做完或卡住了会在下一个时刻告诉你。`;
    }
    if (this.running) {
      this.queue.push({ bodyAction, args, label, meta });
      return `身体正在${this.running.label}，「${label}」排上了（前面还有 ${this.queue.length} 件，包括正在做的）。`;
    }
    this.begin(bodyAction, args, label, meta);
    return `开始${label}。做完或卡住了会在下一个时刻告诉你。`;
  }

  /** 创造模式盖房子：这里用 RCON 一层层放（不走身体），放完一层撤一层虚影 */
  private beginCreativeBuild(title: string, origin: { x: number; y: number; z: number }, label: string, meta?: JournalMeta): void {
    const target = this.options.rcon;
    const bp = this.designs.get(title);
    const abort = new AbortController();
    const running: Running = { id: randomUUID(), label, startedAt: Date.now(), inventory: { ...(this.snapshot?.body?.inventory ?? {}) }, meta, abort };
    this.running = running;
    this.options.onAction?.(label);
    this.options.record({ type: 'act', text: label });
    const total = bp ? placements(bp, origin).length : 0;
    const fail = (message: string): MinecraftActionResult => ({
      actionId: running.id, outcome: 'failed', summary: message, durationMs: Date.now() - running.startedAt, inventoryDelta: {}, worldChanges: [], observations: [],
      error: { code: 'blocked', recoverable: true, details: { message } },
    });
    const run = async (): Promise<MinecraftActionResult> => {
      if (!target) return fail('creative building needs RCON');
      if (!bp) return fail(`no blueprint called ${title}`);
      // 她站在要盖的地方：先让她到房顶上面去（创造模式能飞），不然方块放进她身体里
      const b0 = worldBase(bp, origin);
      const me = this.snapshot?.body?.position;
      if (me && me.x >= b0.x - 1 && me.x <= b0.x + bp.width && me.z >= b0.z - 1 && me.z <= b0.z + bp.depth && me.y >= b0.y - 1 && me.y <= b0.y + bp.height) {
        await rcon(target, `tp ${this.options.username} ${b0.x + Math.floor(bp.width / 2)} ${b0.y + bp.height + 1} ${b0.z + Math.floor(bp.depth / 2)}`).catch(() => {});
      }
      const ghost = this.ghosts.get(label);
      let lastQuarter = 0;
      const r = await placeLayers(target, bp, origin, {
        signal: abort.signal,
        onLayer: (p) => {
          ghost?.removeLayer(p.y);
          const quarter = Math.floor((p.index / p.total) * 4);
          if (p.total >= 8 && quarter > lastQuarter && quarter < 4) {
            lastQuarter = quarter;
            this.push(`「${title}」长到第 ${p.index}/${p.total} 层了`, false);
          }
        },
      });
      const durationMs = Date.now() - running.startedAt;
      if (r.stopped) return { ...fail('stopped building'), outcome: 'cancelled' };
      const summary = `「${title}」: ${total}/${total} blocks in place, ${r.layers} layers${r.failed.length ? `; some commands failed: ${r.failed.join('; ')}` : ''}`;
      return { actionId: running.id, outcome: r.failed.length ? 'partial' : 'succeeded', summary, durationMs, inventoryDelta: {}, worldChanges: [], observations: [] };
    };
    void run().then((r) => this.finishRunning(running, r), (err: Error) => this.finishRunning(running, null, err.message));
  }

  /** 创造模式：这件事要用的东西放进背包（服务器 give；创造物品栏本来什么都有） */
  private async creativeStock(act: string, name: string): Promise<void> {
    const target = this.options.rcon;
    if (!target || (!name && act !== 'shear')) return;
    const items: [string, number][] = act === 'farm' ? [['iron_hoe', 1], [name, 64]]
      : act === 'bucket' || act === 'use' || act === 'equip' ? [[name, 1]]
        : act === 'place' ? [[name, 64]]
          : act === 'shear' ? [['shears', 1]]
            : [];
    const have = this.snapshot?.body?.inventory ?? {};
    const missing = items.filter(([item, count]) => (have[item] ?? 0) < Math.min(count, 1));
    if (!missing.length) return;
    await rconBatch(target, missing.map(([item, count]) => `give ${this.options.username} minecraft:${item} ${count}`)).catch(() => {});
    // 等身体那边的背包跟上
    await new Promise((r) => setTimeout(r, 600));
  }

  /** 一座盖过的建筑在哪：日志里最近一次盖它的位置（要有它的图纸） */
  private builtAt(title: string): { x: number; y: number; z: number } | null {
    if (!this.designs.has(title)) return null;
    const b = this.journal?.buildingsNamed(title)[0];
    return b ? { x: b.x, y: b.y, z: b.z } : null;
  }

  /** 在选好的地方放出（或换上）这张图纸的虚影；摄像机去看它。返回给她的一句话 */
  private async showDraft(title: string, origin: { x: number; y: number; z: number }): Promise<string> {
    const target = this.options.rcon;
    const bp = this.designs.get(title);
    if (!target || !bp) return '';
    const old = this.sites.get(title);
    await old?.ghost?.clear();
    const ghost = new GhostBuild(target, `d${++this.ghostSeq}`, this.options.log);
    let cells = ghostCells(bp, origin);
    let note = '那里出现了它的虚影。';
    if (cells.length > GHOST_MAX) {
      cells = outlineCells(bp, origin);
      note = '它太大了，那里只画出外框的轮廓线。';
    }
    await ghost.show(cells);
    this.sites.set(title, { origin, ghost });
    this.directAt(bp, origin);
    return note;
  }

  /** 导播：摄像机离开她，从东南边斜上方绕着这块地慢慢转（一圈一分钟） */
  private directAt(bp: Blueprint, origin: { x: number; y: number; z: number }, forMs = 180_000): void {
    const b = worldBase(bp, origin);
    this.directAround({ x: b.x + bp.width / 2, y: b.y + bp.height / 2, z: b.z + bp.depth / 2 }, Math.max(bp.width, bp.depth, bp.height), bp.height, forMs);
  }

  /**
   * 导播：摄像机挂在一个看不见的展示实体（item_display，标签 dsh_cam）上，挪这个实体。
   * 直接瞬移摄像机，客户端不补帧，一顿一顿的；挂在实体上，画面跟着实体在客户端的位置走，
   * 展示实体的 teleport_duration 让客户端在两次挪动之间平滑地过渡（每 0.25 秒挪一次，过渡也是 0.25 秒）
   */
  private directAround(center: { x: number; y: number; z: number }, size: number, height: number, forMs: number): void {
    const target = this.options.rcon;
    if (!target || !this.cameraName || !this.cameraSeen) return;
    const radius = size * 1.1 + 8;
    const lift = Math.max(height * 0.6, radius * 0.45);
    const start = Date.now();
    const at = (t: number) => {
      const angle = Math.PI / 4 + (t / 60_000) * Math.PI * 2;
      return `${(center.x + radius * Math.cos(angle)).toFixed(2)} ${(center.y + lift).toFixed(2)} ${(center.z + radius * Math.sin(angle)).toFixed(2)} facing ${center.x.toFixed(2)} ${center.y.toFixed(2)} ${center.z.toFixed(2)}`;
    };
    const fresh = !this.director;
    if (this.director) clearInterval(this.director.timer);
    if (fresh) {
      this.followRig = null;
      void rconBatch(target, [
        'kill @e[type=item_display,tag=dsh_cam]',
        `execute as ${this.cameraName} run spectate`,
        `summon item_display ${at(0).split(' facing')[0]} {teleport_duration:5,Tags:["dsh_cam"]}`,
        `spectate @e[type=item_display,tag=dsh_cam,limit=1] ${this.cameraName}`,
      ]).catch(() => {});
    }
    const step = () => {
      if (!this.director) return;
      if (Date.now() > this.director.until) { this.stopDirecting(); return; }
      // 往前算 0.25 秒：实体在过渡结束时正好到那里
      void rcon(target, `tp @e[type=item_display,tag=dsh_cam,limit=1] ${at(Date.now() - start + 250)}`).catch(() => {});
    };
    // 太久没动静（3 分钟）就回到她身上；盖的时候盖完再延
    this.director = { timer: setInterval(step, 250), until: Date.now() + forMs, center };
    step();
  }

  /** 摄像机回到她身上 */
  private stopDirecting(): void {
    if (!this.director) return;
    clearInterval(this.director.timer);
    this.director = null;
    const target = this.options.rcon;
    // 跟拍：导播一直在她附近拍，那一片早就加载好了；下一步跟拍直接在机位上换一个镜头实体挂上，一下切过去
    if (target && this.view === 'follow') {
      this.followRig = null;
      this.followReset = true;
      this.followPausedUntil = 0;
      return;
    }
    if (target) void rconBatch(target, [`execute as ${this.cameraName} run spectate`, 'kill @e[type=item_display,tag=dsh_cam]']).catch(() => {}).then(() => this.reattachCamera());
    else void this.reattachCamera();
  }

  /** 画一张图纸的渲染图，等 game_act 取走；画不了（没装客户端）返回 false */
  private preview(bp: Blueprint, label: string): boolean {
    this.loadColors();
    if (!this.colors) return false;
    try {
      this.image = { data: renderBlueprint(bp, this.colors), mediaType: 'image/png' };
      this.remember(label, this.image.data);
      return true;
    } catch (err) {
      this.options.log?.(`[preview] could not render: ${(err as Error).message}`);
      return false;
    }
  }

  /** 方块颜色（游戏 jar 里的贴图）：第一次用到时读 */
  private loadColors(): void {
    if (this.colors === undefined) {
      const version = this.status?.version ?? '';
      const root = version ? findMinecraftRoot(this.options.clientDir ?? this.options.camera?.clientDir ?? '', version) : null;
      try {
        this.colors = root ? new BlockColors(new GameJar(path.join(root, 'versions', version, `${version}.jar`))) : null;
      } catch (err) {
        this.options.log?.(`[preview] could not open the game jar: ${(err as Error).message}`);
        this.colors = null;
      }
    }
  }

  private remember(label: string, data: Uint8Array): void {
    this.pictures.push({ id: ++this.pictureSeq, label, at: Date.now(), data });
    if (this.pictures.length > 30) this.pictures.shift();
  }

  gallery(): { id: number; label: string; at: number }[] {
    return this.pictures.map(({ id, label, at }) => ({ id, label, at }));
  }

  galleryImage(id: number): { data: Uint8Array; mediaType: 'image/png' } | null {
    const p = this.pictures.find((x) => x.id === id);
    return p ? { data: p.data, mediaType: 'image/png' } : null;
  }

  takeImage(): { data: Uint8Array; mediaType: 'image/png' } | null {
    const image = this.image;
    this.image = null;
    return image;
  }

  /** 字符图或形状图纸（形状里可以引用已经存好的图纸） */
  private parseDesign(text: string): ParseResult {
    return isShapeText(text) ? parseShapes(text, (n) => this.designs.get(n)) : parseBlueprint(text);
  }

  /** 身体开始做一件长动作（做完自动接着做排队的下一件） */
  private begin(bodyAction: string, args: Record<string, unknown>, label: string, meta?: JournalMeta): void {
    const runtime = this.runtime;
    if (!runtime) return;
    if (bodyAction === 'creative_build') {
      this.beginCreativeBuild(String(args.title), args.origin as { x: number; y: number; z: number }, label, meta);
      return;
    }
    const id = randomUUID();
    const running: Running = { id, label, startedAt: Date.now(), inventory: { ...(this.snapshot?.body?.inventory ?? {}) }, meta, bodyAction, args };
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
    this.saveLast();
    if (this.director) clearInterval(this.director.timer);
    this.director = null;
    if (this.options.rcon) await rcon(this.options.rcon, 'kill @e[type=item_display,tag=dsh_cam]').catch(() => {});
    for (const site of this.sites.values()) await site.ghost?.clear();
    this.sites.clear();
    await this.clearGhosts();
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.hudTimer) clearInterval(this.hudTimer);
    this.hudTimer = null;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    this.followLink?.close();
    this.followLink = null;
    this.followRig = null;
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
    // 拿、丢、找：身体在做长动作时也马上做，长动作不停
    const command = this.running && QUICK_ACTIONS.has(name) ? 'quick-action' : 'execute-action';
    return this.runtime!.command<MinecraftActionResult>(command, { id: randomUUID(), name, args }, timeoutMs);
  }

  /** 死了告诉她：东西还在不在身上按服务器的「死亡不掉落」（keepInventory，主人可能直播中途改）说；查不到就两种都说 */
  private async deathNote(position?: { x: number; y: number; z: number }): Promise<void> {
    const reply = this.options.rcon ? await rcon(this.options.rcon, 'gamerule keepInventory').catch(() => '') : '';
    const keep = /true/.test(reply) ? true : /false/.test(reply) ? false : null;
    const items = keep === true ? '服务器开着死亡不掉落，身上的东西都还在身上'
      : keep === false ? '身上的东西掉在死的地方，5 分钟内回去还能捡（过了就没了）'
        : '服务器开着死亡不掉落的话东西都还在身上；没开就掉在死的地方，5 分钟内回去还能捡';
    this.push(`你死了${position ? `（在 ${fmtXyz(position)}）` : ''}。会在出生点（或者睡过的床边）复活，${items}。`, true);
  }

  /** 被自保的事打断的那件事，之后怎么接着做（不能接着做的返回 null）：采集只补还差的数量 */
  private resumeOf(was: Running): { bodyAction: string; args: Record<string, unknown>; label: string; meta?: JournalMeta } | null {
    if (was.abort || !was.bodyAction || !was.args || !RESUMABLE.has(was.bodyAction)) return null;
    if (was.bodyAction !== 'collect_item') return { bodyAction: was.bodyAction, args: was.args, label: was.label, meta: was.meta };
    const item = String(was.args.item ?? was.args.block ?? '');
    const now = this.snapshot?.body?.inventory ?? {};
    const got = (now[item] ?? 0) - (was.inventory[item] ?? 0);
    const left = Number(was.args.quantity ?? 1) - Math.max(0, got);
    if (left <= 0) return null;
    return { bodyAction: 'collect_item', args: { ...was.args, quantity: left }, label: `采集 ${item} ×${left}`, meta: was.meta };
  }

  /** 新的长动作要开始：停掉正在做的（返回原来在做什么） */
  private async replaceRunning(): Promise<string | null> {
    const was = this.running;
    if (!was) return null;
    this.running = null;
    was.abort?.abort();
    await this.runtime?.command('cancel-action', { actionId: was.id }, 10_000).catch(() => {});
    await this.runtime?.command('stop', {}, 10_000).catch(() => {});
    return was.label;
  }

  /** 去掉所有虚影（停下、这局结束时） */
  private async clearGhosts(): Promise<void> {
    const ghosts = [...this.ghosts.values()];
    this.ghosts.clear();
    await Promise.all(ghosts.map((g) => g.clear()));
  }

  private finishRunning(running: Running, result: MinecraftActionResult | null, error?: string): void {
    if (running.meta?.kind === 'build' && this.director) this.director.until = Math.min(this.director.until, Date.now() + 5_000);
    // 这次盖完了（成没成都一样）：剩下的虚影撤掉
    const ghost = this.ghosts.get(running.label);
    if (ghost) {
      this.ghosts.delete(running.label);
      void ghost.clear();
    }
    // 被新动作顶掉的：不用再报
    if (this.running !== running && result?.outcome === 'cancelled') return;
    if (this.running === running) this.running = null;
    if (result && running.meta) this.recordDone(running.meta, result);
    const seconds = Math.round((Date.now() - running.startedAt) / 1000);
    const text = result ? describeResult(result, running.label) : `${running.label}：出错了（${error}）`;
    this.options.onAction?.(text);
    const next = !this.running && !this.disconnected ? this.queue.shift() : undefined;
    this.push(`${text}（用了 ${seconds} 秒）${next ? `；接着做排着的「${next.label}」` : ''}`, true);
    if (next) this.begin(next.bodyAction, next.args, next.label, next.meta);
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
      case 'build-progress':
        this.push(event.text, false);
        break;
      case 'build-placed':
        if (this.running) this.ghosts.get(this.running.label)?.remove(event);
        break;
      case 'death':
        this.lastDeathAt = Date.now();
        // 正在做的事由身体自己报（死的时候它会停掉并回报），这里不清，免得两边对不上
        this.queue = [];
        if (event.position) this.journal?.addDeath({ x: Math.floor(event.position.x), y: Math.floor(event.position.y), z: Math.floor(event.position.z), dimension: this.dimension() });
        void this.deathNote(event.position);
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
      case 'fought-back':
        this.push(event.killed ? `被 ${event.attacker} 打了，身体拿上武器还手，把它打死了。` : `被 ${event.attacker} 打了，身体拿上武器还手，没打死（它跑开了，或者打了 20 秒还在）。`, true);
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
    if (Date.now() - this.lastJournalSave > 60_000) this.saveLast();
    const dimension = String(s?.world?.dimension ?? '');
    const moved = this.lastDimension !== null && dimension !== this.lastDimension;
    if (moved) this.crossedDimension(this.lastDimension!, dimension, s?.body?.position);
    this.lastDimension = dimension;
    if (moved || Date.now() - this.lastRespectate >= RESPECTATE_MS) void this.attachSpectators();
    // 她一下子跑远了（死了在出生点复活、被传送）或者换了维度：服务器那边旁观会跟过去，摄像机客户端的画面却会停在原地，重新挂一次
    const here = s?.body?.position;
    const jumped = !!here && !!this.lastBodyPos && Math.hypot(here.x - this.lastBodyPos.x, here.y - this.lastBodyPos.y, here.z - this.lastBodyPos.z) > 24;
    if (here) this.lastBodyPos = { x: here.x, y: here.y, z: here.z };
    if (this.director) { /* 导播在拍别的地方：不拉回她身上 */ }
    else if (jumped || moved) void this.reattachCamera();
    else void this.keepCameraAttached();
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
    this.f5 = 'first';
    this.followRig = null;
    this.defaultViewSet = false;
    this.camera = new CameraClient({
      root, version, username: cam.name, host: this.options.host, port: this.options.port,
      gameDir: cam.gameDir, java: findJava(cam.java, root), hudPort: cam.hudPort, log: this.options.log,
    });
    this.cameraNote = `摄像机客户端（${cam.name}，Minecraft ${version}）正在打开，进服后会自动挂到她身上。`;
    try {
      await this.camera.start();
      this.hudTimer ??= setInterval(() => void this.pushHud(), HUD_MS);
      this.followTimer ??= setInterval(() => void this.followStep(), FOLLOW_MS);
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

  /** 主人切视角：跟拍，或者原版的她的视角 / 背后 / 正面 */
  async setClientView(mode: string): Promise<string> {
    const views = ['follow', 'first', 'back', 'front'] as const;
    if (!views.includes(mode as (typeof views)[number])) return `没有这个视角：${mode}`;
    if (!this.camera?.running) return '摄像机客户端没开。';
    const view = mode as (typeof views)[number];
    if (view === 'follow') {
      if (!(await this.pressF5('first'))) return '没能给摄像机窗口发按键。';
      this.followReset = true;
    } else {
      // 从跟拍切回原版：收掉镜头实体，摄像机直接挂回她身上（就在旁边，不用重新加载）
      if (this.view === 'follow' && !this.director && this.options.rcon) {
        this.followRig = null;
        void rconBatch(this.options.rcon, ['kill @e[type=item_display,tag=dsh_cam]', `spectate ${this.options.username} ${this.cameraName}`]).catch(() => {});
      }
      if (!(await this.pressF5(view))) return '没能给摄像机窗口发按键。';
    }
    this.view = view;
    this.options.onStateChange?.();
    return 'ok';
  }

  /** 摄像机客户端切到这个人称：按需要的次数发 F5 */
  private async pressF5(want: 'first' | 'back' | 'front'): Promise<boolean> {
    const order = ['first', 'back', 'front'] as const;
    const presses = (order.indexOf(want) - order.indexOf(this.f5) + 3) % 3;
    if (presses && !(await this.camera?.pressKey(0x74, 0x3f, presses))) return false;
    this.f5 = want;
    return true;
  }

  /**
   * 跟拍的一步：问身体镜头该在哪（body/followCam.ts），挪镜头实体。
   * 镜头实体和导播用的是同一种（item_display，标签 dsh_cam）：导播在拍别的地方时不动；
   * 机位一下子换到另一边、她被传送：杀掉旧的、在新机位放一个再挂上（直接切，不从墙里穿过去）；
   * 太窄放不下镜头：摄像机挂回她身上（她的视角），有地方了再放
   */
  private async followStep(): Promise<void> {
    const target = this.options.rcon;
    if (this.view !== 'follow' || this.director || !target || !this.camera?.running || !this.cameraSeen || !this.runtime || this.disconnected || this.followBusy) return;
    if (Date.now() < this.followPausedUntil) return;
    this.followBusy = true;
    try {
      const reset = this.followReset;
      this.followReset = false;
      const pose = await this.runtime.command<FollowPose | null>('follow-cam', { reset }, 1000).catch(() => null);
      if (!pose || this.view !== 'follow' || this.director || Date.now() < this.followPausedUntil) return;
      const link = (this.followLink ??= new RconLink(target));
      const cam = this.cameraName;
      if (pose.first) {
        if (this.followRig) {
          this.followRig = null;
          link.send(`execute as ${cam} run spectate`);
          link.send('kill @e[type=item_display,tag=dsh_cam]');
          link.send(`spectate ${this.options.username} ${cam}`);
        }
        return;
      }
      const xyz = `${pose.x.toFixed(2)} ${pose.y.toFixed(2)} ${pose.z.toFixed(2)}`;
      if (!this.followRig || pose.cut) {
        link.send('kill @e[type=item_display,tag=dsh_cam]');
        link.send(`execute at ${this.options.username} run summon item_display ${xyz} {teleport_duration:3,Rotation:[${pose.yaw.toFixed(1)}f,${pose.pitch.toFixed(1)}f],Tags:["dsh_cam"]}`);
        link.send(`spectate @e[type=item_display,tag=dsh_cam,limit=1] ${cam}`);
      } else {
        // 上一条还没回来（远程服务器慢）：这一步不发，排着的旧位置没用，下一步发最新的
        if (link.backlog > 0) return;
        link.send(`tp @e[type=item_display,tag=dsh_cam,limit=1] ${xyz} ${pose.yaw.toFixed(1)} ${pose.pitch.toFixed(1)}`);
      }
      this.followRig = { x: pose.x, y: pose.y, z: pose.z };
    } finally {
      this.followBusy = false;
    }
  }

  /** 摄像机进服了：切成旁观；挂到她身上由 keepCameraAttached 负责（刚进服还在加载地形时挂不上） */
  private async cameraJoined(): Promise<void> {
    const target = this.options.rcon;
    if (!target) return;
    await rcon(target, `gamemode spectator ${this.cameraName}`).catch(() => {});
    this.lastCameraCheck = 0;
    this.followPausedUntil = Date.now() + 8000;
  }

  /**
   * 摄像机重新挂一次（她一下子跑远了、换了维度、复活）：先放开，传送过去，等客户端加载好周围，再挂上。
   * 跟拍时传送到跟拍的机位上（朝向也对好），加载完在那里放镜头实体挂上；不跟拍、或者她那里放不下镜头，就传送到她身上、挂到她身上
   * （传送到她身上的那一下，镜头在她身体里面，画面上是她的脸：跟拍时尽量不走这条）
   */
  private async reattachCamera(): Promise<void> {
    const target = this.options.rcon;
    if (!target || !this.cameraSeen) return;
    this.lastCameraCheck = Date.now();
    // 跟拍的镜头实体先收掉，等摄像机加载好了再放（导播的不动：导播放手时自己收）
    const follow = this.view === 'follow' && !this.director;
    let pose: FollowPose | null = null;
    if (follow) {
      this.followRig = null;
      this.followReset = false;
      this.followPausedUntil = Date.now() + 60_000;
      pose = (await this.runtime?.command<FollowPose | null>('follow-cam', { reset: true }, 1000).catch(() => null)) ?? null;
    }
    const spot = pose && !pose.first ? pose : null;
    const place = spot
      ? `execute at ${this.options.username} run tp ${this.cameraName} ${spot.x.toFixed(2)} ${spot.y.toFixed(2)} ${spot.z.toFixed(2)} ${spot.yaw.toFixed(1)} ${spot.pitch.toFixed(1)}`
      : `tp ${this.cameraName} ${this.options.username}`;
    await rconBatch(target, [`execute as ${this.cameraName} run spectate`, ...(follow ? ['kill @e[type=item_display,tag=dsh_cam]'] : []), place]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    if (follow) this.followPausedUntil = 0;
    // 跟拍：下一步在摄像机现在的地方放镜头实体挂上
    if (spot) return;
    await rcon(target, `spectate ${this.options.username} ${this.cameraName}`).catch(() => {});
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
    // 跟拍时摄像机挂在镜头实体上（离她几格）：看离实体近不近；没挂上就把实体作废，下一步重新放一个、重新挂
    const rig = this.view === 'follow' ? this.followRig : null;
    const at = rig ?? me;
    const attached = nums && nums.length >= 3 && Math.hypot(nums[0] - at.x, nums[1] - at.y, nums[2] - at.z) < (rig ? 3 : 2);
    if (!attached) {
      if (rig) this.followRig = null;
      else await rcon(target, `spectate ${this.options.username} ${this.cameraName}`).catch(() => {});
    }
    // 第一次挂稳：切到主人选的视角（跟拍时客户端就是第一人称，不用按）
    if (attached && !this.defaultViewSet) {
      this.defaultViewSet = true;
      if (this.view !== 'follow') await this.pressF5(this.view);
    }
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

  // ───────────────────────── 世界日志 ─────────────────────────

  /** 开局：打开这个世界的日志，接上目标和图纸；返回给她的「这个世界」那段 */
  private async openJournal(): Promise<string> {
    const dir = this.options.journalDir;
    if (!dir || this.journal) return '';
    const seed = this.options.rcon ? (await rcon(this.options.rcon, 'seed').catch(() => '')).match(/-?\d+/)?.[0] : undefined;
    try {
      const { journal, note } = WorldJournal.open(dir, `${this.options.host}:${this.options.port}`, this.options.username, seed);
      this.journal = journal;
      if (!this.goal && journal.goal) this.goal = journal.goal;
      // 字符图先接上，形状图纸后接（它可能引用别的图纸）；旧的先接
      const saved = [...journal.designs].reverse();
      for (const d of [...saved.filter((x) => !isShapeText(x.text)), ...saved.filter((x) => isShapeText(x.text))]) {
        const bp = this.parseDesign(d.text).blueprint;
        if (bp && !this.designs.has(d.name)) this.designs.set(d.name, bp);
      }
      const intro = journal.intro();
      journal.startSession();
      return [note, intro].filter(Boolean).join('\n');
    } catch (err) {
      this.options.log?.(`[journal] could not open: ${(err as Error).message}`);
      return '';
    }
  }

  /** 身体做完一件要记的事 */
  private recordDone(meta: JournalMeta, r: MinecraftActionResult): void {
    const j = this.journal;
    if (!j || r.outcome === 'cancelled') return;
    const dimension = this.dimension();
    if (meta.kind === 'build') {
      const m = r.summary.match(/(\d+)\/(\d+) blocks/);
      const done = m ? Number(m[1]) : r.outcome === 'succeeded' ? 1 : 0;
      const total = m ? Number(m[2]) : 1;
      if (done > 0) j.addBuilding(meta.name, { ...meta.origin, dimension }, done, total);
    } else if (meta.kind === 'farm') {
      if (r.outcome === 'succeeded' || r.outcome === 'partial') j.addField(meta.crop, { ...meta.corner, dimension }, meta.size);
    } else if (meta.kind === 'sleep') {
      const p = this.snapshot?.body?.position;
      if (r.outcome === 'succeeded' && p) j.setBed({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension });
    }
  }

  /** 换了维度：告诉她到了哪；走传送门过去的，两头的门记进日志 */
  private crossedDimension(from: string, to: string, here: { x: number; y: number; z: number } | undefined): void {
    const name = (d: string) => dimensionName(d.replace('minecraft:', ''));
    const before = this.lastBodyPos;
    // 死了在主世界复活也会换维度：那不是走传送门
    const respawned = Date.now() - this.lastDeathAt < 30_000;
    const spot = (p: { x: number; y: number; z: number }, d: string) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: d.replace('minecraft:', '') });
    if (!respawned && before && here) this.journal?.addPortal(spot(before, from), spot(here, to));
    const where = here ? fmtXyz({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }) : '位置不明';
    this.push(respawned
      ? `在${name(to)}复活了（${where}）。`
      : `穿过传送门，到了${name(to)}（${where}），从${name(from)}过来的。你站在这边的传送门里；走出来再走回门里，就回到${name(from)}。`, true);
  }

  /** 玩到哪了：结束时、玩的过程中每分钟一次 */
  private saveLast(): void {
    this.lastJournalSave = Date.now();
    const p = this.snapshot?.body?.position;
    if (!this.journal || !p) return;
    const inv = formatInventory(this.snapshot?.body?.inventory);
    this.journal.setLast({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: this.dimension() }, this.running?.label, inv.length > 200 ? `${inv.slice(0, 200)}……` : inv);
  }

  private dimension(): string {
    return String(this.snapshot?.world?.dimension ?? 'overworld').replace('minecraft:', '');
  }

  private moment(reason: string): Moment {
    const s = this.snapshot;
    const lines = this.lines;
    this.lines = [];
    const notes: string[] = [];
    notes.push(this.goal ? `你的目标（${this.goalAt ? `你 ${new Date(this.goalAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 写的` : '上一局写的'}）：${this.goal}` : '你还没写下目标（想做什么可以用 goal 写下来）。');
    if (this.running) {
      const progress = inventoryChange(this.running.inventory, s?.body?.inventory);
      notes.push(`身体正在：${this.running.label}（${Math.round((Date.now() - this.running.startedAt) / 1000)} 秒了${progress ? `，到现在背包 ${progress}` : ''}）`);
    } else {
      notes.push('身体现在空着。');
    }
    if (this.queue.length) notes.push(`排着队：${this.queue.map((q) => q.label).join(' → ')}`);
    if (s?.body) notes.push(`背包：${formatInventory(s.body.inventory)}`);
    if (s?.body?.inWater) notes.push('你泡在水里（look 看看周围哪里是陆地）。');
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
  // 有具体原因（被打断的、卡住的）就带上；笼统的「cancelled」不写
  if (r.outcome === 'cancelled') return r.summary && !/cancel/i.test(r.summary) ? `${label}：停下了（${r.summary}）` : `${label}：停下了`;
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

/** find 找到的一处：坐标（方块坐标，能直接给 go、dig 用）和离她多远 */
function fmtFound(data: Record<string, unknown> | undefined): string {
  const p = data?.position as { x: number; y: number; z: number } | undefined;
  if (!p) return String(data?.name ?? '?');
  return `${String(data?.name ?? '')} 在 ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}，离你 ${Number(data?.distance ?? 0).toFixed(0)} 格`;
}

function fmt1(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
