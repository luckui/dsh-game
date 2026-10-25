/**
 * dsh-game 共享运行时：根插件（路由、舞台）和 agent 子插件（工具）共用同一份状态。
 *   - 当前的游戏会话（一次只玩一个）
 *   - 舞台事件总线（她说的话、表情、游戏提示 → 网页舞台）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryInfo as ddlcLibraryInfo } from './games/ddlc/profile.js';
import { DdlcSession } from './games/ddlc/session.js';
import { MinecraftSession } from './games/minecraft/session.js';
import { checkSetup as checkMcSetup, loadSetup as loadMcSetup, saveSetup as saveMcSetup, type McSetup } from './games/minecraft/setup.js';
import { NARRATOR_RATE, NARRATOR_VOICE } from './games/werewolf/characters.js';
import type { WolfEntry, WolfState } from './games/werewolf/engine.js';
import { WerewolfSession } from './games/werewolf/session.js';
import { checkSetup, loadSetup, saveSetup, type ListModels, type WolfSetup } from './games/werewolf/setup.js';
import type { GameSession, LiveSource, Moment, RunEvent } from './games/types.js';
import { DEFAULT_VOICE } from './tts.js';

export const MOODS = ['idle', 'talk', 'laugh', 'shocked', 'scared', 'sad', 'think', 'angry', 'shy', 'rice'] as const;
export type Mood = typeof MOODS[number];

export type StageEvent =
  /** audio：这句话的 mp3（base64），跟着事件一起推，舞台不用再单独去取（浏览器对同一地址的连接数有限） */
  | { type: 'say'; id: string; text: string; mood: Mood; audio: string | null; estimateMs: number; at: number }
  | { type: 'moment'; game: string; reason: Moment['reason']; where: string; prompt?: Moment['prompt']; at: number }
  /** 她在游戏里做了一件事（选项、读诗、写诗、删文件），界面上显示成一条操作 */
  | { type: 'act'; text: string; at: number }
  /** 狼人杀：牌桌上发生了一件事，带当前局面（界面整个重画） */
  | { type: 'wolf'; entry: WolfEntry; state: WolfState; at: number }
  /** 别的角色说话（狼人杀的其他玩家、法官）：seat 为 0 是法官 */
  | { type: 'voice'; id: string; seat: number; name: string; text: string; audio: string | null; estimateMs: number; at: number; tag?: 'inner' | 'wolf' }
  /** 这局游戏的状态变了（开局、暂停、继续、分出胜负、结束） */
  | { type: 'game-state'; state: GameState; at: number }
  /** 现在由哪个页面出声（页面 id）；其他页面收到的 say（她说的话）/ voice 不带声音（mute） */
  | { type: 'audio-owner'; owner: string | null; at: number };

export interface Settings {
  voice: string;
  censor: boolean;
  director: boolean;
  summaryModel: string;
  /** 游戏目录（有 DDLC.exe 的那一层）；空的话去 Steam 库里找 */
  ddlcDir: string;
  /** 旧版：狼人杀其余座位的默认模型。现在在游戏库的开局设置里，只在第一次搬过去 */
  wolfModel: string;
  /** 旧版：狼人杀的座位配置「角色=驱动方式」。同上 */
  wolfSeats: string;
  /** Minecraft 服务器（Java 版）：地址、端口、她在游戏里的名字 */
  mcHost: string;
  mcPort: number;
  mcUsername: string;
  /** 自己服务器的 RCON 端口和密码（密码空 = 不用）：旁观的主人自动挂到她身上 */
  mcRconPort: number;
  mcRconPassword: string;
  /** 摄像机客户端：开一个真的 Minecraft 客户端（离线账户、旁观模式）挂在她身上，画面就是她的视角 */
  mcCamera: boolean;
  /** 装好游戏的 .minecraft 目录（空 = 官方启动器的默认位置） */
  mcClientDir: string;
  /** Java 21（空 = 自动找 HMCL / 官方启动器带的） */
  mcJava: string;
  /** 摄像机在服务器里的名字 */
  mcCameraName: string;
  /** 摄像机 HUD 网页（直播时 OBS 浏览器源叠在游戏画面上）的端口（0 = 不开） */
  mcHudPort: number;
}
const DEFAULT_SETTINGS: Settings = { voice: DEFAULT_VOICE, censor: true, director: true, summaryModel: 'deepseek-official/deepseek-flash', ddlcDir: '', wolfModel: 'deepseek-official/deepseek-flash', wolfSeats: '', mcHost: '127.0.0.1', mcPort: 25565, mcUsername: 'DaFeiYu', mcRconPort: 25575, mcRconPassword: '', mcCamera: true, mcClientDir: '', mcJava: '', mcCameraName: 'DaFeiYuCam', mcHudPort: 7391 };

