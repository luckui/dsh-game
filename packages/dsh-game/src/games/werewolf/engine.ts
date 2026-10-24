/**
 * 狼人杀引擎：跑一局 6~10 人局（身份组合见 rules.ts）。不管界面、不管谁在玩：
 *   - 每个座位一个「大脑」（Brain），轮到它时问它要一个决定（发言、投票、技能）
 *   - 每发生一件事就 emit 一条记录（界面、日志、大肥鱼的时刻都从这里来）
 *   - 发言和法官的话交给 voice 念出来，念完才往下走
 *   - checkpoint：在固定的节点停一下（大肥鱼要不要先看一眼、说两句，由会话决定）
 *   - 大脑没给出决定（模型出错、客户端没回应）就记一条 fault，界面在那个座位上标出来
 *   - 每个决定做完都交给 perform 演一「拍」：谁（seats）对谁（target）做了什么、各自的心声。
 *     怎么演（念不念心声、谁看得到、停多久）由会话按视角决定，演完引擎才往下走
 */

import type { Character } from './characters.js';
import { ROLE_NAMES, cnNumber, rulesText, winnerOf, type Role, type Winner } from './rules.js';

export type DecisionKind = 'wolf_chat' | 'wolf_kill' | 'seer_check' | 'witch' | 'speech' | 'last_words' | 'vote' | 'hunter_shot';

export interface DecisionRequest {
  kind: DecisionKind;
  /** 这一步要做什么（给玩家看） */
  ask: string;
  /** 可以选的座位号 */
  options: number[];
  /** 女巫：今晚被杀的人（没有解药就不告诉）、两瓶药还在不在 */
  witch?: { killed: number | null; canSave: boolean; canPoison: boolean };
}

export interface Decision {
  /** 杀 / 查 / 投 / 开枪 / 毒的座位；null 是不选（弃票、不开枪、不用毒） */
  target?: number | null;
  /** 女巫：用解药 */
  save?: boolean;
  /** 发言、遗言、狼队内部的话 */
  text?: string;
  /** 心声：只有观众能看到 */
  inner?: string;
  /** 这一步没做成（模型出错、客户端没回应、回答看不懂）：写给主人看的原因，引擎记一条 fault */
  fault?: string;
}

/** 一个座位看到的一切（给它做决定） */
export interface SeatView {
  no: number;
  character: Character;
  role: Role;
  /** 规则、身份、私密信息、公开发生的事，整理成文字 */
  text: string;
  /** 狼人：狼队友（座位号 + 名字，死了的注明） */
  mates?: string;
}

export interface Brain {
  decide(view: SeatView, request: DecisionRequest): Promise<Decision>;
}

export interface SeatState {
  no: number;
  id: string;
  name: string;
  color: string;
  role: Role;
  alive: boolean;
  /** 谁在驱动这个座位（界面上显示）：大肥鱼本人、模型名、Codex、Claude Code */
  driver?: string;
  /** 怎么死的 */
  death?: 'night' | 'poison' | 'vote' | 'shot';
}

export type Phase = 'setup' | 'night' | 'day' | 'vote' | 'end';

export interface WolfState {
  phase: Phase;
  day: number;
  seats: SeatState[];
  /** 正在说话的座位（法官说话时是 0） */
  speaking: number | null;
  /** 夜里进行到哪一步：狼人、预言家、女巫睁眼 */
  step: 'wolf' | 'seer' | 'witch' | null;
  /** 上一轮投票：投票人 → 被投的人 */
  votes: Record<number, number | null> | null;
  winner: Winner;
  /** 正在等它做决定的座位 */
  thinking: number[];
  /** 观看视角（会话加上的）：god 上帝视角，fish 大肥鱼视角，player 主人上桌时的主人视角 */
  view?: WolfView;
  /** 主人上桌时坐几号（会话加上的） */
  ownerSeat?: number;
  /** 轮到主人做的事（会话加上的；没轮到是 null） */
  ownerTurn?: OwnerTurn | null;
  /** 主人自己知道的事（身份、狼队友、查验结果、用药……） */
  ownerNotes?: string[];
}

/** 观看视角：上帝视角看全部、念所有人的心声；大肥鱼视角 / 主人视角只看这个座位知道的 */
export type WolfView = 'god' | 'fish' | 'player';

/** 轮到主人做的事：和大肥鱼用同一套动作（speak / kill / check / save / poison / pass / vote / abstain / shoot） */
export interface OwnerTurn {
  kind: DecisionKind;
  ask: string;
  options: number[];
  actions: { action: string; description: string; params?: Record<string, string> }[];
  witch?: DecisionRequest['witch'];
}

