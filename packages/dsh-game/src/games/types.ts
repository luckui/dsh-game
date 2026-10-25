import type { WolfEntry } from './werewolf/engine.js';

/**
 * 游戏会话的通用接口：agent 通过 game_start / game_continue / game_act 三个工具和它打交道。
 *
 * 提示词分三层：
 *   - 人设（agent 预设，所有游戏共用）：她是谁、主人在看、她写的文字会被念出来、mood 管表情
 *   - 平台（这里和 moment.ts、agent.ts 的工具说明）：时刻、「现在能做的事」、game_act 照着做。不出现任何游戏专属的词
 *   - 游戏（各游戏自己的目录）：背景和规则（facts）、每个时刻能做的事（actions）、在对的时候给的事实（notes）
 *
 * 节奏：会话把游戏里发生的事攒成一个个「时刻」（该你看了 / 轮到你了）。时刻准备好时游戏暂停，
 * agent 再调 game_continue 时游戏才继续，所以 agent 想多久、说多久都不会错过。
 */

/** 游戏在等她回答的提示 */
export interface PendingPrompt {
  id: string;
  /** 游戏自己的提示类型（游戏内部用） */
  kind: string;
  /** 给她看的名称：选项、弹窗…… */
  label: string;
  /** 能选的项 */
  choices: string[];
  /** 提示文字：选项的说明、弹窗内容、要读的东西 */
  detail?: string;
}

/** 她现在能在游戏里做的一件事（由游戏给出；game_act 照着填 action 和参数） */
export interface GameActionSpec {
  action: string;
  /** 这件事是什么 */
  description: string;
  /** 要填的参数 → 怎么填 */
  params?: Partial<Record<'index' | 'name' | 'text', string>>;
}

/** game_act 收到的一件事：action 加上游戏说明过的参数 */
export interface GameAction {
  action: string;
  index?: number;
  name?: string;
  text?: string;
}

export interface Moment {
  /** 时刻编号（递增）。game_continue 的 after 参数填它，每次调用参数都不同，也说明「从这里之后继续」 */
  seq: number;
  /**
   * 为什么现在交给她。通用的有 prompt（轮到她了）、timeout（一直没新东西）、disconnected、owner（主人插话），
   * 其余由各游戏自己定（剧情换场景、新画面……）
   */
  reason: string;
  /** 进度 */
  where: string;
  /** 上次以来发生的事（一行一件：台词、动作） */
  lines: string[];
  /** 在场的人 */
  onStage: string[];
  /** 在对的时候给的事实 */
  notes: string[];
  /** 快进过去的部分：件数和摘要 */
  skipped?: { count: number; summary: string };
  /** 新画面的截图 */
  image?: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' };
  /** 游戏在等她回答 */
  prompt?: PendingPrompt;
  /** 她现在能做的事 */
  actions?: GameActionSpec[];
}

/** 直播时游戏画面从哪来：网页地址，或者 OBS 窗口捕获的窗口（OBS 的「标题:窗口类:程序」）加上叠在上面的网页（HUD） */
export type LiveSource = { url: string } | { window: string; overlay?: string };

export interface GameSession {
  readonly id: string;
  readonly title: string;
  /** 游戏客户端的视角（Minecraft 摄像机：first 她的视角 / back 背后 / front 正面） */
  readonly perspective?: string;
  /** 切换游戏客户端的视角；返回 'ok' 或者做不到的原因 */
  setClientView?(mode: string): Promise<string>;
  /** 画面不在插件里时给主人看的说明（Minecraft：画面在摄像机客户端窗口里） */
  readonly screenNote?: string;
  /** 直播时上舞台的游戏画面（没有画面可放时是 null） */
  liveSource?(): LiveSource | null;
  /** 实时游戏（Minecraft）：世界不会停下来等她，她说话的同时身体就开始动 */
  readonly realtime?: boolean;
  /** 游戏背景和规则（事实），game_start 时交给 agent */
  readonly facts: string;
  /** 装 mod、开游戏；返回给 agent 的说明 */
  start(): Promise<string>;
  /** 等下一个时刻；signal 取消时立刻返回 timeout */
  wait(signal: AbortSignal, maxMs: number): Promise<Moment>;
  act(action: GameAction): Promise<string>;
  /** 刚做完的那件事附带的图（Minecraft 图纸的渲染图）：取一次就没了 */
  takeImage?(): { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' } | null;
  /** 她这局看过的图（渲染图、切开图、地形图），给主人在游戏页上翻看：最新的在后面 */
  gallery?(): { id: number; label: string; at: number }[];
  galleryImage?(id: number): { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' } | null;
  /** 画面推流帧率（0 = 不推）。有画面推流的游戏才实现 */
  setStream?(fps: number): void;
  /** 主人在她玩的时候插话了：正在等的时刻提前交给她，让她马上看到 */
  nudge?(): void;
  /** 主人按了停止：游戏停在下一句话之前，等她回来（game_continue / game_act）再走 */
  pause?(): void;
  /** 这件事现在做不了的原因（做得了是 null）：game_act 先问一下，做不了就不念她那句话，直接把原因交给她 */
  refuse?(action: GameAction): string | null;
  /** 这局已经结束了（再开就是新的一局） */
  readonly finished?: boolean;
  /** 开局成功了没有（狼人杀开局前检查没过时是 false：这局其实没开） */
  readonly started?: boolean;
  /** 她回复里写的话这会儿主人听不到（狼人杀主人上桌时）：不念，记下来结束后看 */
  mutesHer?(): boolean;
  noteHerWords?(text: string): void;
  /** 开发测试用：跳到某个段落 / 显示某张图（只在 DSH_GAME_DEV=1 时由开发路由调用） */
  dev?(command: { jump?: string; show?: string }): boolean;
  stop(): Promise<void>;
}

/** 对局日志的一件事（给剪辑用；写进文件时再加时间 t），见 runtime.ts 的 record */
export type RunEvent =
  | { type: 'start'; game: string }
  /** 游戏台词：mode 是正常播放、快进（导演模式）还是狂点（长重复段落） */
  | { type: 'line'; who: string; text: string; label: string | null; mode: 'play' | 'fast' | 'rush' }
  | { type: 'label'; label: string; act: string }
  | { type: 'prompt'; kind: string; choices: string[]; detail?: string }
  | { type: 'choice'; kind: string; chosen: string }
  | { type: 'moment'; seq: number; reason: string; where: string; lines: number; skipped?: { count: number; summary: string } }
  | { type: 'act'; text: string }
  /** 她说的话：start 是开始播的时间，end 是念完（舞台回执）的时间；audio 是另存的 mp3（相对对局日志的路径） */
  | { type: 'say'; text: string; mood: string; voiced: boolean; start: number; end: number; audio?: string }
  /** 别的角色说的话（狼人杀的其他玩家、法官）：seat 为 0 是法官 */
  | { type: 'voice'; seat: number; name: string; text: string; start: number; end: number; audio?: string; tag?: 'inner' | 'wolf' }
  /** 狼人杀牌桌上的一件事（发言、心声、夜里的行动、投票、死讯……） */
  | { type: 'wolf'; entry: WolfEntry };
