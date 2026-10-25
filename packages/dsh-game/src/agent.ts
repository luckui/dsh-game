/**
 * dsh-game agent 子插件：给模型用的工具。挂在「大肥鱼玩游戏」预设下（见 cordis.patch.yml）。
 *
 *   game_start   打开游戏
 *   game_continue    等下一个时刻（发生的事、新画面、她现在能做的事），游戏在她处理时暂停
 *   game_act     在游戏里做一件事（能做的事和参数由游戏在时刻里给出）
 *
 * 说话：她回复里写的文字就是她说出口的话（思考不念）。只有这一个出口，所以不会念重复：
 *   - 带游戏工具调用的那条消息：工具执行时从会话记录里读出同一条消息的文字，先念完再继续 / 行动；
 *     工具带 mood 只管表情。这次调用作废（没有游戏、游戏在别的会话里、动作被游戏拒绝）时，这条消息的话也不念，原因交给她
 *   - 不带工具调用的消息（一轮的最后一句，比如结局感想、游戏停住时回主人的话）：盯着开局的那个会话，看到就念
 *   - 每条消息只念一次（按会话 + 消息序号记）
 * 生命周期（runtime 的 games）：她调游戏工具就算回来玩了（resume）；盯会话时看到她这一轮结束，就把游戏暂停
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { GAMES, MOODS, broadcast, formatMoment, games, hooks, onAir, record, saveRunAsset, settings, speak, withMic, type GameId, type Mood } from './runtime.js';
import { canSpeak, estimateSpeechMs, synthesize, type TtsAuth } from './tts.js';
import { NARRATOR_VOICE } from './games/werewolf/characters.js';

export const name = 'dsh-game-agent';
export const inject = ['tools', 'attachments'];

/**
 * 豆包语音的密钥：DSH credentials 里的 DOUBAO_TTS_API_KEY（新版控制台：2.0、复刻音色）
 * 和 DOUBAO_TTS_APP_ID / DOUBAO_TTS_ACCESS_KEY（旧版控制台：1.0 音色），也认同名环境变量。
 * 这个音色要的那一套没配齐就返回 null（只有字幕没有声音）。
 */
async function ttsAuth(ctx: AgentContext, voice = settings.voice): Promise<TtsAuth | null> {
  const read = async (name: string) => {
    const credentials = ctx.get?.('credentials');
    const hit = credentials ? await credentials.resolve(name).catch(() => undefined) : undefined;
    return hit?.value ?? process.env[name] ?? '';
  };
  const [apiKey, appId, accessKey] = await Promise.all([read('DOUBAO_TTS_API_KEY'), read('DOUBAO_TTS_APP_ID'), read('DOUBAO_TTS_ACCESS_KEY')]);
  const auth = { apiKey, appId, accessKey };
  return canSpeak(auth, voice) ? auth : null;
}

/** 调一次模型（狼人杀的 AI 玩家）：不思考，只要文字 */
async function completeWithDsh(ctx: AgentContext, model: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const llm = ctx.get?.('llm');
  if (!llm) throw new Error('DSH 的模型服务不可用');
  const slash = model.indexOf('/');
  let text = '';
  for await (const chunk of llm.stream({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    system,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-game' } }],
    maxTokens: 1200,
    reasoningEffort: 'off',
    purpose: 'dsh-game-werewolf',
    signal: signal ?? AbortSignal.timeout(90_000),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return text.trim();
}

/** 别的角色（狼人杀的其他玩家、法官）念一句话：合成、推给舞台、等念完；原声另存一份 */
async function voiceAs(ctx: AgentContext, who: { seat: number; name: string; voice: string; rate?: number }, line: string, tag?: 'inner' | 'wolf'): Promise<void> {
  const text = line.trim();
  if (!text) return;
  // 没有音色的座位（上桌的主人）：只显示文字
  const auth = who.voice ? await ttsAuth(ctx, who.voice) : null;
  let audio: Uint8Array | null = null;
  if (auth) {
    try {
      audio = await synthesize(auth, who.voice, text, AbortSignal.timeout(30_000), who.rate ?? 0);
    } catch (err) {
      ctx.logger?.warn?.(`dsh-game: ${who.name} 的语音合成失败：${(err as Error).message}`);
    }
  }
  await withMic(async () => {
    const id = randomUUID();
    const estimateMs = estimateSpeechMs(text);
    const spoken = speak(id, estimateMs + 15_000, AbortSignal.timeout(estimateMs + 60_000));
    const start = Date.now();
    broadcast({ type: 'voice', id, seat: who.seat, name: who.name, text, audio: audio ? Buffer.from(audio).toString('base64') : null, estimateMs, at: start, ...(tag ? { tag } : {}) });
    const file = audio ? saveRunAsset(`voice-${start}.mp3`, audio) : null;
    try {
      await spoken;
    } finally {
      record({ type: 'voice', seat: who.seat, name: who.name, text, start, end: Date.now(), ...(tag ? { tag } : {}), ...(file ? { audio: file } : {}) });
    }
  });
}

/** game_continue 最多等多久（游戏一直没有新东西时返回，让她能说点什么或继续等） */
const WAIT_MAX_MS = 10 * 60_000;

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];


/** 用 DSH 的模型服务把快进的台词压成摘要（失败返回空，会话会退回只给最后几句） */
/** instruction：怎么摘要（游戏给，各游戏的内容不一样） */
async function summarizeWithDsh(ctx: AgentContext, lines: string[], instruction: string): Promise<string> {
  const llm = ctx.get?.('llm');
  if (!llm) return '';
  const [provider, model] = settings.summaryModel.split('/');
  let text = '';
  for await (const chunk of llm.stream({
    provider,
    model,
    system: instruction,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: lines.join('\n') }], source: { kind: 'dsh-game' } }],
    maxTokens: 2000,
    // 摘要不需要思考：思考会把输出上限用光
    reasoningEffort: 'off',
    purpose: 'dsh-game-summary',
    signal: AbortSignal.timeout(60_000),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') throw new Error(`摘要没有正常结束：${chunk.reason?.kind}`);
  }
  return text.trim();
}