/** 一拍演出做的事 */
export type BeatAct = 'wolf_chat' | 'kill' | 'check' | 'save' | 'poison' | 'witch_pass' | 'vote' | 'shoot' | 'speak';

/** 一拍演出：谁对谁做了什么 */
export interface Beat {
  act: BeatAct;
  /** 做这件事的座位（狼人刀人时是所有狼人） */
  seats: number[];
  /** 对谁（null 是没选：弃票、不开枪、不用药） */
  target?: number | null;
  /** 查验结果 */
  result?: 'wolf' | 'good';
  /** 狼队私聊的话 */
  text?: string;
  /** 各自的心声：座位 → 心声 */
  inner: Record<number, string>;
  /** 公开的事（发言、投票、开枪）谁都看得到；其余只有做这件事的人知道 */
  public: boolean;
}

/** 一局里发生的一件事 */
export type WolfEntry =
  | { kind: 'narrator'; text: string }
  | { kind: 'speech'; seat: number; text: string; last?: boolean }
  | { kind: 'wolf_chat'; seat: number; text: string }
  | { kind: 'inner'; seat: number; text: string }
  | { kind: 'action'; seat: number; text: string }
  | { kind: 'vote'; votes: Record<number, number | null>; exiled: number | null }
  | { kind: 'death'; seats: number[]; cause: NonNullable<SeatState['death']> }
  | { kind: 'end'; winner: Exclude<Winner, null> }
  /** 某个座位这一步没做成（引擎按兜底继续：发言变「过」、投票弃权、必选的随机选） */
  | { kind: 'fault'; seat: number; text: string }
  /** 正在等谁做决定变了（局面里的 thinking）：只给界面用，不进记录 */
  | { kind: 'think' }
  /**
   * 一拍演出的一步：inner 是某个座位念心声（seat），act 是动作本身（画特效）。
   * shown 为 false：这个视角看不到（只进记录，界面不演）
   */
  | { kind: 'beat'; stage: 'inner' | 'act'; beat: Beat; seat?: number; shown: boolean };

export interface EngineHooks {
  emit(entry: WolfEntry, state: WolfState): void;
  /** 念出来（seat 为 0 是法官）；念完才返回 */
  voice(seat: number, text: string): Promise<void>;
  /** 固定节点停一下（会话决定要不要真的停） */
  checkpoint(reason: 'night_over' | 'speech' | 'vote' | 'shot' | 'end'): Promise<void>;
  /** 演一拍（会话按视角决定念不念心声、演不演、停多久）；演完才返回 */
  perform(beat: Beat): Promise<void>;
}

const MAX_DAYS = 12;

/** 一个决定里的心声，写成 座位 → 心声 */
const innerOf = (no: number, d: Decision): Record<number, string> => (d.inner?.trim() ? { [no]: d.inner.trim() } : {});

export class WerewolfEngine {
  readonly seats: SeatState[];
  private readonly brains: Brain[];
  private readonly characters: Character[];
  /** 所有人都知道的事 */
  private readonly publicLog: string[] = [];
  /** 每个座位自己知道的事 */
  private readonly notes: string[][];
  /** 这局的规则（按身份组合写） */
  private readonly rules: string;
  private readonly thinking = new Set<number>();
  private phase: Phase = 'setup';
  private day = 0;
  private speaking: number | null = null;
  private step: WolfState['step'] = null;
  private votes: Record<number, number | null> | null = null;
  private winner: Winner = null;
  private antidote = true;
  private poison = true;
  private stopped = false;

  constructor(characters: Character[], roles: Role[], brains: Brain[], private readonly hooks: EngineHooks, drivers: string[] = []) {
    this.characters = characters;
    this.brains = brains;
    this.rules = rulesText(roles);
    this.seats = characters.map((c, i) => ({ no: i + 1, id: c.id, name: c.name, color: c.color, role: roles[i], alive: true, ...(drivers[i] ? { driver: drivers[i] } : {}) }));
    const wolves = this.seats.filter((s) => s.role === 'wolf').map((s) => s.no);
    this.notes = this.seats.map((s) => {
      const own = [`你是 ${s.no} 号 ${s.name}，你的身份是${ROLE_NAMES[s.role]}。`];
      if (s.role === 'wolf') {
        own.push(`你的狼队友是 ${wolves.filter((n) => n !== s.no).map((n) => this.label(n)).join('、')}，你们是同一阵营，他们每出局一个，狼队就少一份力量。`);
        own.push('狼队的常见打法：派一只狼白天悍跳预言家，给好人报「查杀」、给狼队友报「金水」，和真预言家对跳，让好人分不清；队友眼看要被放逐时，跟着投他（倒钩）能换来自己的清白；夜里优先刀神职，尤其是已经跳出来的预言家。');
      }
      return own;
    });
  }

