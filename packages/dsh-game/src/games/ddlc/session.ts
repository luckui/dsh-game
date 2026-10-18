/**
 * DDLC 会话：把游戏事件攒成「时刻」交给 agent（game_continue），把 agent 的回答发回游戏（game_act）。
 *
 * 什么时候结束一个时刻（交给她）：
 *   - 游戏在等回答：选项 / 写诗挑词 / 弹窗 / 读诗          → 立刻
 *   - 新 CG 第一次出现：等它后面第一句台词出来再截图        → 截完立刻
 *   - 打码场景第一次出现                                  → 立刻（只给中性描述，不截图）
 *   - 第三幕 Monika 直接对玩家说话                        → 每 4 句
 *   - 换场景（Ren'Py 的 scene：换地点 / 换时间），上一场有 4 句以上 → 立刻（一场戏交一次）
 *   - 新的一天开始、且上一天还有没给她看的剧情              → 立刻
 *   - 兜底：一场戏太长，攒够 30 句；或者有 3 句以上、游戏已经走了 3 分钟
 * 时刻准备好时游戏暂停（hold），她再调 game_continue 时才继续（release）。
 *
 * 导演模式（options.director）：日常段落快进（Ren'Py 跳过），台词照收但不按场景交给她；
 * 下一次交给她时（选项、新 CG、进入放慢段落），先把快进的内容压成摘要放在最前面。
 * 哪些段落快进由 profile.isFastLabel 决定；开场前 INTRO_LINES 句总是放慢。
 */

import path from 'node:path';
import { RenpyBridge, type RenpyEvent, type RenpyPrompt } from '../renpy/bridge.js';
import type { GameAction, GameActionSpec, GameSession, Moment, PendingPrompt, RunEvent } from '../types.js';
import { formatActions, formatPrompt } from '../moment.js';
import * as ddlc from './profile.js';

export const RULES = {
  /** 换场景时，上一场至少有这么多句才交给她（太短的过场并到下一场） */
  sceneMinLines: 4,
  storyLines: 30,
  storyMinLines: 3,
  storyGapMs: 180_000,
  monikaLines: 4,
  /** 到主菜单后等多久截图交给她（主菜单的动画画完） */
  menuShotDelayMs: 1500,
  /** CG 后第一句台词出现后等多久截图（台词框显示好） */
  cgShotDelayMs: 300,
  maxLines: 60,
  /** 写诗挑完一个词后，等下一轮的词最多多久 */
  poemNextMs: 3000,
  /** 快进时最多攒多少句给摘要（太早的丢掉） */
  maxFastLines: 600,
  lineMaxChars: 240,
} as const;

/** Ren'Py 文本标签（{w} {i} {cps=…}）去掉 */
function plain(text: string): string {
  return text.replace(/\{[^{}]*\}/g, '').replace(/\s+/g, ' ').trim();
}

/** DDLC 的提示：选项、写诗挑词、弹窗、读诗，以及插件自己出的主菜单和起名字 */
interface DdlcPrompt extends PendingPrompt {
  kind: 'menu' | 'poem_word' | 'dialog' | 'poem_read' | 'main_menu' | 'name';
  /** 写诗挑词：每个词给每个角色加多少分（和 choices 一一对应），「一步写完」用 */
  points?: Record<string, number>[];
}

export interface DdlcSessionOptions {
  /** mod 和打码卡片所在目录（插件包里的 games/） */
  assetsDir: string;
  /** 插件设置里填的游戏目录；空的话自动找 */
  gameDir?: string;
  /** 是否装打码卡片（直播 / 视频建议开） */
  censor: boolean;
  /** 导演模式：日常快进，关键段落放慢 */
  director: boolean;
  /** 把快进过去的台词压成几句中文摘要；不提供就只给最后几句 */
  summarize?: (lines: string[], instruction: string) => Promise<string>;
  /** 她在游戏里做了一件事（给界面显示用的一句话） */
  onAction?: (text: string) => void;
  /** 游戏推来一帧画面（JPEG） */
  onFrame?: (jpeg: Buffer) => void;
  /** 写对局日志（给剪辑用，见 runtime.ts 的 RunEvent） */
  record?: (event: RunEvent) => void;
  log?: (text: string) => void;
}