/** 插件配置的读取方式：根插件 apply 时接上配置（插件页改了立刻生效，每次用时现读） */
let readSettings: () => Partial<Settings> = () => ({});
export function bindSettings(read: () => Partial<Settings>): void {
  readSettings = read;
}
/** 当前的插件配置（agent 子插件、游戏会话都读这里） */
export const settings = new Proxy(DEFAULT_SETTINGS, {
  get: (defaults, key: keyof Settings) => {
    const value = readSettings()[key];
    return value === undefined || value === '' ? defaults[key] : value;
  },
}) as Readonly<Settings>;

/**
 * 对局日志（给剪辑用）：每次开游戏一个 JSONL 文件，在 DSH 主目录的 dsh-game/runs/ 下。
 * 每行一件事，带时间 t（毫秒时间戳）：游戏台词（正常 / 快进 / 狂点）、段落、提示、时刻（含快进摘要）、她的选择和操作、她说的话（开始和念完的时间）。
 * tools/export-run.mjs 把它整理成时间线、字幕。
 */
export type { RunEvent };

export const RUNS_DIR = path.join(process.env.DSH_HOME ?? os.tmpdir(), 'dsh-game', 'runs');
let runFile: string | null = null;

export function record(event: RunEvent): void {
  if (!runFile) return;
  try {
    fs.appendFileSync(runFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
  } catch {
    // 写不进去不影响玩
  }
}

/** 把一段素材（她说的话的 mp3）存到对局日志旁边的同名文件夹里，返回相对对局日志的路径；没在记录就返回 null */
export function saveRunAsset(name: string, data: Uint8Array): string | null {
  if (!runFile) return null;
  const dir = runFile.replace(/\.jsonl$/, '');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
    return `${path.basename(dir)}/${name}`;
  } catch {
    return null;
  }
}

function openRunLog(game: string): void {
  // 本地时间（和 OBS 录屏的文件名对得上）：20261017-130500
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    runFile = path.join(RUNS_DIR, `${stamp}-${game}.jsonl`);
    record({ type: 'start', game });
  } catch {
    runFile = null;
  }
}

/** 快进摘要（agent 子插件用 DSH 的模型服务提供） */
/** 快进摘要：instruction 由游戏给（怎么摘要） */
export const hooks: {
  summarize?: (lines: string[], instruction: string) => Promise<string>;
  /** 调一次模型（狼人杀的 AI 玩家用）：不思考，只要文字 */
  complete?: (model: string, system: string, user: string, signal?: AbortSignal) => Promise<string>;
  /** 让一个角色念一句话（合成语音、推给舞台、等念完） */
  voice?: (who: { seat: number; name: string; voice: string; rate?: number }, text: string, tag?: 'inner' | 'wolf') => Promise<void>;
  /** DSH 里配好的模型（狼人杀的开局设置用）：根插件接上宿主的 llm 服务 */
  listModels?: ListModels;
  /** 狼人杀的角色和法官念得出来吗（配了新版控制台的 API Key） */
  tableVoiced?: () => Promise<boolean>;
  /** 直播插件（dsh-livestream）提供的直播身体；没装、没开时是 undefined */
  live?: () => LiveBody | undefined;
} = {};

/**
 * 直播身体：dsh-livestream 提供的服务（约定见 dsh-livestream/docs/game-live-contract.md）。
 * 在播时她的话由直播插件念、上直播舞台；游戏画面由直播插件放上舞台
 */
export interface LiveBody {
  readonly onAir: boolean;
  /** 直播间有事等她（弹幕、礼物、主人说话）时 resolve */
  attention(signal: AbortSignal): Promise<void>;
  /** 把游戏画面放上直播舞台 / 撤下 */
  showGame(source: LiveSource | null): void;
}