  get state(): WolfState {
    return { phase: this.phase, day: this.day, seats: this.seats.map((s) => ({ ...s })), speaking: this.speaking, step: this.step, votes: this.votes, winner: this.winner, thinking: [...this.thinking] };
  }

  stop(): void {
    this.stopped = true;
  }

  label(no: number): string {
    return `${no} 号 ${this.seats[no - 1].name}`;
  }

  /** 某个座位自己知道的事（身份、狼队友、查验结果、用药……） */
  notesOf(no: number): string[] {
    return [...this.notes[no - 1]];
  }

  /** 给某个座位看的全部信息 */
  view(no: number): SeatView {
    const seat = this.seats[no - 1];
    const alive = this.seats.filter((s) => s.alive).map((s) => this.label(s.no)).join('、');
    const text = [
      '【规则】',
      this.rules,
      '',
      '【你的身份和只有你知道的事】',
      ...this.notes[no - 1],
      '',
      `【现在】第 ${this.day} 天${this.phase === 'night' ? '的夜晚' : '白天'}。活着的人：${alive}。`,
      ...(this.publicLog.length ? [] : ['这是第一夜：还没有任何人发过言、投过票，你对其他玩家只知道座位号和名字，今晚的选择没有依据，凭直觉就好。']),
      '',
      '【所有人都知道的事】',
      ...(this.publicLog.length ? this.publicLog : ['（还没有）']),
    ].join('\n');
    const mates = seat.role === 'wolf'
      ? this.seats.filter((s) => s.role === 'wolf' && s.no !== no).map((s) => `${this.label(s.no)}${s.alive ? '' : '（已出局）'}`).join('、')
      : undefined;
    return { no, character: this.characters[no - 1], role: seat.role, text, ...(mates ? { mates } : {}) };
  }

  private emit(entry: WolfEntry): void {
    this.hooks.emit(entry, this.state);
  }

  private async narrate(text: string): Promise<void> {
    this.speaking = 0;
    this.emit({ kind: 'narrator', text });
    await this.hooks.voice(0, text);
    this.speaking = null;
  }

  private alive(role?: Role): SeatState[] {
    return this.seats.filter((s) => s.alive && (!role || s.role === role));
  }

  private async ask(no: number, request: DecisionRequest): Promise<Decision> {
    let decision: Decision;
    this.thinking.add(no);
    this.emit({ kind: 'think' });
    try {
      decision = await this.brains[no - 1].decide(this.view(no), request);
    } catch (err) {
      decision = { fault: (err as Error).message || '出错了' };
    }
    this.thinking.delete(no);
    this.emit({ kind: 'think' });
    if (decision.fault) this.emit({ kind: 'fault', seat: no, text: decision.fault });
    // 目标不在可选范围里就当没选
    if (decision.target !== undefined && decision.target !== null && !request.options.includes(decision.target)) decision.target = null;
    return decision;
  }

  /** 一局：夜 → 昼 → 夜……直到分出胜负 */
  async run(): Promise<Winner> {
    await this.narrate(`欢迎来到狼人杀。${cnNumber(this.seats.length)}位玩家已经入座，身份牌已经发下，请各自确认自己的身份。`);
    for (this.day = 1; this.day <= MAX_DAYS && !this.stopped; this.day++) {
      const deaths = await this.night();
      if (this.stopped) break;
      await this.dayPhase(deaths);
      if (this.winner || this.stopped) break;
    }
    // 被中途收掉（主人结束这局、换了新局）：没有胜负，不宣布结果
    if (this.stopped && !this.winner) return null;
    const winner = this.winner ?? 'good';
    this.winner = winner;
    this.phase = 'end';
    this.emit({ kind: 'end', winner });
    await this.narrate(winner === 'good' ? '游戏结束，狼人全部出局，好人阵营获胜！' : '游戏结束，狼人阵营获胜！');
    await this.hooks.checkpoint('end');
    return winner;
  }

  private checkWinner(): boolean {
    this.winner = winnerOf(this.seats);
    return this.winner !== null;
  }

