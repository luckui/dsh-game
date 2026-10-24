/**
 * 狼人杀会话（游戏层）：把引擎接到插件上。
 *   - 大肥鱼（DeepSeek）坐其中一个座位：轮到她做决定时交出一个时刻，列出现在能做的事
 *   - 她只看得到她该看到的：公开的发言、投票、法官的话；她是狼时还有狼队的商量；别人的心声和夜里的行动看不到
 *   - 固定节点（天亮、每三段发言、投票后、结束）停一下交给她，她说完心声再继续
 *   - 谁上桌、其余座位由谁驱动（模型 / Codex），按开局设置（setup.ts）来；设置有问题就不开局，把原因交给她
 */

import { formatActions } from '../moment.js';
import type { GameAction, GameActionSpec, GameSession, Moment, PendingPrompt } from '../types.js';
import { LlmBrain, type Complete } from './brains.js';
import { LocalClientBrain } from './local-clients.js';
import { CHARACTERS, OWNER, OWNER_ID, type Character } from './characters.js';
import { WerewolfEngine, type Beat, type Brain, type Decision, type DecisionRequest, type OwnerTurn, type SeatView, type WolfEntry, type WolfState, type WolfView } from './engine.js';
import { ROLE_NAMES, cnNumber, dealRoles, rulesText, type Role } from './rules.js';
import { SELF_ID, driverLabel, driverOf, seated, type SetupCheck } from './setup.js';

export interface WerewolfOptions {
  /** 开局设置和检查结果（谁上桌、每个座位由谁驱动、能不能用） */
  check: () => Promise<SetupCheck>;
  complete: Complete;
  /** 念出来：seat 为 0 是法官；念完才返回。tag：inner 是心声（内心独白效果），wolf 是狼队私聊 */
  voice: (seat: number, character: Character | null, text: string, tag?: 'inner' | 'wolf') => Promise<void>;
  /** 界面：每发生一件事推一次（带当前局面） */
  onEntry?: (entry: WolfEntry, state: WolfState) => void;
  log?: (text: string) => void;
}

/** 大肥鱼的座位：引擎问她要决定时，挂起等她用 game_act 回答 */
class AgentBrain implements Brain {
  pending: { view: SeatView; request: DecisionRequest; resolve: (d: Decision) => void } | null = null;
  constructor(private readonly onAsk: () => void) {}
  decide(view: SeatView, request: DecisionRequest): Promise<Decision> {
    return new Promise((resolve) => {
      this.pending = { view, request, resolve };
      this.onAsk();
    });
  }
}

/** 主人的座位（主人上桌时）：引擎问主人要决定时挂起，等主人在游戏标签页的行动面板里回答 */
/** 开发测试用：下一局主人拿什么身份（只在 DSH_GAME_DEV=1 时由开发路由设置；空是随机） */
export const devOptions: { ownerRole: Role | null } = { ownerRole: null };

class HumanBrain implements Brain {
  pending: { request: DecisionRequest; resolve: (d: Decision) => void } | null = null;
  constructor(private readonly onAsk: () => void) {}
  decide(_view: SeatView, request: DecisionRequest): Promise<Decision> {
    return new Promise((resolve) => {
      this.pending = { request, resolve };
      this.onAsk();
    });
  }
}

/** 一个动作写成一个决定（大肥鱼和主人用同一套动作） */
function toDecision(action: GameAction): Decision {
  return action.action === 'speak' ? { text: action.text!.trim() }
    : action.action === 'save' ? { save: true }
      : action.action === 'abstain' || action.action === 'pass' ? { target: null }
        : { target: Number(action.index) };
}

const KIND_LABEL: Record<DecisionRequest['kind'], string> = {
  wolf_chat: '狼队商量',
  wolf_kill: '狼人杀人',
  seer_check: '预言家查验',
  witch: '女巫用药',
  speech: '发言',
  last_words: '遗言',
  vote: '投票',
  hunter_shot: '猎人开枪',
};

/** 结局时交给她的事实 */
const END_FACT = '这局到这里结束了，后面没有下一步了。';

/** 一拍动作演完后停多久（毫秒）：让特效放完、让主人看清是谁对谁做了什么 */
const BEAT_HOLD: Record<Beat['act'], number> = {
  wolf_chat: 300, kill: 2600, check: 2800, save: 2200, poison: 2400, witch_pass: 1400, vote: 1000, shoot: 2000, speak: 0,
};