/** Minecraft 摄像机客户端自己的游戏目录（设置、日志、HUD 的贴图和状态） */
export const minecraftCameraDir = (): string => path.join(process.env.DSH_HOME ?? os.tmpdir(), 'dsh-game', 'mc-camera');
/** 世界日志（一个服务器上的一个她一本） */
export const minecraftJournalDir = (): string => path.join(process.env.DSH_HOME ?? os.tmpdir(), 'dsh-game', 'minecraft-worlds');

/** 现在在直播吗（直播插件在、而且在播） */
export const onAir = (): LiveBody | null => {
  const live = hooks.live?.();
  return live?.onAir ? live : null;
};

/** Minecraft 的开局设置：旧版插件设置（mc*）只在第一次搬过来 */
const legacyMc = () => ({
  host: settings.mcHost, port: Number(settings.mcPort) || undefined, username: settings.mcUsername,
  camera: settings.mcCamera, cameraName: settings.mcCameraName, rconPort: Number(settings.mcRconPort) || undefined,
  rconPassword: settings.mcRconPassword, clientDir: settings.mcClientDir, java: settings.mcJava, hudPort: Number(settings.mcHudPort),
});
export const mcSetup = {
  load: () => loadMcSetup(legacyMc()),
  save: (setup: Partial<McSetup>) => saveMcSetup(setup, legacyMc()),
  /** 这局 Minecraft 正开着时，HUD 网页的端口是我们自己占着的 */
  check: () => checkMcSetup(loadMcSetup(legacyMc()), games.session?.id === 'minecraft'),
};

/** 狼人杀的开局设置：旧版插件设置只在第一次搬过来 */
const legacyWolf = () => ({ model: settings.wolfModel, seats: settings.wolfSeats });
export const wolfSetup = {
  load: () => loadSetup(legacyWolf()),
  save: (setup: Partial<WolfSetup>) => saveSetup(setup, legacyWolf()),
  check: () => checkSetup(loadSetup(legacyWolf()), () => (hooks.listModels ? hooks.listModels() : Promise.resolve(null))),
};

export const listeners = new Set<(event: StageEvent) => void>();

/**
 * 出声的页面：同一时间只有一个页面放声音、回执念完。开着好几个 DSH 页面（别的浏览器、别的窗口）时，
 * 同一句话不会被几个页面一起放（听起来像混响），也不会被没放声音的页面提前回执。
 * 谁出声：主人最近一次在里面点过、按过键的页面；那个页面关了，就交给最后连上的页面。
 */
const audioPages: string[] = [];
let audioOwner: string | null = null;
export const audio = {
  get owner(): string | null {
    return audioOwner;
  },
  connect(page: string): void {
    audioPages.push(page);
    if (!audioOwner) audio.setOwner(page);
  },
  disconnect(page: string): void {
    audioPages.splice(audioPages.indexOf(page), 1);
    // 页面换连接（打开游戏标签时会重连）会先断再连：等一会儿还没连回来才交给别的页面
    setTimeout(() => {
      if (audioOwner === page && !audioPages.includes(page)) audio.setOwner(audioPages.at(-1) ?? null);
    }, 3000);
  },
  claim(page: string): void {
    if (audioPages.includes(page) && audioOwner !== page) audio.setOwner(page);
  },
  setOwner(page: string | null): void {
    audioOwner = page;
    broadcast({ type: 'audio-owner', owner: page, at: Date.now() });
  },
};

/** 正在念的话：舞台播完回执 said，说话的工具才返回 */
interface Speech {
  done: () => void;
}
export const speeches = new Map<string, Speech>();

/** 等舞台把这句念完（回执 said）；没有舞台在听就不等 */
export function speak(id: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      speeches.delete(id);
      resolve();
    };
    const timer = setTimeout(finish, listeners.size ? timeoutMs : 0);
    signal.addEventListener('abort', finish, { once: true });
    speeches.set(id, { done: finish });
  });
}
/**
 * 只有一个麦克风：她说的话、别的角色和法官的话一句一句念，前一句念完下一句才开始（谁先要谁先念）。
 * 合成在拿麦之前做，等的时候只等前一句念完
 */
let micTail: Promise<void> = Promise.resolve();
export function withMic<T>(play: () => Promise<T>): Promise<T> {
  const turn = micTail.then(play, play);
  micTail = turn.then(() => undefined, () => undefined);
  return turn;
}

export function broadcast(event: StageEvent): void {
  for (const listen of listeners) listen(event);
}