/** 这个会话不是开这局游戏的会话（主人在别的会话里重新开了一局） */
const movedAway = (exec: { agent?: { id: string } }) => !!(games.owner && exec.agent?.id && games.owner !== exec.agent.id);
/** 现在没有游戏（还没开，或者 DSH 重启过、上一局已经没了） */
const NO_GAME = '现在没有打开的游戏（DSH 重启过的话，上一局已经没有了）。要玩就用 game_start 开一局。';
const MOVED_AWAY = '主人在另一个对话里开了新的一局，游戏现在在那个对话里进行；这个对话里的这局已经结束了。';
/** 主人按了「结束这局」 */
const CLOSED_BY_OWNER = '主人把这局游戏结束了。';

/** 现在没有游戏时交给她的话：是主人刚结束了她这局，还是本来就没有 */
const noGame = (exec: { agent?: { id: string } }) => (games.closed?.reason === 'owner' && games.closed.owner === exec.agent?.id ? CLOSED_BY_OWNER : NO_GAME);

/** 表情参数：游戏工具都带，管她这次说话时屏幕上大肥鱼的表情 */
const MOOD_PARAMS = {
  mood: { type: 'string', description: `你这次说话（回复里写的文字）时屏幕上大肥鱼的表情：${MOODS.join(' / ')}` },
} as const;

interface ToolExec { callId: string; agent?: { id: string }; signal: AbortSignal }

/** 已经念过的消息：会话 id + 消息序号 */
const voicedMessages = new Set<string>();

/** 她回复里的文字（一条消息里所有 text 部分） */
const wordsOf = (event: any): string => (event?.data?.message?.content ?? []).filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text.trim()).filter(Boolean).join('\n');
const hasToolCall = (event: any): boolean => (event?.data?.message?.content ?? []).some((p: any) => p?.type === 'tool-call');

/** 会话最近的记录（宿主的会话服务） */
function recentEvents(ctx: AgentContext, sessionId: string, from?: number): any[] {
  const session = ctx.get?.('sessions')?.get?.(sessionId);
  if (!session) return [];
  return session.snapshotEvents(from ?? Math.max(0, Number(session.seq) - 300)) as any[];
}

/** 念这次工具调用所在的那条消息里她写的话 */
async function voiceOwnWords(ctx: AgentContext, exec: ToolExec, mood: unknown): Promise<void> {
  const sessionId = exec.agent?.id;
  if (!sessionId) return;
  const events = recentEvents(ctx, sessionId);
  const message = [...events].reverse().find((e) => e?.type === 'assistant/message' && (e.data?.message?.content ?? []).some((p: any) => p?.type === 'tool-call' && p.id === exec.callId));
  if (!message) return;
  const key = `${sessionId}:${message.seq}`;
  if (voicedMessages.has(key)) return;
  voicedMessages.add(key);
  await speakLine(ctx, wordsOf(message), mood, exec.signal);
}