export class DdlcSession implements GameSession {
  readonly id = 'ddlc';
  readonly title = '心跳文学部（Doki Doki Literature Club）';
  readonly facts = ddlc.FACTS;

  private bridge: RenpyBridge | null = null;
  private gameDir = '';

  /** 主角名字（游戏的全局存档里有就用它；没有就等她开新游戏时起） */
  private playerName = '';
  private playthrough: number | null = null;
  private label: string | null = null;
  private atMainMenu = false;
  private menuTimer: NodeJS.Timeout | null = null;
  /** 插件自己出的提示（主菜单、起名字）的编号 */
  private localPromptSeq = 0;
  /** 游戏连上时报告的插件存档：第一次到主菜单时读它，而不是开新游戏 */
  private resume: { label: string } | null = null;
  private streamFps = 0;
  /** 收到的最后一句台词的编号：交出时刻时告诉 mod（ack），mod 删掉留底 */
  private lastLineSeq = 0;

  private lines: string[] = [];
  private notes: string[] = [];
  private readonly onStage = new Set<string>();
  private readonly seen = new Set<string>();
  private pendingCg: string | null = null;
  private image: Moment['image'];
  private prompt: DdlcPrompt | null = null;
  /** 最近一次交给她看过的提示：她只能回答看过的提示，游戏自己走到了新提示时不会被旧回答误答 */
  private shownPromptId: string | null = null;
  private monikaLines = 0;
  private resumedAt = Date.now();

  /** 准备好但还没交给她的时刻原因 */
  private readyReason: Moment['reason'] | null = null;
  private waiter: ((reason: Moment['reason']) => void) | null = null;
  private held = false;
  private gapTimer: NodeJS.Timeout | null = null;
  private momentSeq = 0;
  private act3Told = false;
  private endTold = false;
  /** 这首诗挑过的词 */
  private poemWords: string[] = [];

  // 导演模式
  private fast = false;
  /** 正在狂点段里（见 ddlc.isRushLabel） */
  private rushing = false;
  private fastLines: string[] = [];
  private introLeft = ddlc.INTRO_LINES;
  private skipped: { count: number; summary: string } | null = null;
  private summarizing: Promise<void> | null = null;

  constructor(private readonly options: DdlcSessionOptions) {}

  async start(): Promise<string> {
    if (this.bridge) return this.bridge.connected ? '游戏已经在运行了。' : '正在等游戏连上来。';
    const dir = ddlc.findDdlcDir(this.options.gameDir);
    if (!dir) {
      return '没找到《心跳文学部》。请主人先在 Steam 安装 Doki Doki Literature Club（免费）；装在别处的话，在侧栏「插件」→ dsh-game 的设置里填游戏目录。';
    }
    this.gameDir = dir;
    const bridge = new RenpyBridge({
      gameDir: dir,
      exe: ddlc.DDLC_EXE,
      modDir: path.join(this.options.assetsDir, 'renpy'),
      env: ddlc.PLAYER_ENV,
    });
    bridge.on('event', (event: RenpyEvent) => this.onEvent(event));
    bridge.on('connected', () => {
      this.log('游戏连上了');
      if (this.streamFps) bridge.send({ type: 'stream', fps: this.streamFps });
    });
    bridge.on('frame', (jpeg: Buffer) => this.options.onFrame?.(jpeg));
    bridge.on('disconnected', () => this.ready('disconnected'));
    bridge.install(ddlc.MOD_CONFIG, ddlc.installFiles(path.join(this.options.assetsDir, 'ddlc'), this.options.censor));
    await bridge.listen();
    this.bridge = bridge;
    // 游戏可能已经开着（mod 每 2 秒重连一次）：等一下，没连上才启动
    await new Promise((r) => setTimeout(r, 3000));
    bridge.launch();
    this.gapTimer = setInterval(() => this.checkStoryGap(), 1000);
    return `游戏已经打开（${dir}）。到了主菜单会交给你选。`;
  }

  nudge(): void {
    // 把这个时刻提前交出去（游戏停住），DSH 才能在下一步把主人的话交给她。
    // 她这时不一定正在等（可能刚好在两次 game_continue 之间）：先记下，她下次一来等就马上返回
    this.ready('owner');
  }