/** 插件包里的 games/ 目录（mod、打码卡片）。构建产物在 lib/ 或 lib/chunks/，往上找 */
export function assetsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'games');
    if (fs.existsSync(path.join(candidate, 'renpy', 'zz_dsh_game.rpy'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('dsh-game: 找不到 games/ 素材目录');
}

/** Minecraft 身体子进程（构建产物 lib/minecraft-worker.cjs，和 lib/index.js 同级；打包分块时本文件可能在 lib/chunks/ 里） */
export function minecraftWorkerPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(dir, 'minecraft-worker.cjs');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('dsh-game: 找不到 lib/minecraft-worker.cjs（要先构建）');
}

/** 大肥鱼状态片段目录：插件包里的 assets/dafeiyu/（和 games/ 同级）；DSH_GAME_CLIPS 可以换成别的角色包 */
export function clipsDir(): string {
  return process.env.DSH_GAME_CLIPS ?? path.join(path.dirname(assetsDir()), 'assets', 'dafeiyu');
}

// ── 游戏画面推流：「游戏」标签打开时才推 ──────────────────

/** 推流帧率上限（每帧占游戏主线程约 10 毫秒，15 帧约占 15%） */
export const STREAM_FPS = 15;
const frameViewers = new Set<(jpeg: Buffer) => void>();
let lastFrame: Buffer | null = null;

/** 看画面的人：先给最新一帧，之后每来一帧给一帧。返回取消函数 */
export function watchFrames(onFrame: (jpeg: Buffer) => void): () => void {
  frameViewers.add(onFrame);
  if (lastFrame) onFrame(lastFrame);
  if (frameViewers.size === 1) current?.setStream?.(STREAM_FPS);
  return () => {
    frameViewers.delete(onFrame);
    if (frameViewers.size === 0) current?.setStream?.(0);
  };
}

function onFrame(jpeg: Buffer): void {
  lastFrame = jpeg;
  for (const viewer of frameViewers) viewer(jpeg);
}

/** 游戏库里一个游戏的卡片 */
export interface LibraryEntry {
  id: string;
  /** 卡片上的名字 */
  name: string;
  /** 原名 */
  subtitle: string;
  /** 类型标签 */
  tags: string[];
  /** 一句话介绍（给主人看） */
  blurb: string;
  /** 本机有没有装 */
  installed: boolean;
  /** 没装时去哪装 */
  getUrl: string;
  /** 插件存档的时间（没有是 null） */
  savedAt: string | null;
  /** Steam 上的 App ID：游戏库的封面、横幅、Logo 从 Steam 图床取（插件包里不带游戏美术） */
  steamAppId?: number;
  /** 插件自带的游戏：美术在 assets/ 里（封面、横幅、Logo 的文件名，相对 assets/） */
  localArt?: Partial<Record<ArtKind, string>>;
  /** 插件自带的游戏（不用安装） */
  builtin?: boolean;
}

/** 游戏库用的 Steam 美术：竖版封面、横幅大图、透明 Logo */
export const STEAM_ART = { capsule: 'library_600x900_2x.jpg', hero: 'library_hero.jpg', logo: 'logo.png' } as const;
export type ArtKind = keyof typeof STEAM_ART;

export const GAMES = {
  ddlc: {
    title: '心跳文学部（Doki Doki Literature Club）',
    library: (): LibraryEntry => ({
      id: 'ddlc',
      name: '心跳文学部',
      subtitle: 'Doki Doki Literature Club',
      tags: ["Ren'Py", '视觉小说', '免费'],
      blurb: '看起来是甜甜的恋爱游戏，其实会打破第四面墙。英文原版，大肥鱼边看边给你讲。',
      getUrl: 'https://store.steampowered.com/app/698780/',
      steamAppId: 698780,
      ...ddlcLibraryInfo(settings.ddlcDir),
    }),
    create: () => new DdlcSession({
      assetsDir: assetsDir(),
      gameDir: settings.ddlcDir,
      censor: settings.censor,
      director: settings.director,
      summarize: (lines, instruction) => hooks.summarize?.(lines, instruction) ?? Promise.resolve(''),
      onAction: (text) => {
        record({ type: 'act', text });
        broadcast({ type: 'act', text, at: Date.now() });
      },
      record,
      onFrame,
    }),
  },
  werewolf: {
    title: '狼人杀（AI 同桌）',
    library: (): LibraryEntry => ({
      id: 'werewolf',
      name: '狼人杀',
      subtitle: 'Werewolf · 九位 AI，你也可以上桌',
      tags: ['插件自带', '推理', '6~10 人局'],
      blurb: 'DeepSeek、Grok、Claude、GPT、Gemini、Qwen、Mistral、GLM、Kimi，最多九位 AI 娘围坐一桌，互相试探、撒谎、投票。你可以在上帝视角看全部身份和每个人的心声，也可以自己拿一张身份牌坐上去。',
      installed: true,
      getUrl: '',
      savedAt: null,
      builtin: true,
      localArt: { capsule: 'werewolf/capsule.jpg', hero: 'werewolf/cover.jpg' },
    }),
    create: () => new WerewolfSession({
      check: wolfSetup.check,
      complete: (model, system, user, signal) => (hooks.complete ? hooks.complete(model, system, user, signal) : Promise.reject(new Error('模型服务还没准备好'))),
      voice: (seat, character, text, tag) => hooks.voice?.(
        seat === 0 ? { seat: 0, name: '法官', voice: NARRATOR_VOICE, rate: NARRATOR_RATE }
          : { seat, name: character?.name ?? '', voice: character?.id === 'deepseek' ? settings.voice : character?.voice ?? NARRATOR_VOICE },
        text,
        tag,
      ) ?? Promise.resolve(),
      onEntry: (entry, state) => {
        if (entry.kind !== 'think') record({ type: 'wolf', entry });
        // 分出胜负：状态变成已结束（会话先记下 ended，下一拍再推）
        if (entry.kind === 'end') setTimeout(announceGameState, 0);
        broadcast({ type: 'wolf', entry, state, at: Date.now() });
      },
    }),
  },
  minecraft: {
    title: 'Minecraft',
    library: (): LibraryEntry => {
      const setup = mcSetup.load();
      const creative = setup.gameMode === 'creative';
      return {
      id: 'minecraft',
      name: 'Minecraft',
      subtitle: `Java 版 · ${creative ? '创造' : '生存'}`,
      tags: ['沙盒', creative ? '创造' : '生存', '服务器'],
      blurb: creative
        ? `大肥鱼以 ${setup.username} 的身份进一个 Minecraft 服务器，开创造模式：自己设计建筑，看着它一层层长出来；跟她说想看什么她就去盖。服务器、摄像机这些在下面的开局设置里。`
        : `大肥鱼以 ${setup.username} 的身份进一个 Minecraft 服务器自己玩：砍树、合成、挖矿、打怪，跟她说想看什么她就去做。服务器、摄像机这些在下面的开局设置里。`,
      installed: true,
      getUrl: 'https://www.minecraft.net/',
      savedAt: null,
      // 方块人大肥鱼的封面和横幅（Codex 画的，tools/minecraft-art.mjs）
      localArt: { capsule: 'minecraft/capsule.jpg', hero: 'minecraft/cover.jpg' },
      };
    },
    create: () => {
      const setup = mcSetup.load();
      return new MinecraftSession({
        workerPath: minecraftWorkerPath(),
        host: setup.host,
        port: setup.port,
        username: setup.username,
        camera: setup.camera
          ? { name: setup.cameraName, clientDir: setup.clientDir, java: setup.java, hudPort: setup.hudPort, gameDir: minecraftCameraDir() }
          : null,
        log: (text) => console.log(text),
        onStateChange: () => announceGameState(),
        rcon: setup.rconPassword ? { host: setup.host, port: setup.rconPort, password: setup.rconPassword } : null,
        journalDir: minecraftJournalDir(),
        creative: setup.gameMode === 'creative',
        clientDir: setup.clientDir,
        // 开局前先查一遍开局设置（她自己调 game_start 时也一样），没过就不开
        preflight: () => mcSetup.check().then((c) => c.problem),
        record,
        onAction: (text) => broadcast({ type: 'act', text, at: Date.now() }),
      });
    },
  },
} as const;
export type GameId = keyof typeof GAMES;

/**
 * 一局游戏的生命周期（插件里同一时间只有一局，属于开它的那个 DSH 会话）：
 *   none（没有）→ running（进行中）⇄ paused（暂停：主人按了停止，或她这一轮结束了）→ finished（分出胜负 / 剧情放完）
 *   任何时候都能 close（主人按「结束这局」、别的会话开了新局、插件卸载）→ none
 * 状态一变就推 game-state 给页面；页面打开时也会先要一次。
 */
export type GameStatus = 'none' | 'running' | 'paused' | 'finished';
export interface GameState {
  status: GameStatus;
  /** 游戏 id 和名字（没有游戏时是上一局的，配合 closed 用） */
  game: string | null;
  title: string | null;
  /** 这局属于哪个 DSH 会话 */
  owner: string | null;
  /** 上一局是怎么关掉的（没有游戏时显示给主人） */
  closed: { game: string; title: string; owner: string | null; reason: 'owner' | 'replaced'; note?: string } | null;
  /** 画面不在插件里时给主人看的说明 */
  note?: string | null;
  /** 游戏客户端现在的视角（有的话「游戏」标签页给切换按钮） */
  perspective?: string | null;
}

let current: GameSession | null = null;
/** 这局游戏属于哪个 DSH 会话（开局的那个）；别的会话再开局就换成新的一局 */
let currentOwner: string | null = null;
let paused = false;
let lastClosed: GameState['closed'] = null;

/** 推一次现在的状态 */
export function announceGameState(): void {
  broadcast({ type: 'game-state', state: games.state(), at: Date.now() });
}

export const games = {
  get session(): GameSession | null {
    return current;
  },
  /** 这局游戏属于哪个会话 */
  get owner(): string | null {
    return currentOwner;
  },
  state(): GameState {
    if (!current) return { status: 'none', game: lastClosed?.game ?? null, title: lastClosed?.title ?? null, owner: null, closed: lastClosed };
    return { status: current.finished ? 'finished' : paused ? 'paused' : 'running', game: current.id, title: current.title, owner: currentOwner, closed: null, note: current.screenNote || null, perspective: current.perspective ?? null };
  },
  /** 上一局是怎么关掉的 */
  get closed(): GameState['closed'] {
    return lastClosed;
  },
  async start(id: GameId, owner?: string): Promise<string> {
    // 换了游戏、上一局已经结束、或者是别的会话来开局（从游戏库点开的新会话）：关掉旧的，重新开
    if (current && (current.id !== id || current.finished || (owner && currentOwner && owner !== currentOwner))) await games.close('replaced');
    if (owner) currentOwner = owner;
    if (!current) {
      openRunLog(id);
      current = GAMES[id].create();
      current.setStream?.(frameViewers.size ? STREAM_FPS : 0);
      lastClosed = null;
    }
    paused = false;
    const status = await current.start();
    // 没开成（开局前检查没过）：这局不算有
    if (current.started === false) await games.stop();
    announceGameState();
    return status;
  },
  /** 暂停：主人按了停止，或她这一轮结束了。牌桌停在下一句话之前（狼人杀），她回来（game_continue / game_act）就继续 */
  pause(): void {
    if (!current || current.finished || paused) return;
    paused = true;
    current.pause?.();
    announceGameState();
  },
  /** 她回来玩了 */
  resume(): void {
    if (!paused) return;
    paused = false;
    announceGameState();
  },
  /** 结束这局：主人按「结束这局」，或别的会话开了新局 */
  async close(reason: 'owner' | 'replaced'): Promise<void> {
    if (!current) return;
    lastClosed = {
      game: current.id,
      title: current.title,
      owner: currentOwner,
      reason,
      // 《心跳文学部》是外面的程序：插件只断开、卸掉 mod，窗口留给主人自己关
      ...(current.id === 'ddlc' ? { note: '已经断开了《心跳文学部》。游戏窗口还开着的话，你可以直接把它关掉。' } : {}),
    };
    // 先让页面知道这局没了，再慢慢收尾：断开外面的游戏可能要等（游戏窗口还开着时），最多等 5 秒
    const stopping = games.stop();
    announceGameState();
    await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 5000))]);
  },
  /** 收掉这局（不记原因、不推状态：插件卸载时用；平时用 close） */
  async stop(): Promise<void> {
    const session = current;
    current = null;
    currentOwner = null;
    paused = false;
    lastFrame = null;
    await session?.stop();
  },
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** 把一个时刻写成给模型看的文字（只写事实） */
export { formatMoment } from './games/moment.js';