/** 盯着开局的那个会话：不带工具调用的消息（一轮的最后一句）出现了就念 */
let watched: { sessionId: string; seq: number } | null = null;
let watching = false;
async function voiceTurnEnds(ctx: AgentContext): Promise<void> {
  const sessionId = games.owner;
  if (!sessionId || !games.session || watching) return;
  const session = ctx.get?.('sessions')?.get?.(sessionId);
  if (!session) return;
  // 刚开始盯这个会话：只管从现在起的新消息
  if (!watched || watched.sessionId !== sessionId) {
    watched = { sessionId, seq: Number(session.seq) };
    return;
  }
  const events = recentEvents(ctx, sessionId, watched.seq);
  watched.seq = Number(session.seq);
  watching = true;
  try {
    for (const event of events) {
      // 她这一轮结束了（做完、被停止、出错）：没人在玩，牌桌也停下
      if (event?.type === 'turn/end') {
        games.pause();
        continue;
      }
      if (event?.type !== 'assistant/message' || hasToolCall(event)) continue;
      const key = `${sessionId}:${event.seq}`;
      if (voicedMessages.has(key)) continue;
      voicedMessages.add(key);
      await speakLine(ctx, wordsOf(event), 'talk', AbortSignal.timeout(90_000));
    }
  } finally {
    watching = false;
  }
}

/** 念一句话：合成语音，交给舞台播放和做表情，等念完再返回（这期间游戏一直停着） */
async function speakLine(ctx: AgentContext, textToSay: unknown, moodArg: unknown, signal: AbortSignal): Promise<void> {
  const line = typeof textToSay === 'string' ? textToSay.trim() : '';
  if (!line) return;
  const mood = ((MOODS as readonly string[]).includes(String(moodArg)) ? moodArg : 'talk') as Mood;
  // 主人坐在狼人杀桌上：她的心声这局主人听不到，记下来结束后复盘看
  const session = games.session;
  if (session?.mutesHer?.()) {
    session.noteHerWords?.(line);
    const now = Date.now();
    record({ type: 'say', text: line, mood, voiced: false, start: now, end: now });
    return;
  }
  // 在直播：她的话由直播插件念、上直播舞台，这里只记下来
  if (onAir()) {
    const now = Date.now();
    record({ type: 'say', text: line, mood, voiced: false, start: now, end: now });
    return;
  }
  const auth = await ttsAuth(ctx);
  let audio: Uint8Array | null = null;
  if (auth) {
    try {
      audio = await synthesize(auth, settings.voice, line, signal);
    } catch (err) {
      ctx.logger?.warn?.(`dsh-game: 语音合成失败：${(err as Error).message}`);
    }
  }
  // 牌桌上有人正在说话（狼人杀）：等那句念完再念她的
  await withMic(async () => {
    const id = randomUUID();
    const estimateMs = estimateSpeechMs(line);
    const spoken = speak(id, estimateMs + 15_000, signal);
    const start = Date.now();
    broadcast({ type: 'say', id, text: line, mood, audio: audio ? Buffer.from(audio).toString('base64') : null, estimateMs, at: start });
    // 她的原声另存一份（剪辑时单独一条干净的人声轨）
    const file = audio ? saveRunAsset(`say-${start}.mp3`, audio) : null;
    try {
      await spoken;
    } finally {
      record({ type: 'say', text: line, mood, voiced: !!audio, start, end: Date.now(), ...(file ? { audio: file } : {}) });
    }
  });
}