/** 每几段别人的发言交给她一次 */
const SPEECHES_PER_MOMENT = 3;

export class WerewolfSession implements GameSession {
  readonly id = 'werewolf';
  readonly title = '狼人杀';
  /** 这局的玩家和身份组合（开局后才有） */
  private roster: Character[] = [];
  private roles: Role[] = [];

  get facts(): string {
    if (!this.roster.length) return '狼人杀：几位 AI 围坐一桌，你是其中一位，主人在旁边看。';
    const n = this.roster.length;
    return [
      `这是一局 ${n} 人狼人杀，玩家是${cnNumber(n)}位 AI：${this.roster.map((c) => (c.id === SELF_ID ? `${c.name}（就是你）` : c.name)).join('、')}，主人在旁边看。`,
      rulesText(this.roles),
      this.ownerSeat
        ? `主人这局也坐在桌上，是 ${this.ownerSeat} 号「主人」，和大家一样拿了身份牌。你在这局里有两种说话：用 game_act 的 speak 在牌桌上发言，所有玩家（包括主人）都能听到；你回复里写的文字是你的心声，这局主人听不到，会记下来，结束后主人能看到。`
        : '你在这局里有两种说话：用 game_act 的 speak 在牌桌上发言，所有玩家都能听到；你回复里写的文字是你的心声（会被念出来），只有主人和观众听得到，牌桌上的其他玩家听不到。',
      '轮到你做事时，时刻里会列出你现在能做的事；没轮到你时，game_continue 会把牌桌上刚发生的事交给你。',
    ].join('\n');
  }

  private engine: WerewolfEngine | null = null;
  private agent: AgentBrain;
  private human: HumanBrain;
  private mySeat = 0;
  /** 主人坐几号（没上桌是 0） */
  private ownerSeat = 0;
  /** 交给她之前攒下的事（她看得到的） */
  private lines: string[] = [];
  private notesSeen = 0;
  private speechesSinceMoment = 0;
  private momentSeq = 0;
  private readyReason: string | null = null;
  private waiter: ((reason: string) => void) | null = null;
  /** 引擎停在节点上等她继续 */
  private holding: (() => void) | null = null;
  private shownRequest: DecisionRequest | null = null;
  private ended = false;
  /** 下一个时刻要交给她的事实（结局时的收尾说明） */
  private readonly endFacts: string[] = [];
  private pauseGate: Promise<void> | null = null;
  /** 观看视角（主人在牌桌上切换，下一拍起生效） */
  private view: WolfView = 'god';
  private unpause: (() => void) | null = null;
  /** 最近的记录（界面刷新后补上） */
  readonly history: WolfEntry[] = [];

  constructor(private readonly options: WerewolfOptions) {
    this.agent = new AgentBrain(() => this.ready('turn'));
    // 轮到主人：推一次局面，行动面板就出来了
    this.human = new HumanBrain(() => this.pushState());
  }

  get finished(): boolean {
    return this.ended;
  }

  get started(): boolean {
    return this.engine !== null;
  }

  get state(): WolfState | null {
    return this.engine ? this.decorate(this.engine.state) : null;
  }

  /** 引擎的局面加上会话的东西：视角、主人的座位、轮到主人做的事、主人知道的事 */
  private decorate(state: WolfState): WolfState {
    if (!this.ownerSeat) return { ...state, view: this.view };
    const pending = this.human.pending;
    const ownerTurn: OwnerTurn | null = pending
      ? { kind: pending.request.kind, ask: pending.request.ask, options: pending.request.options, actions: this.actionsOf(pending.request), ...(pending.request.witch ? { witch: pending.request.witch } : {}) }
      : null;
    return { ...state, thinking: this.thinkingSeenByOwner(state), view: this.view, ownerSeat: this.ownerSeat, ownerTurn, ownerNotes: this.engine?.notesOf(this.ownerSeat) ?? [] };
  }