  private kill(nos: number[], cause: NonNullable<SeatState['death']>): void {
    const dead = nos.filter((n) => this.seats[n - 1].alive);
    for (const n of dead) {
      this.seats[n - 1].alive = false;
      this.seats[n - 1].death = cause;
    }
    if (dead.length) this.emit({ kind: 'death', seats: dead, cause });
  }

  // ── 夜晚 ──────────────────────────────────────────────

  /** 返回天亮时要公布的死者（被杀、被毒），还没真正出局 */
  private async night(): Promise<{ killed: number | null; poisoned: number | null }> {
    this.phase = 'night';
    this.votes = null;
    await this.narrate(`第 ${this.day} 夜，天黑请闭眼。`);
    const everyone = this.alive().map((s) => s.no);

    // 狼人：先在狼队里各说一句，再一起选刀谁
    this.step = 'wolf';
    await this.narrate('狼人请睁眼，商量今晚要杀谁。');
    const wolves = this.alive('wolf');
    for (const wolf of wolves) {
      const ask = this.publicLog.length
        ? '对狼队友说一句话（只有狼人能听到）：今晚想杀谁、为什么，或者白天打算怎么演。'
        : '对狼队友说一句话（只有狼人能听到）：大家还没开口，可以商量今晚刀谁、白天怎么演、要不要派人悍跳预言家。';
      const d = await this.ask(wolf.no, { kind: 'wolf_chat', ask, options: everyone });
      const text = d.text?.trim();
      if (text) {
        this.emit({ kind: 'wolf_chat', seat: wolf.no, text });
        for (const w of wolves) this.notes[w.no - 1].push(`第 ${this.day} 夜 狼队里，${this.label(wolf.no)} 说：${text}`);
      }
      await this.hooks.perform({ act: 'wolf_chat', seats: [wolf.no], text, inner: innerOf(wolf.no, d), public: false });
    }
    const picks = await Promise.all(wolves.map((w) => this.ask(w.no, { kind: 'wolf_kill', ask: '选今晚要杀的人（填座位号）。', options: everyone })));
    const tally = new Map<number, number>();
    for (const p of picks) if (p.target) tally.set(p.target, (tally.get(p.target) ?? 0) + 1);
    let killed: number | null = null;
    if (tally.size) {
      const max = Math.max(...tally.values());
      // 平票时按座位号最小的狼的选择
      killed = picks.find((p) => p.target && tally.get(p.target) === max)?.target ?? null;
    }
    if (killed) {
      for (const w of wolves) this.notes[w.no - 1].push(`第 ${this.day} 夜，狼队决定杀 ${this.label(killed)}。`);
    }
    if (wolves.length) await this.hooks.perform({ act: 'kill', seats: wolves.map((w) => w.no), target: killed, inner: Object.assign({}, ...wolves.map((w, i) => innerOf(w.no, picks[i]))), public: false });

    // 预言家
    const seer = this.alive('seer')[0];
    this.step = 'seer';
    await this.narrate('预言家请睁眼，你要查验谁？');
    if (seer) {
      const d = await this.ask(seer.no, { kind: 'seer_check', ask: '选一个人查验身份（填座位号）。', options: everyone.filter((n) => n !== seer.no) });
      if (d.target) {
        const isWolf = this.seats[d.target - 1].role === 'wolf';
        this.notes[seer.no - 1].push(`第 ${this.day} 夜你查验了 ${this.label(d.target)}：${isWolf ? '是狼人' : '是好人'}。`);
        await this.hooks.perform({ act: 'check', seats: [seer.no], target: d.target, result: isWolf ? 'wolf' : 'good', inner: innerOf(seer.no, d), public: false });
      }
    } else {
      await this.wait(2500);
    }

    // 女巫
    const witch = this.alive('witch')[0];
    this.step = 'witch';
    await this.narrate('女巫请睁眼。');
    let saved = false;
    let poisoned: number | null = null;
    if (witch && (this.antidote || this.poison)) {
      const canSave = this.antidote && killed !== null && (killed !== witch.no || this.day === 1);
      const d = await this.ask(witch.no, {
        kind: 'witch',
        ask: [
          this.antidote ? (killed ? `今晚被杀的是 ${this.label(killed)}。` : '今晚没有人被杀。') : '你的解药已经用过了，看不到今晚谁被杀。',
          canSave ? '你可以用解药救他。' : '',
          this.poison ? '你可以用毒药毒死一个人（填座位号）。' : '你的毒药已经用过了。',
          '同一晚只能用一瓶药，也可以都不用。',
        ].filter(Boolean).join(''),
        options: this.poison ? everyone.filter((n) => n !== witch.no) : [],
        witch: { killed: this.antidote ? killed : null, canSave, canPoison: this.poison },
      });
      const inner = innerOf(witch.no, d);
      if (d.save && canSave) {
        saved = true;
        this.antidote = false;
        this.notes[witch.no - 1].push(`第 ${this.day} 夜你用解药救了 ${this.label(killed!)}。`);
        await this.hooks.perform({ act: 'save', seats: [witch.no], target: killed, inner, public: false });
      } else if (d.target && this.poison) {
        poisoned = d.target;
        this.poison = false;
        this.notes[witch.no - 1].push(`第 ${this.day} 夜你毒了 ${this.label(d.target)}。`);
        await this.hooks.perform({ act: 'poison', seats: [witch.no], target: d.target, inner, public: false });
      } else {
        this.notes[witch.no - 1].push(`第 ${this.day} 夜你没有用药。`);
        await this.hooks.perform({ act: 'witch_pass', seats: [witch.no], target: null, inner, public: false });
      }
    } else {
      await this.wait(2500);
    }
    this.step = null;
    return { killed: saved ? null : killed, poisoned };
  }