  dev(command: { jump?: string; show?: string }): boolean {
    if (command.jump) return this.bridge?.send({ type: 'dev_jump', label: command.jump }) ?? false;
    if (command.show) return this.bridge?.send({ type: 'dev_show', name: command.show }) ?? false;
    return false;
  }

  setStream(fps: number): void {
    this.streamFps = fps;
    this.bridge?.send({ type: 'stream', fps });
  }

  async stop(): Promise<void> {
    if (this.menuTimer) clearTimeout(this.menuTimer);
    if (this.gapTimer) clearInterval(this.gapTimer);
    this.waiter?.('disconnected');
    const bridge = this.bridge;
    this.bridge = null;
    if (!bridge) return;
    bridge.send({ type: 'release' });
    // 游戏窗口还开着时连接不一定马上断干净：最多等 3 秒，mod 照样卸掉
    await Promise.race([bridge.close(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    try {
      bridge.uninstall();
    } catch (err) {
      this.log(`卸载 mod 没完全成功（游戏可能还开着）：${(err as Error).message}`);
    }
  }

  async wait(signal: AbortSignal, maxMs: number): Promise<Moment> {
    if (!this.bridge) {
      return this.takeMoment('disconnected', ['游戏还没打开：先调用 game_start。']);
    }
    // 游戏正停在提示上、她还没回答：直接把提示再交给她
    if (this.prompt && !this.readyReason) return this.takeMoment('prompt');
    this.log('她在等下一个时刻' + (this.readyReason ? '（已经有：' + this.readyReason + '）' : '') + (this.prompt ? '（提示：' + this.prompt.kind + '）' : ''));
    // 她回来等了：游戏继续
    this.release();
    if (!this.readyReason) {
      let aborted = false;
      const reason = await new Promise<Moment['reason']>((resolve) => {
        const timer = setTimeout(() => finish('timeout'), maxMs);
        const onAbort = () => { aborted = true; finish('timeout'); };
        const finish = (r: Moment['reason']) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.waiter = null;
          resolve(r);
        };
        this.waiter = finish;
        signal.addEventListener('abort', onAbort, { once: true });
      });
      if (aborted) {
        // 主人按了停止（或这一轮被打断）：游戏马上停住；攒下的剧情留着，她下次继续时一起交给她
        this.hold();
        return { seq: this.momentSeq, reason: 'timeout', where: '', lines: [], onStage: [], notes: [] };
      }
      if (!this.readyReason) this.readyReason = reason;
    }
    if (this.summarizing) await this.summarizing;
    return this.takeMoment(this.readyReason ?? 'timeout');
  }

  async act(action: GameAction): Promise<string> {
    if (action.action === 'delete_character') {
      if (!this.gameDir) return '游戏还没打开。';
      const result = await ddlc.deleteCharacter(this.gameDir, action.name ?? '', (text) => this.log(text));
      if (result.startsWith('已删除')) this.options.onAction?.(result);
      return result;
    }
    const prompt = this.prompt;
    if (!prompt) return '现在游戏没有在等你回答。';
    if (prompt.id !== this.shownPromptId) return '游戏已经走到了一个新的提示，你还没看到：用 game_continue 看看。';
    if (action.action === 'write_for') return this.writeFor(prompt, action.name ?? '');
    if (action.action === 'enter_name') return this.enterName(action.name ?? '');
    if (action.action !== 'choose') return `没有这件事：action=${action.action}。\n\n${formatActions(this.actionsNow())}`;
    if (prompt.kind === 'name') return `现在要给主角起名字。\n\n${formatActions(this.actionsNow())}`;
    const index = Number(action.index);
    if (!Number.isInteger(index) || index < 1 || index > prompt.choices.length) {
      return `序号要在 1 到 ${prompt.choices.length} 之间。`;
    }
    this.prompt = null;
    const chosen = prompt.choices[index - 1];
    this.options.record?.({ type: 'choice', kind: prompt.kind, chosen });
    // 主菜单是插件自己出的提示（游戏里没有对应的提示），选了由插件去点
    if (prompt.kind === 'main_menu') return this.chooseMainMenu(chosen);
    this.bridge?.send({ type: 'answer', id: prompt.id, index: index - 1 });
    this.resumedAt = Date.now();
    if (prompt.kind === 'poem_word') return this.nextPoemWord(chosen);
    if (prompt.kind === 'poem_read') this.options.onAction?.(`读了${prompt.detail?.split('\n')[0] ?? '一首诗'}`);
    else if (prompt.kind === 'menu') this.options.onAction?.(`选了「${chosen}」`);
    return `已选择「${chosen}」。`;
  }

  /**
   * 写诗连续挑词：挑完一个词，直接把下一轮的词交给她（不再算一个「时刻」），
   * 20 个词挑完告诉她这首诗写完了。
   */
  private async nextPoemWord(chosen: string): Promise<string> {
    this.poemWords.push(chosen);
    const next = await this.nextPoemRound();
    if (next) {
      return [
        `已选「${chosen}」。已经挑了 ${this.poemWords.length} 个：${this.poemWords.join(', ')}`,
        `【写诗挑词】${next.detail ?? ''}`,
        ...next.choices.map((c, i) => `${i + 1}. ${c}`),
        '继续用 game_act 挑（choose + 序号）。',
      ].join('\n');
    }
    const words = this.takePoemWords();
    this.options.onAction?.(`自己挑词写了一首诗：${words.slice(0, 3).join(', ')}…`);
    return `已选「${chosen}」。这首诗写完了，你挑的 ${words.length} 个词：${words.join(', ')}。用 game_continue 继续。`;
  }

  /** 一步写完：每一轮挑最合这个人口味的词（同分随机），直到这首诗写完 */
  private async writeFor(first: DdlcPrompt, name: string): Promise<string> {
    const who = name.trim().toLowerCase();
    if (first.kind !== 'poem_word' || !first.points?.length) return '现在不是在写诗。';
    if (!(who in first.points[0])) return `write_for 的 name 可以是：${Object.keys(first.points[0]).join(' / ')}`;
    let prompt: DdlcPrompt | null = first;
    while (prompt?.kind === 'poem_word' && prompt.points?.length) {
      const scores = prompt.points.map((p) => p[who] ?? 0);
      const best = Math.max(...scores);
      const ties = scores.flatMap((v, i) => (v === best ? [i] : []));
      const index = ties[Math.floor(Math.random() * ties.length)];
      this.prompt = null;
      this.bridge?.send({ type: 'answer', id: prompt.id, index });
      this.resumedAt = Date.now();
      this.poemWords.push(prompt.choices[index]);
      prompt = await this.nextPoemRound();
    }
    const words = this.takePoemWords();
    this.options.onAction?.(`为 ${characterName(who)} 写了一首诗`);
    return `按 ${characterName(who)} 的口味写完了这首诗，挑的 ${words.length} 个词：${words.join(', ')}。用 game_continue 继续。`;
  }

  /** 等下一轮挑词（最多 poemNextMs）：到了就直接交给她，不再算一个「时刻」；诗写完了返回 null */
  private async nextPoemRound(): Promise<DdlcPrompt | null> {
    const deadline = Date.now() + RULES.poemNextMs;
    while (Date.now() < deadline) {
      const next = this.prompt;
      if (next?.kind === 'poem_word') {
        if (this.readyReason === 'prompt') this.readyReason = null;
        this.shownPromptId = next.id;
        return next;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  private takePoemWords(): string[] {
    const words = this.poemWords;
    this.poemWords = [];
    return words;
  }

  // ── 游戏事件 ────────────────────────────────────────

  private onEvent(event: RenpyEvent): void {
    switch (event.type) {
      case 'hello':
        this.log('游戏报到：' + JSON.stringify({ label: event.label, mainMenu: event.mainMenu, playthrough: event.playthrough, resume: event.resume ?? null }));
        this.playthrough = event.playthrough;
        this.resume = event.resume ?? null;
        // 名字存在游戏的全局存档里：起过就一直是它，没起过等她开新游戏时起
        this.playerName = event.playername;
        this.setMainMenu(event.mainMenu);
        // 插件重启后游戏还在剧情里：接上当前段落（进度显示、导演模式的快进都靠它）
        if (!this.label && event.label && event.label !== 'after_load' && !event.mainMenu) {
          this.label = event.label;
          this.updateFast();
          this.updateRush();
        }
        break;
      case 'main_menu':
        this.setMainMenu(event.on);
        break;
      case 'label':
        this.onLabel(event.name, event.playthrough);
        break;
      case 'say':
        if (event.seq) this.lastLineSeq = Math.max(this.lastLineSeq, event.seq);
        this.onSay(event.who, event.what);
        break;
      case 'backlog':
        this.onBacklog(event.lines);
        break;
      case 'show':
        this.onShow(event.name);
        break;
      case 'hide': {
        const who = ddlc.characterOf(event.name.split(' ')[0]);
        if (who) this.onStage.delete(who);
        break;
      }
      case 'scene':
        this.onStage.clear();
        // 换场景：上一场戏结束，交给她（快进时不按场景交）
        if (!this.fast && !this.rushing && this.lines.length >= RULES.sceneMinLines) this.ready('scene');
        break;
      case 'prompt':
        this.onPrompt(event);
        break;
      case 'saved':
        if (!event.ok) this.log('存档没存上');
        break;
      case 'error':
        this.log(`mod 报错（${event.where}）：${event.message}`);
        break;
    }
  }

  private setMainMenu(on: boolean): void {
    this.atMainMenu = on;
    if (this.menuTimer) clearTimeout(this.menuTimer);
    this.menuTimer = null;
    if (!on) {
      // 离开主菜单（她选了，或者主人自己在游戏里点了）：主菜单 / 起名字的提示作废
      if (this.prompt?.kind === 'main_menu' || this.prompt?.kind === 'name') this.prompt = null;
      return;
    }
    // DDLC 每一幕都从主菜单进去：等主菜单画完，带着截图交给她选
    this.menuTimer = setTimeout(() => void this.offerMainMenu(), RULES.menuShotDelayMs);
  }

  private async offerMainMenu(): Promise<void> {
    this.menuTimer = null;
    if (!this.atMainMenu) return;
    const data = await this.bridge?.screenshot();
    if (!this.atMainMenu) return;
    if (data) this.image = { data, mediaType: data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png' };
    const choices = ['New Game'];
    if (this.resume) choices.push(`Load Game（上次的存档：${ddlc.actOf(this.playthrough, this.resume.label)}${this.resume.label ? `，${this.resume.label}` : ''}）`);
    this.prompt = { id: `main_menu-${++this.localPromptSeq}`, kind: 'main_menu', label: ddlc.PROMPT_LABELS.main_menu, choices, detail: data ? '主菜单的画面见图。' : undefined };
    this.ready('prompt');
  }

  /** 主菜单上选了：开新游戏（还没有名字就先起名字）或读插件的存档 */
  private chooseMainMenu(chosen: string): string {
    if (chosen.startsWith('Load Game')) {
      const resume = this.resume;
      this.resume = null;
      if (resume?.label) this.label = resume.label;
      this.bridge?.send({ type: 'load' });
      this.options.onAction?.('读取存档');
      return `读取存档，从${ddlc.actOf(this.playthrough, resume?.label ?? null)}${resume?.label ? `（${resume.label}）` : ''}继续。用 game_continue 继续。`;
    }
    this.options.onAction?.('开始新游戏');
    if (!this.playerName) {
      this.prompt = { id: `name-${++this.localPromptSeq}`, kind: 'name', label: ddlc.PROMPT_LABELS.name, choices: [], detail: '开新游戏要先给主角起名字。' };
      this.shownPromptId = this.prompt.id;
      return `${formatPrompt(this.prompt)}\n\n${formatActions(this.actionsNow())}`;
    }
    this.bridge?.send({ type: 'start' });
    return '开始新游戏。用 game_continue 继续。';
  }

  private enterName(name: string): string {
    if (this.prompt?.kind !== 'name') return '现在游戏没有在问名字。';
    const value = name.trim();
    if (!/^[A-Za-z]{1,12}$/.test(value)) return '名字只能用英文字母，1 到 12 个。';
    this.prompt = null;
    this.playerName = value;
    this.bridge?.send({ type: 'name', value });
    this.bridge?.send({ type: 'start' });
    this.options.onAction?.(`给主角起名：${value}`);
    return `主角的名字是 ${value}。开始新游戏。用 game_continue 继续。`;
  }

  private onLabel(name: string, playthrough: number | null): void {
    // 读档后 Ren'Py 走的系统段落：不是剧情位置，沿用读档时记下的段落（导演模式靠它判断快进）
    if (name === 'after_load') return;
    const before = ddlc.actOf(this.playthrough, this.label);
    this.label = name;
    this.playthrough = playthrough;
    const after = ddlc.actOf(playthrough, name);
    this.options.record?.({ type: 'label', label: name, act: after });
    if (after !== before) {
      this.notes.push(`进入${after}。`);
      // 新的一幕开场也放慢看一段
      this.introLeft = ddlc.INTRO_LINES;
    }
    if (ddlc.isAct3(name) && !this.act3Told) {
      this.act3Told = true;
      this.notes.push(ddlc.ACT3_FACT);
    }
    if (ddlc.isEndLabel(name) && !this.endTold) {
      this.endTold = true;
      this.notes.push(ddlc.END_FACT);
    }
    this.updateFast();
    this.updateRush();
    if (ddlc.isChapterStart(name) && this.lines.length >= RULES.storyMinLines && !this.fast) {
      this.notes.push('新的一天开始了。');
      this.ready('chapter');
    }
  }

  /**
   * 重新连上游戏时 mod 补发的台词：上一个插件（DSH 重启前）收到了还没交给她的、断线期间演过的。
   * 只要这次还没收过的；多的当快进内容做成摘要，少的直接当剧情。
   */
  private onBacklog(lines: { seq: number; who: string; what: string }[]): void {
    const fresh = lines.filter((l) => l.seq > this.lastLineSeq);
    if (!fresh.length) return;
    this.lastLineSeq = Math.max(this.lastLineSeq, ...fresh.map((l) => l.seq));
    const text = fresh
      .map((l) => ({ who: l.who, text: plain(l.what) }))
      .filter((l) => l.text)
      .map((l) => `${ddlc.speaker(l.who, this.playerName)}: ${l.text}`.slice(0, RULES.lineMaxChars));
    this.log(`补回断线前后的 ${text.length} 句台词`);
    if (text.length > RULES.storyLines) this.fastLines.push(...text.slice(-RULES.maxFastLines));
    else this.lines.push(...text);
    this.notes.push('插件中途和游戏断开过、又接上了；断开前后的剧情也在这里。');
  }

  private onSay(who: string, what: string): void {
    const text = plain(what);
    if (!text) return;
    const line = `${ddlc.speaker(who, this.playerName)}: ${text}`.slice(0, RULES.lineMaxChars);
    this.options.record?.({ type: 'line', who: ddlc.speaker(who, this.playerName), text, label: this.label, mode: this.rushing ? 'rush' : this.fast ? 'fast' : 'play' });
    if (this.rushing) {
      // 狂点段：台词进摘要；中途换的 CG 也不停下来拍（一路点过去）
      this.fastLines.push(line);
      if (this.fastLines.length > RULES.maxFastLines) this.fastLines.shift();
      this.pendingCg = null;
      return;
    }
    if (this.fast) {
      this.fastLines.push(line);
      if (this.fastLines.length > RULES.maxFastLines) this.fastLines.shift();
      if (this.pendingCg) {
        const cg = this.pendingCg;
        this.pendingCg = null;
        this.hold();
        void this.shootCg(cg);
      }
      return;
    }
    this.lines.push(line);
    if (this.lines.length > RULES.maxLines) this.lines.shift();
    // 开场放慢看完 INTRO_LINES 句，交给她一次，然后日常开始快进
    if (this.options.director && this.introLeft > 0 && --this.introLeft === 0) {
      this.updateFast();
      if (this.fast) {
        this.ready('scene');
        return;
      }
    }

    if (this.pendingCg) {
      const cg = this.pendingCg;
      this.pendingCg = null;
      this.hold();
      void this.shootCg(cg);
      return;
    }
    if (ddlc.isAct3(this.label) && /monika/i.test(who)) {
      if (++this.monikaLines >= RULES.monikaLines) {
        this.monikaLines = 0;
        this.ready('monika');
      }
      return;
    }
    if (this.lines.length >= RULES.storyLines) this.ready('story');
  }

  private onShow(name: string): void {
    const tag = name.split(' ')[0];
    const who = ddlc.characterOf(tag);
    if (who) this.onStage.add(who);
    const censored = ddlc.censoredScene(name);
    if (censored) {
      if (this.seen.has(censored)) return;
      this.seen.add(censored);
      this.notes.push(censored);
      this.ready('censored');
      return;
    }
    const cg = ddlc.cgKey(tag);
    if (cg && !this.seen.has(cg)) {
      this.seen.add(cg);
      this.pendingCg = cg;
      // 先停在 CG 后的第一句台词上，那时转场做完了
      this.hold();
    }
  }

  private async shootCg(cg: string): Promise<void> {
    await new Promise((r) => setTimeout(r, RULES.cgShotDelayMs));
    const data = await this.bridge?.screenshot();
    if (data) {
      this.image = { data, mediaType: data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png' };
      this.notes.push('出现了一张新的 CG（见图）。');
      this.ready('cg');
    } else {
      // 截不到（窗口最小化时是黑屏）：不提画面，游戏继续
      this.log(`CG ${cg} 没截到画面`);
      this.release();
    }
  }

  private onPrompt(event: RenpyPrompt): void {
    this.log(`游戏在等回答：${event.kind}（${event.id}）`);
    let detail: string | undefined;
    if (event.kind === 'menu') detail = event.caption || undefined;
    else if (event.kind === 'dialog') detail = plain(event.message);
    else if (event.kind === 'poem_read') detail = `${characterName(event.author)} 的诗《${plain(event.title)}》\n${plain(event.text)}`;
    else if (event.kind === 'poem_word') detail = `写诗：第 ${event.progress}/${event.total} 个词`;
    this.prompt = { id: event.id, kind: event.kind, label: ddlc.PROMPT_LABELS[event.kind], choices: event.choices.map(plain), detail };
    this.options.record?.({ type: 'prompt', kind: event.kind, choices: this.prompt.choices, detail });
    // 写诗挑词带着每个词的分数：「一步写完」照这个挑（见 actionsNow）
    if (event.kind === 'poem_word' && event.points?.length) this.prompt.points = event.points;
    this.ready('prompt');
  }

  private checkStoryGap(): void {
    if (this.held || this.readyReason || this.fast || this.rushing) return;
    if (this.lines.length >= RULES.storyMinLines && Date.now() - this.resumedAt >= RULES.storyGapMs) this.ready('story');
  }

  // ── 时刻 ────────────────────────────────────────────

  private ready(reason: Moment['reason']): void {
    this.log('时刻就绪：' + reason + (this.waiter ? '' : '（她还没在等）'));
    // prompt 优先：已经有别的原因时，prompt 覆盖它
    if (!this.readyReason || reason === 'prompt' || reason === 'disconnected') this.readyReason = reason;
    this.hold();
    void this.notifyReady();
  }

  /** 交给她之前，先把快进攒下的台词压成摘要 */
  private async notifyReady(): Promise<void> {
    if (this.fastLines.length && !this.summarizing) {
      const lines = this.fastLines;
      this.fastLines = [];
      this.summarizing = this.summarize(lines).finally(() => { this.summarizing = null; });
    }
    if (this.summarizing) await this.summarizing;
    if (this.readyReason) this.waiter?.(this.readyReason);
  }

  private async summarize(lines: string[]): Promise<void> {
    let summary = '';
    try {
      summary = (await this.options.summarize?.(lines, ddlc.SUMMARY_INSTRUCTION)) ?? '';
    } catch (err) {
      this.log(`快进摘要失败：${(err as Error).message}`);
    }
    if (!summary) summary = `最后几句：\n${lines.slice(-5).join('\n')}`;
    const prev = this.skipped;
    this.skipped = { count: (prev?.count ?? 0) + lines.length, summary: prev ? `${prev.summary}\n${summary}` : summary };
  }

  /** 按当前 label 决定快进还是放慢；从快进切到放慢时，把快进的内容交给她 */
  private updateFast(): void {
    const want = this.options.director && this.introLeft <= 0 && !!this.label && ddlc.isFastLabel(this.label, this.playthrough);
    if (want === this.fast) return;
    this.fast = want;
    this.bridge?.send({ type: 'skip', on: want });
    this.log(want ? `快进开始（${this.label}）` : `快进结束（${this.label}）`);
    if (!want && this.fastLines.length) this.ready('skipped');
  }

  /** 进出狂点段：mod 把文字改成瞬间显示、自动前进压到最短（像玩家一路狂点）；出来时把这段的摘要交给她 */
  private updateRush(): void {
    const want = !!this.label && ddlc.isRushLabel(this.label);
    if (want === this.rushing) return;
    this.rushing = want;
    this.bridge?.send({ type: 'rush', on: want });
    this.log(want ? `狂点开始（${this.label}）` : `狂点结束（${this.label}）`);
    if (!want && this.fastLines.length) {
      this.notes.push(ddlc.RUSH_FACT);
      this.ready('skipped');
    }
  }

  /**
   * 她现在能做的事：回答提示（选项、写诗挑词、弹窗、读诗、主菜单）；写诗时可以一步写完；起名字；
   * 第三幕起还能删角色文件（在对的时候才给）
   */
  private actionsNow(): GameActionSpec[] {
    const p = this.prompt;
    const actions: GameActionSpec[] = [];
    if (p?.kind === 'name') {
      actions.push({ action: 'enter_name', description: '给主角起名字', params: { name: '名字（只能用英文字母，最多 12 个：游戏字体只有英文）' } });
    } else if (p) {
      actions.push({ action: 'choose', description: `回答上面的${p.label}`, params: { index: '序号（从 1 开始）' } });
    }
    if (p?.kind === 'poem_word' && p.points?.length) {
      actions.push({
        action: 'write_for',
        description: '一步写完这首诗：每一轮自动挑最合这个人口味的词，把剩下的词一次挑完',
        params: { name: Object.keys(p.points[0]).join(' / ') },
      });
    }
    if (this.act3Told) {
      actions.push({ action: 'delete_character', description: '删掉游戏目录 characters/ 里的一个角色文件', params: { name: ddlc.CHARACTER_FILES.join(' / ') } });
    }
    return actions;
  }

  private takeMoment(reason: Moment['reason'], extraNotes: string[] = []): Moment {
    this.log(`交出时刻 #${this.momentSeq + 1}：${reason}，${this.lines.length} 句${this.skipped ? `，快进 ${this.skipped.count} 句` : ''}${this.prompt ? `，提示 ${this.prompt.kind}` : ''}`);
    const moment: Moment = {
      seq: ++this.momentSeq,
      reason,
      where: `${ddlc.actOf(this.playthrough, this.label)}${this.label ? `（${this.label}）` : ''}${this.atMainMenu ? '，主菜单' : ''}`,
      lines: this.lines,
      onStage: [...this.onStage],
      notes: [...this.notes, ...extraNotes],
      ...(this.image ? { image: this.image } : {}),
      ...(this.skipped ? { skipped: this.skipped } : {}),
      ...(this.prompt ? { prompt: this.prompt } : {}),
      actions: this.actionsNow(),
    };
    if (this.prompt) this.shownPromptId = this.prompt.id;
    this.options.record?.({
      type: 'moment',
      seq: moment.seq,
      reason,
      where: moment.where,
      lines: this.lines.length,
      ...(this.skipped ? { skipped: this.skipped } : {}),
    });
    // 到这一句为止都交给她了（快进的也做进了摘要）：mod 可以删掉留底
    if (this.lastLineSeq) this.bridge?.send({ type: 'ack', seq: this.lastLineSeq });
    // 每个时刻存一次档（游戏这时停着）；写诗挑到一半不存：读档会从这首诗的第一个词重来
    if (!this.atMainMenu && this.label && reason !== 'disconnected' && this.prompt?.kind !== 'poem_word') {
      this.bridge?.send({ type: 'save' });
    }
    this.lines = [];
    this.notes = [];
    this.image = undefined;
    this.skipped = null;
    this.readyReason = null;
    return moment;
  }

  private hold(): void {
    if (this.held) return;
    this.held = true;
    this.bridge?.send({ type: 'hold' });
  }

  private release(): void {
    this.resumedAt = Date.now();
    if (!this.held) return;
    this.held = false;
    this.bridge?.send({ type: 'release' });
  }

  private log(text: string): void {
    (this.options.log ?? ((t: string) => console.info(`[dsh-game/ddlc] ${t}`)))(text);
  }
}

function characterName(id: string): string {
  return ddlc.characterOf(id) ?? id;
}