  /** 夜里谁在想就是谁的身份：主人只看得到自己，是狼人时再加狼人回合的狼队友；白天发言、投票是公开的 */
  private thinkingSeenByOwner(state: WolfState): number[] {
    if (state.phase !== 'night') return state.thinking;
    const ownerIsWolf = state.seats[this.ownerSeat - 1]?.role === 'wolf';
    return state.thinking.filter((n) => n === this.ownerSeat || (ownerIsWolf && state.step === 'wolf' && state.seats[n - 1]?.role === 'wolf'));
  }

  private pushState(): void {
    if (this.engine) this.options.onEntry?.({ kind: 'think' }, this.decorate(this.engine.state));
  }

  /** 切换视角：推一次局面让界面跟着变（主人上桌时固定是主人视角） */
  setView(view: WolfView): void {
    if (this.ownerSeat) return;
    this.view = view;
    this.pushState();
  }

  /** 主人在行动面板里做了一件事：和大肥鱼的 game_act 用同一套检查 */
  ownerAct(action: GameAction): string | null {
    const pending = this.human.pending;
    if (!pending) return '现在还没轮到你。';
    const refusal = this.checkAction(pending.request, action);
    if (refusal) return refusal.replace('（用 game_act）', '');
    this.human.pending = null;
    pending.resolve(toDecision(action));
    this.pushState();
    return null;
  }

  /** 主人上桌时，她的心声这局主人听不到（不念、不显示），记下来，结束后能看到 */
  mutesHer(): boolean {
    return this.ownerSeat > 0 && !this.ended;
  }

  noteHerWords(text: string): void {
    if (this.engine && this.mySeat) this.onEntry({ kind: 'inner', seat: this.mySeat, text }, this.engine.state);
  }

  async start(): Promise<string> {
    if (this.engine) return this.ended ? '这局已经结束了。' : '游戏已经在进行了。';
    // 开局设置有问题（模型没配、Codex 没登录、人数不对）：不开局，原因交给她转告主人
    const check = await this.options.check();
    if (check.problem) return `这局开不了：${check.problem}。要主人在游戏库「狼人杀」的开局设置里改好，再开局。`;
    // 随机排座位、发身份
    const ids = seated(check.setup);
    const characters = [...CHARACTERS, OWNER].filter((c) => ids.includes(c.id)).sort(() => Math.random() - 0.5);
    const roles = dealRoles(characters.length);
    this.roster = characters;
    this.roles = roles;
    this.mySeat = characters.findIndex((c) => c.id === SELF_ID) + 1;
    this.ownerSeat = characters.findIndex((c) => c.id === OWNER_ID) + 1;
    // 开发测试：把指定的身份和主人的身份对调
    const want = devOptions.ownerRole;
    if (want && this.ownerSeat && roles.includes(want)) {
      const j = roles.indexOf(want);
      [roles[j], roles[this.ownerSeat - 1]] = [roles[this.ownerSeat - 1], roles[j]];
    }
    // 主人上桌：用主人视角（只看主人知道的事），不能切
    if (this.ownerSeat) this.view = 'player';
    const log = (t: string) => this.log(t);
    const brains: Brain[] = characters.map((c) => {
      if (c.id === SELF_ID) return this.agent;
      if (c.id === OWNER_ID) return this.human;
      const how = driverOf(check.setup, c.id);
      if (how === 'codex' || how === 'claude-code') return new LocalClientBrain(how, log);
      return new LlmBrain(this.options.complete, () => how);
    });
    const drivers = characters.map((c) => (c.id === SELF_ID ? '大肥鱼本人' : c.id === OWNER_ID ? '你' : driverLabel(driverOf(check.setup, c.id))));
    this.engine = new WerewolfEngine(characters, roles, brains, {
      emit: (entry, state) => this.onEntry(entry, state),
      // 主人按了停止：下一句话之前停住，等她回来
      voice: async (seat, text) => {
        await this.pauseGate;
        return this.options.voice(seat, seat ? characters[seat - 1] : null, text);
      },
      checkpoint: (reason) => this.checkpoint(reason),
      perform: (beat) => this.perform(beat, characters),
    }, drivers);
    this.log(`开局：${characters.map((c, i) => `${i + 1}${c.name}(${ROLE_NAMES[roles[i]]})`).join(' ')}`);
    void this.engine.run().catch((err) => this.log(`引擎出错：${(err as Error).message}`));
    return `入座完毕，你坐 ${this.mySeat} 号。用 game_continue 开始。`;
  }