  // ── 白天 ──────────────────────────────────────────────

  private async dayPhase({ killed, poisoned }: { killed: number | null; poisoned: number | null }): Promise<void> {
    this.phase = 'day';
    const dead = [killed, poisoned].filter((n): n is number => n !== null).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
    await this.narrate(`天亮了。${dead.length ? `昨晚，${dead.map((n) => this.label(n)).join('、')} 出局了。` : '昨晚是平安夜，没有人出局。'}`);
    this.publicLog.push(`第 ${this.day} 天天亮：${dead.length ? `${dead.map((n) => this.label(n)).join('、')} 昨晚出局` : '昨晚平安夜，没有人出局'}。`);
    if (killed) this.kill([killed], 'night');
    if (poisoned && poisoned !== killed) this.kill([poisoned], 'poison');
    await this.hooks.checkpoint('night_over');

    // 第一晚死的人留遗言；被狼杀的猎人开枪
    for (const n of dead) {
      if (this.day === 1) await this.lastWords(n);
      if (n === killed && this.seats[n - 1].role === 'hunter') await this.hunterShot(n);
    }
    if (this.checkWinner()) return;

    // 轮流发言：从第一个死者的下一位开始，没死人就从 1 号开始
    const start = dead.length ? dead[0] : 0;
    const order = this.seats.map((_, i) => ((start + i) % this.seats.length) + 1).filter((n) => this.seats[n - 1].alive);
    await this.narrate(`请从 ${this.label(order[0])} 开始，依次发言。`);
    for (const n of order) {
      if (this.stopped) return;
      if (!this.seats[n - 1].alive) continue;
      const d = await this.ask(n, { kind: 'speech', ask: '轮到你发言了（所有人都能听到）。', options: [] });
      await this.hooks.perform({ act: 'speak', seats: [n], inner: innerOf(n, d), public: true });
      await this.say(n, d.text, false);
      await this.hooks.checkpoint('speech');
    }

    // 投票；平票进入 PK：平票的人各再发言一次，其余人只在他们中间重投，再平就没人出局
    this.phase = 'vote';
    await this.narrate('发言结束，请投票。');
    let exiled: number | null = null;
    const first = await this.ballot(this.alive(), null);
    if (first.length === 1) exiled = first[0];
    else if (first.length > 1) {
      const pk = [...first].sort((a, b) => a - b);
      await this.narrate(`${pk.map((n) => this.label(n)).join('、')} 平票，进入 PK。请平票的人依次再发言一次。`);
      this.publicLog.push(`第 ${this.day} 天：${pk.map((n) => this.label(n)).join('、')} 平票，进入 PK。`);
      this.phase = 'day';
      for (const n of pk) {
        if (this.stopped) return;
        const others = pk.filter((m) => m !== n).map((m) => this.label(m)).join('、');
        const d = await this.ask(n, { kind: 'speech', ask: `你和 ${others} 平票，现在是 PK 发言（所有人都能听到）：说服大家别投你。`, options: [] });
        await this.hooks.perform({ act: 'speak', seats: [n], inner: innerOf(n, d), public: true });
        await this.say(n, d.text, false);
        await this.hooks.checkpoint('speech');
      }
      this.phase = 'vote';
      await this.narrate(`PK 发言结束，其余的人在 ${pk.map((n) => `${n} 号`).join('、')} 之间重新投票。`);
      const again = await this.ballot(this.alive().filter((s) => !pk.includes(s.no)), pk);
      if (again.length === 1) exiled = again[0];
    }
    if (this.stopped) return;
    await this.narrate(exiled ? `投票结果：${this.label(exiled)} 得票最多，被放逐。` : first.length ? '还是平票，今天没有人被放逐。' : '没有人投票，今天没有人被放逐。');
    await this.hooks.checkpoint('vote');
    if (exiled) {
      this.kill([exiled], 'vote');
      await this.lastWords(exiled);
      if (this.seats[exiled - 1].role === 'hunter') await this.hunterShot(exiled);
    }
    this.checkWinner();
  }