export function apply(ctx: AgentContext): void {
  hooks.summarize = (lines, instruction) => summarizeWithDsh(ctx, lines, instruction);
  hooks.complete = (model, system, user, signal) => completeWithDsh(ctx, model, system, user, signal);
  hooks.voice = (who, text, tag) => voiceAs(ctx, who, text, tag);
  hooks.tableVoiced = async () => !!(await ttsAuth(ctx, NARRATOR_VOICE));
  ctx.effect(() => {
    const timer = setInterval(() => void voiceTurnEnds(ctx).catch(() => {}), 400);
    return () => clearInterval(timer);
  }, 'dsh-game turn-end voice');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_start',
    description: `打开一个游戏开始玩。可以玩的游戏：${Object.entries(GAMES).map(([id, g]) => `${id}（${g.title}）`).join('、')}。返回这个游戏的背景和规则。`,
    parameters: {
      game: { type: 'string', required: true, description: `游戏 id：${Object.keys(GAMES).join(' / ')}` },
      ...MOOD_PARAMS,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      if (!(args.game in GAMES)) return `没有这个游戏：${args.game}`;
      const status = await games.start(args.game as GameId, exec.agent?.id);
      // 开局成功：这条消息的话算数
      await voiceOwnWords(ctx, exec, args.mood);
      return `${games.session?.facts ?? ''}\n\n${status}`;
    },
  })), 'game_start tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_continue',
    description: '让游戏从停住的地方接着往下走，到下一个时刻再停下交给你：游戏里发生了一段值得你看的事，或者轮到你做事了。返回这段时间发生的事、新画面（截图）和你现在能做的事。不调用它，游戏就一直停在原处。每个时刻有编号。',
    parameters: {
      after: { type: 'integer', required: true, description: '你上一次看到的时刻编号（第一次填 0）' },
      ...MOOD_PARAMS,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string', required: true }, image: { type: 'json', required: true } }, additionalProperties: false },
      render: (_args, value: any) => [
        ...text(value.text),
        ...(value.image ? [{ type: 'image' as const, attachment: value.image }] : []),
      ],
    },
    async execute(args, exec) {
      const session = games.session;
      if (!session) return { text: noGame(exec), image: null };
      if (movedAway(exec)) return { text: MOVED_AWAY, image: null };
      games.resume();
      // 实时游戏（Minecraft）：世界不等人，边念边等下一个时刻；别的游戏念完再继续
      const voicing = voiceOwnWords(ctx, exec, args.mood);
      if (!session.realtime) await voicing;
      // 在直播：直播间有事等她（弹幕、礼物、主人说话）就不等了，先交回给她；游戏停在原处（实时游戏照常进行）
      const waiting = new AbortController();
      const cancel = () => waiting.abort();
      exec.signal.addEventListener('abort', cancel, { once: true });
      let liveCalling = false;
      onAir()?.attention(waiting.signal).then(() => { liveCalling = !waiting.signal.aborted; waiting.abort(); }, () => {});
      const moment = await session.wait(waiting.signal, WAIT_MAX_MS);
      exec.signal.removeEventListener('abort', cancel);
      waiting.abort();
      await voicing;
      // 等的时候这局被关掉了（主人结束了这局，或者别的对话开了新局）
      if (games.session !== session) return { text: games.closed?.reason === 'owner' ? CLOSED_BY_OWNER : MOVED_AWAY, image: null };
      broadcast({ type: 'moment', game: session.title, reason: moment.reason, where: moment.where, prompt: moment.prompt, at: Date.now() });
      let image = null;
      if (moment.image) {
        [image] = await ctx.attachments.saveImages([{ data: moment.image.data, mediaType: moment.image.mediaType, name: 'game-screen' }]);
      }
      return { text: liveCalling ? `直播间有新消息。\n\n${formatMoment(moment)}` : formatMoment(moment), image };
    },
  })), 'game_continue tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_act',
    description: '在游戏里做一件事。现在能做哪些事、每件事要填哪些参数，见时刻里的【你现在能做的事】。',
    parameters: {
      action: { type: 'string', required: true, description: '要做的事（【你现在能做的事】里的 action）' },
      index: { type: 'integer', description: '序号（从 1 开始），这件事要它时填' },
      name: { type: 'string', description: '名字，这件事要它时填' },
      text: { type: 'string', description: '文字，这件事要它时填' },
      ...MOOD_PARAMS,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string', required: true }, image: { type: 'json', required: true } }, additionalProperties: false },
      render: (_args, value: any) => [
        ...text(value.text),
        ...(value.image ? [{ type: 'image' as const, attachment: value.image }] : []),
      ],
    },
    async execute(args, exec) {
      const session = games.session;
      if (!session) return { text: noGame(exec), image: null };
      if (movedAway(exec)) return { text: MOVED_AWAY, image: null };
      // 做完这件事游戏附了图（图纸的渲染图）：存成附件一起交给她
      const withImage = async (result: string) => {
        const shot = session.takeImage?.();
        if (!shot) return { text: result, image: null };
        const [image] = await ctx.attachments.saveImages([{ data: shot.data, mediaType: shot.mediaType, name: 'game-preview' }]);
        return { text: result, image };
      };
      // 动作和参数原样交给游戏：哪些动作、什么参数由游戏自己定
      const action = {
        action: String(args.action ?? ''),
        ...(args.index !== undefined && args.index !== null ? { index: Number(args.index) } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
      };
      // 现在做不了：这次表态作废，她这条消息的话也不念（念了再被拒，听起来像自己打脸），直接把原因交给她
      const refusal = session.refuse?.(action);
      if (refusal) return { text: refusal, image: null };
      games.resume();
      // 实时游戏：她说话的同时身体就开始动（动作本身立刻返回）；念完再交回结果，免得下一句话叠在这句上
      if (session.realtime) {
        const voicing = voiceOwnWords(ctx, exec, args.mood);
        const result = await session.act(action);
        await voicing;
        return withImage(result);
      }
      await voiceOwnWords(ctx, exec, args.mood);
      return withImage(await session.act(action));
    },
  })), 'game_act tool');
}