  private log(text: string): void {
    (this.options.log ?? ((t: string) => console.info(`[dsh-game/werewolf] ${t}`)))(text);
  }

  // ── 引擎来的事 ─────────────────────────────────────────

  /**
   * 演一拍。这个视角看得到的才演：
   *   - 上帝视角：所有事都演；先逐个念心声（各自的声音 + 内心独白效果），再演动作
   *   - 大肥鱼视角：公开的事（发言、投票、开枪）和她参与的事才演；她是狼时狼队私聊也演；别人的心声不念
   * 她自己的心声不从这里来（她写的文字由游戏工具念），这里跳过她的座位
   */
  private async perform(beat: Beat, characters: Character[]): Promise<void> {
    const god = this.view === 'god';
    // 这个视角是谁的座位：大肥鱼视角是她，主人视角是主人
    const viewer = this.view === 'player' ? this.ownerSeat : this.mySeat;
    const mine = beat.seats.includes(viewer);
    const viewerIsWolf = this.engine?.seats[viewer - 1]?.role === 'wolf';
    const shown = god || beat.public || mine || (beat.act === 'wolf_chat' && viewerIsWolf);
    if (!shown) {
      this.onEntry({ kind: 'beat', stage: 'act', beat, shown: false }, this.engine!.state);
      return;
    }
    if (god) {
      for (const seat of beat.seats) {
        const inner = beat.inner[seat];
        if (!inner || seat === this.mySeat) continue;
        this.onEntry({ kind: 'beat', stage: 'inner', beat, seat, shown: true }, this.engine!.state);
        await this.pauseGate;
        await this.options.voice(seat, characters[seat - 1], inner, 'inner');
      }
    }
    if (beat.act === 'speak') return;
    this.onEntry({ kind: 'beat', stage: 'act', beat, shown: true }, this.engine!.state);
    await this.pauseGate;
    // 狼队私聊：用他自己的声音念出来（她不是狼时只有上帝视角听得到）
    if (beat.act === 'wolf_chat' && beat.text && beat.seats[0] !== this.mySeat) await this.options.voice(beat.seats[0], characters[beat.seats[0] - 1], beat.text, 'wolf');
    await new Promise((resolve) => setTimeout(resolve, BEAT_HOLD[beat.act]));
  }

  private onEntry(entry: WolfEntry, state: WolfState): void {
    this.options.onEntry?.(entry, this.decorate(state));
    // 「谁在想」只是局面变了，不算一件事
    if (entry.kind === 'think') return;
    this.history.push(entry);
    if (this.history.length > 400) this.history.shift();
    const line = this.visibleLine(entry, state);
    if (line) this.lines.push(line);
    if (entry.kind === 'speech' && entry.seat !== this.mySeat) this.speechesSinceMoment++;
    if (entry.kind === 'end') this.ended = true;
  }

  /** 这件事她看不看得到、写成什么样 */
  private visibleLine(entry: WolfEntry, state: WolfState): string | null {
    const name = (n: number) => `${n} 号 ${state.seats[n - 1]?.name ?? ''}`;
    const iAmWolf = state.seats[this.mySeat - 1]?.role === 'wolf';
    switch (entry.kind) {
      case 'narrator':
        return `法官：${entry.text}`;
      case 'speech':
        return entry.seat === this.mySeat ? null : `${name(entry.seat)}${entry.last ? '（遗言）' : ''}：${entry.text}`;
      case 'wolf_chat':
        return iAmWolf && entry.seat !== this.mySeat ? `（狼队）${name(entry.seat)}：${entry.text}` : null;
      case 'vote':
        return `投票：${Object.entries(entry.votes).map(([v, t]) => `${v}→${t ?? '弃'}`).join('，')}`;
      case 'end': {
        const roles = state.seats.map((s) => `${s.no} 号 ${s.name}：${ROLE_NAMES[s.role]}`).join('；');
        return `游戏结束，${entry.winner === 'good' ? '好人' : '狼人'}阵营获胜。所有人的身份：${roles}`;
      }
      default:
        return null;
    }
  }