  /**
   * 一轮投票：voters 投，candidates 是只能投的人（null = 除自己外活着的都能投）。
   * 一张一张揭晓、记进公开记录；返回得票最多的人（一个 = 放逐，几个 = 平票，空 = 都弃票）
   */
  private async ballot(voters: SeatState[], candidates: number[] | null): Promise<number[]> {
    const pk = candidates !== null;
    const ballots = await Promise.all(voters.map((s) => this.ask(s.no, {
      kind: 'vote',
      ask: pk ? `PK 重投：只能在 ${candidates.map((n) => this.label(n)).join('、')} 之间投（填座位号），也可以弃票。` : '投票放逐一个人（填座位号），也可以弃票。',
      options: pk ? candidates : voters.map((v) => v.no).filter((n) => n !== s.no),
    })));
    const votes: Record<number, number | null> = {};
    voters.forEach((s, i) => (votes[s.no] = ballots[i].target ?? null));
    // 一张一张揭晓：先念这个人的心声，再画他投给谁
    for (const [i, s] of voters.entries()) {
      if (this.stopped) return [];
      await this.hooks.perform({ act: 'vote', seats: [s.no], target: votes[s.no], inner: innerOf(s.no, ballots[i]), public: true });
    }
    const count = new Map<number, number>();
    for (const t of Object.values(votes)) if (t) count.set(t, (count.get(t) ?? 0) + 1);
    const max = count.size ? Math.max(...count.values()) : 0;
    const top = [...count.entries()].filter(([, c]) => c === max).map(([n]) => n);
    this.votes = votes;
    this.emit({ kind: 'vote', votes, exiled: top.length === 1 ? top[0] : null });
    const summary = voters.map((s) => `${s.no}→${votes[s.no] ?? '弃'}`).join('，');
    const result = top.length === 1 ? `${this.label(top[0])} 得票最多。` : top.length ? `${top.map((n) => this.label(n)).join('、')} 平票。` : '全部弃票。';
    this.publicLog.push(`第 ${this.day} 天${pk ? ' PK 重投' : '投票'}：${summary}。${result}`);
    return top;
  }

  private async lastWords(no: number): Promise<void> {
    const d = await this.ask(no, { kind: 'last_words', ask: '你出局了，留下遗言（所有人都能听到）。', options: [] });
    await this.hooks.perform({ act: 'speak', seats: [no], inner: innerOf(no, d), public: true });
    await this.say(no, d.text, true);
  }

  private async hunterShot(no: number): Promise<void> {
    const options = this.alive().map((s) => s.no).filter((n) => n !== no);
    const d = await this.ask(no, { kind: 'hunter_shot', ask: '你是猎人，可以开枪带走一个人（填座位号），也可以不开枪。', options });
    await this.hooks.perform({ act: 'shoot', seats: [no], target: d.target ?? null, inner: innerOf(no, d), public: true });
    if (!d.target) return;
    await this.narrate(`${this.label(no)} 亮出猎人身份，开枪带走了 ${this.label(d.target)}。`);
    this.publicLog.push(`第 ${this.day} 天：${this.label(no)} 是猎人，开枪带走了 ${this.label(d.target)}。`);
    this.kill([d.target], 'shot');
    await this.hooks.checkpoint('shot');
  }

  private async say(no: number, text: string | undefined, last: boolean): Promise<void> {
    const words = text?.trim() || '……（过）';
    this.speaking = no;
    this.emit({ kind: 'speech', seat: no, text: words, last });
    this.publicLog.push(`第 ${this.day} 天 ${this.label(no)}${last ? '的遗言' : ' 发言'}：${words}`);
    await this.hooks.voice(no, words);
    this.speaking = null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