  /** 固定节点：要不要停下来交给她 */
  private checkpoint(reason: 'night_over' | 'speech' | 'vote' | 'shot' | 'end'): Promise<void> {
    if (reason === 'speech' && this.speechesSinceMoment < SPEECHES_PER_MOMENT) return Promise.resolve();
    if (reason === 'end') this.endFacts.push(END_FACT);
    return new Promise((resolve) => {
      this.holding = resolve;
      this.ready(reason);
    });
  }

  private ready(reason: string): void {
    if (!this.readyReason || reason === 'turn') this.readyReason = reason;
    this.waiter?.(this.readyReason);
  }

  // ── 她这边 ────────────────────────────────────────────

  /** 主人按了停止：牌桌停在下一句话之前（引擎念话前等这道门），她回来（game_continue / game_act）时打开 */
  pause(): void {
    if (!this.pauseGate) this.pauseGate = new Promise((resolve) => { this.unpause = resolve; });
  }

  private resume(): void {
    this.unpause?.();
    this.unpause = null;
    this.pauseGate = null;
  }

  async wait(signal: AbortSignal, maxMs: number): Promise<Moment> {
    this.resume();
    if (!this.engine) return this.takeMoment('disconnected', ['游戏还没开始：先调用 game_start。']);
    // 已经结束、也交过结局了：牌桌上不会再有新的事
    if (this.ended && !this.holding && !this.readyReason) return this.takeMoment('end', ['这局已经结束了，牌桌上不会再有新的事。']);
    // 轮到她了还没回答：直接再交一次
    if (this.agent.pending && this.shownRequest === this.agent.pending.request && !this.readyReason) return this.takeMoment('turn');
    // 她回来了：停在节点上的引擎继续
    const hold = this.holding;
    this.holding = null;
    hold?.();
    if (!this.readyReason) {
      const reason = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => finish('timeout'), maxMs);
        const onAbort = () => finish('timeout');
        const finish = (r: string) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.waiter = null;
          resolve(r);
        };
        this.waiter = finish;
        signal.addEventListener('abort', onAbort, { once: true });
      });
      if (!this.readyReason) this.readyReason = reason;
    }
    return this.takeMoment(this.readyReason ?? 'timeout');
  }

  private takeMoment(reason: string, extraNotes: string[] = []): Moment {
    const state = this.engine?.state;
    const notes = [...this.endFacts.splice(0), ...extraNotes];
    // 她自己知道的事（身份、查验结果、用药……）：新出现的交给她
    if (this.engine) {
      const mine = this.engine.notesOf(this.mySeat);
      // 狼队里的话已经在「发生的事」里了
      notes.push(...mine.slice(this.notesSeen).filter((n) => !n.includes(' 狼队里，')));
      this.notesSeen = mine.length;
    }
    const pending = this.agent.pending;
    const prompt: PendingPrompt | undefined = pending ? this.promptOf(pending.request) : undefined;
    const me = state?.seats[this.mySeat - 1];
    const moment: Moment = {
      seq: ++this.momentSeq,
      reason,
      where: state ? `第 ${state.day} 天${state.phase === 'night' ? '夜晚' : state.phase === 'end' ? '（已结束）' : '白天'}，你是 ${this.mySeat} 号${me && !me.alive ? '（你已经出局，现在是旁观）' : ''}` : '还没开始',
      lines: this.lines,
      onStage: state ? state.seats.filter((s) => s.alive).map((s) => `${s.no} 号 ${s.name}`) : [],
      notes,
      ...(prompt ? { prompt } : {}),
      actions: pending ? this.actionsOf(pending.request) : [],
    };
    if (pending) this.shownRequest = pending.request;
    this.lines = [];
    this.speechesSinceMoment = 0;
    this.readyReason = null;
    return moment;
  }

  private seatList(options: number[]): string {
    const state = this.engine?.state;
    return options.map((n) => `${n} 号 ${state?.seats[n - 1]?.name ?? ''}`).join('、');
  }

  private promptOf(request: DecisionRequest): PendingPrompt {
    const detail = [request.ask, request.options.length ? `可以选：${this.seatList(request.options)}。` : ''].filter(Boolean).join('\n');
    return { id: `${request.kind}-${this.momentSeq}`, kind: request.kind, label: KIND_LABEL[request.kind], choices: [], detail };
  }

  private actionsOf(request: DecisionRequest): GameActionSpec[] {
    const seatParam = { index: '座位号' };
    switch (request.kind) {
      case 'speech':
        return [{ action: 'speak', description: '在牌桌上发言（所有玩家都能听到）', params: { text: '发言内容（40 到 90 字）' } }];
      case 'last_words':
        return [{ action: 'speak', description: '留下遗言（所有玩家都能听到）', params: { text: '遗言（40 到 80 字）' } }];
      case 'wolf_chat':
        return [{ action: 'speak', description: '对狼队友说话（只有狼人能听到）', params: { text: '要说的话（40 字以内）' } }];
      case 'wolf_kill':
        return [{ action: 'kill', description: '选今晚要杀的人', params: seatParam }];
      case 'seer_check':
        return [{ action: 'check', description: '查验一个人是不是狼人', params: seatParam }];
      case 'witch': {
        const w = request.witch;
        return [
          ...(w?.canSave ? [{ action: 'save', description: `用解药救今晚被杀的 ${w.killed} 号` }] : []),
          ...(w?.canPoison ? [{ action: 'poison', description: '用毒药毒死一个人', params: seatParam }] : []),
          { action: 'pass', description: '今晚不用药' },
        ];
      }
      case 'vote':
        return [
          { action: 'vote', description: '投票放逐一个人', params: seatParam },
          { action: 'abstain', description: '弃票' },
        ];
      case 'hunter_shot':
        return [
          { action: 'shoot', description: '开枪带走一个人', params: seatParam },
          { action: 'pass', description: '不开枪' },
        ];
    }
  }

  /** 这件事现在做不了的原因；做得了是 null */
  refuse(action: GameAction): string | null {
    const pending = this.agent.pending;
    if (!pending) return this.ended ? '游戏已经结束了。' : '现在还没轮到你：用 game_continue 看看牌桌上发生了什么。';
    if (pending.request !== this.shownRequest) return '轮到你做一件新的事了，你还没看到：用 game_continue 看看。';
    return this.checkAction(pending.request, action);
  }

  /** 这件事合不合这一步的规矩（大肥鱼和主人共用） */
  private checkAction(request: DecisionRequest, action: GameAction): string | null {
    const allowed = this.actionsOf(request).map((a) => a.action);
    if (!allowed.includes(action.action)) return `现在不能做这件事。\n\n${formatActions(this.actionsOf(request))}`;
    const needsSeat = ['kill', 'check', 'poison', 'vote', 'shoot'].includes(action.action);
    if (needsSeat && !request.options.includes(Number(action.index))) return `座位号要在这些里面：${this.seatList(request.options)}。`;
    if (action.action === 'speak' && !action.text?.trim()) return '要说的话（text）不能是空的。';
    return null;
  }

  async act(action: GameAction): Promise<string> {
    this.resume();
    const refusal = this.refuse(action);
    if (refusal) return refusal;
    const pending = this.agent.pending!;
    const decision = toDecision(action);
    this.agent.pending = null;
    this.shownRequest = null;
    pending.resolve(decision);
    const who = (n: number) => `${n} 号 ${this.engine?.state.seats[n - 1]?.name ?? ''}`;
    switch (action.action) {
      case 'speak': return '你说完了。用 game_continue 继续。';
      case 'kill': return `你选了杀 ${who(Number(action.index))}。用 game_continue 继续。`;
      case 'check': return `你查验了 ${who(Number(action.index))}，结果会在下一个时刻告诉你。用 game_continue 继续。`;
      case 'save': return '你用解药救了他。用 game_continue 继续。';
      case 'poison': return `你毒了 ${who(Number(action.index))}。用 game_continue 继续。`;
      case 'vote': return `你投给了 ${who(Number(action.index))}。用 game_continue 继续。`;
      case 'shoot': return `你开枪带走了 ${who(Number(action.index))}。用 game_continue 继续。`;
      default: return '好的。用 game_continue 继续。';
    }
  }

  nudge(): void {
    // 主人说话了：她正在等就马上交出时刻；刚好不在等（两次 game_continue 之间）就先记下，下次一来等就返回
    this.ready('owner');
  }

  async stop(): Promise<void> {
    this.resume();
    this.engine?.stop();
    this.waiter?.('disconnected');
    this.holding?.();
    this.agent.pending?.resolve({});
    this.human.pending?.resolve({});
    this.human.pending = null;
  }
}
