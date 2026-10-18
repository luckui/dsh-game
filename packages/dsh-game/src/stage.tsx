/**
 * 舞台：一条事件流、一个语音播放器、大肥鱼。悬浮的大肥鱼、游戏库和「游戏」标签都读这里的状态。
 *   - 大肥鱼平时循环「吃白饭」；她说话时播放语音、「边吃边说」，大表情（震惊、害怕……）先收碗演表情再掏碗
 *   - 语音播完回执 /api/dsh-game/said，宿主那边才继续（游戏才继续）
 *
 * 连接：浏览器对同一地址最多开 6 个连接，DSH 自己也要用好几个。所以舞台只占一条：
 *   语音跟着台词事件一起来（base64），游戏画面在「游戏」标签开着时也走这一条（frame 事件），
 *   大肥鱼的动画片段第一次用时整个下载进内存，之后切换表情不再需要网络。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Beat, WolfEntry, WolfState } from './games/werewolf/engine.js';
import type { GameState } from './runtime.js';
import { buildMonologue } from './monologue.js';

interface SayEvent {
  type: 'say';
  id: string;
  text: string;
  mood: string;
  /** mp3（base64），没有语音时是 null */
  audio: string | null;
  estimateMs: number;
  /** 不是这个页面出声（别的页面在放）：只显示，不放、不回执 */
  mute?: boolean;
}

/** 一次性的大表情：收碗 → 表情 → 掏碗 */
const REACTIONS = new Set(['laugh', 'shocked', 'scared', 'sad', 'think', 'angry', 'shy']);
const CLIPS = ['riceloop', 'ricetalk', 'rice-exit', 'rice-enter', ...REACTIONS];

// ── 动画片段：下载进内存一次，之后用 blob 地址播放 ──────────────────

const clipBlobs = new Map<string, string>();
let clipsLoading = false;

/** 片段地址：已经在内存里就用内存里的，不然先走网络 */
export function clipUrl(name: string): string {
  return clipBlobs.get(name) ?? `/api/dsh-game/clips?name=${name}`;
}

/** 一个接一个下载（不一次占满连接） */
async function preloadClips(): Promise<void> {
  if (clipsLoading) return;
  clipsLoading = true;
  for (const name of CLIPS) {
    if (clipBlobs.has(name)) continue;
    try {
      const res = await fetch(`/api/dsh-game/clips?name=${name}`);
      if (res.ok) clipBlobs.set(name, URL.createObjectURL(await res.blob()));
    } catch {
      // 下次用到时还会走网络
    }
  }
}

// ── 状态 ─────────────────────────────────────────────

export interface StageState {
  /** 大肥鱼要播的片段：最后一个循环播，前面的播完一个出队一个 */
  queue: string[];
  /** 她正在说的话 */
  bubble: string | null;
  /** 正在玩的游戏和进度（最近一个时刻） */
  game: string | null;
  where: string | null;
  /** 有几个页面自己放了大肥鱼（游戏库、「游戏」标签）：大于 0 时不显示悬浮的那只 */
  docked: number;
}

let state: StageState = { queue: ['riceloop'], bubble: null, game: null, where: null, docked: 0 };
const subscribers = new Set<() => void>();

function update(change: (s: StageState) => StageState): void {
  state = change(state);
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (!source) connect();
  return () => subscribers.delete(notify);
}

export function useStage(): StageState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 这个页面自己放了大肥鱼（或者是游戏库）：开着时收起右下角浮着的那只 */
export function useDocked(): void {
  useEffect(() => {
    update((s) => ({ ...s, docked: s.docked + 1 }));
    return () => update((s) => ({ ...s, docked: s.docked - 1 }));
  }, []);
}

// ── 游戏画面：走同一条事件流，有人要看时才让宿主带上 ──────────────

const frameViewers = new Set<(dataUrl: string) => void>();
let lastFrame: string | null = null;

/** 接收游戏画面（JPEG data URL）。第一个观众来时事件流重连成带画面的，最后一个走时重连回不带画面的 */
export function useFrames(onFrame: (dataUrl: string) => void): void {
  const ref = useRef(onFrame);
  ref.current = onFrame;
  useEffect(() => {
    const viewer = (frame: string) => ref.current(frame);
    frameViewers.add(viewer);
    if (lastFrame) viewer(lastFrame);
    if (frameViewers.size === 1) connect();
    return () => {
      frameViewers.delete(viewer);
      if (frameViewers.size === 0) {
        lastFrame = null;
        connect();
      }
    };
  }, []);
}

// ── 狼人杀：牌桌局面、记录、谁在说话 ──────────────────

export interface WolfView {
  state: WolfState | null;
  /** 牌桌上发生过的事（最新的在最后） */
  feed: WolfEntry[];
  /** 正在念的话（seat 为 0 是法官）；tag：inner 心声、wolf 狼队私聊 */
  voice: { seat: number; text: string; tag?: 'inner' | 'wolf' } | null;
  /** 最近的心声：座位 → 文字（过几秒消失） */
  inner: Record<number, string>;
  /** 这一局里没做成的步骤：座位 → 次数和最近一次的原因 */
  faults: Record<number, { count: number; text: string }>;
  /** 最近演的一拍动作（画特效、出字幕；id 变了就重新演） */
  fx: { id: number; beat: Beat } | null;
  /** 座位上的标记：今晚被刀 / 被毒 / 被救（天亮清掉），被查验过（一直留着） */
  marks: Record<number, SeatMarks>;
  /** 这一轮投票已经揭晓的票：谁 → 投谁 */
  arrows: { from: number; to: number }[];
}

export interface SeatMarks {
  kill?: boolean;
  poison?: boolean;
  saved?: boolean;
  checked?: 'wolf' | 'good';
  /** 谁查验的（大肥鱼视角只看她自己验的） */
  checkedBy?: number;
}

/** 从记录里数出每个座位的 fault（刷新页面补记录时用） */
const faultsOf = (feed: WolfEntry[]) => feed.reduce<WolfView['faults']>((acc, e) => (e.kind === 'fault' ? { ...acc, [e.seat]: { count: (acc[e.seat]?.count ?? 0) + 1, text: e.text } } : acc), {});

const INNER_SHOW_MS = 9000;
const EMPTY_WOLF: WolfView = { state: null, feed: [], voice: null, inner: {}, faults: {}, fx: null, marks: {}, arrows: [] };
let wolf: WolfView = EMPTY_WOLF;
let fxSeq = 0;

/** 一拍动作落到座位标记和投票箭头上 */
function applyBeat(w: WolfView, beat: Beat): Pick<WolfView, 'marks' | 'arrows'> {
  const marks = { ...w.marks };
  const target = beat.target ?? null;
  const mark = (n: number, change: Partial<SeatMarks>) => { marks[n] = { ...marks[n], ...change }; };
  if (target) {
    if (beat.act === 'kill') mark(target, { kill: true });
    if (beat.act === 'save') mark(target, { kill: false, saved: true });
    if (beat.act === 'poison') mark(target, { poison: true });
    if (beat.act === 'check' && beat.result) mark(target, { checked: beat.result, checkedBy: beat.seats[0] });
  }
  const arrows = beat.act === 'vote' && target ? [...w.arrows.filter((a) => a.from !== beat.seats[0]), { from: beat.seats[0], to: target }] : w.arrows;
  return { marks, arrows };
}

/** 天亮：今晚的刀、毒、救标记清掉（查验标记留着） */
const dawnMarks = (marks: WolfView['marks']) => Object.fromEntries(Object.entries(marks).map(([n, m]) => [n, { checked: m.checked, checkedBy: m.checkedBy }]));
const wolfSubscribers = new Set<() => void>();
let wolfLoaded = false;

function updateWolf(change: (w: WolfView) => WolfView): void {
  wolf = change(wolf);
  for (const notify of wolfSubscribers) notify();
}

function subscribeWolf(notify: () => void): () => void {
  wolfSubscribers.add(notify);
  if (!source) connect();
  // 打开 / 刷新页面时把已经发生的补上
  if (!wolfLoaded) {
    wolfLoaded = true;
    void fetch('/api/dsh-game/wolf').then((r) => r.json()).then((body: { state: WolfState | null; history: WolfEntry[] }) => {
      if (body.state) updateWolf((w) => (w.feed.length ? { ...w, state: w.state ?? body.state } : { ...w, state: w.state ?? body.state, feed: body.history, faults: faultsOf(body.history) }));
    }).catch(() => { wolfLoaded = false; });
  }
  return () => wolfSubscribers.delete(notify);
}

// ── 这局游戏的状态（宿主的 games：进行中 / 暂停 / 已结束 / 没有） ──────────────

let gameState: GameState | null = null;
const gameStateSubscribers = new Set<() => void>();
let gameStateLoaded = false;

function setGameState(next: GameState): void {
  gameState = next;
  // 没有游戏了、或者换成了别的游戏：牌桌清空（不然会一直显示上一局最后的样子）
  if (next.status === 'none' || next.game !== 'werewolf') updateWolf(() => EMPTY_WOLF);
  for (const notify of gameStateSubscribers) notify();
}

function subscribeGameState(notify: () => void): () => void {
  gameStateSubscribers.add(notify);
  if (!source) connect();
  if (!gameStateLoaded) {
    gameStateLoaded = true;
    void fetch('/api/dsh-game/state').then((r) => r.json()).then((s: GameState) => { if (!gameState) setGameState(s); }).catch(() => { gameStateLoaded = false; });
  }
  return () => gameStateSubscribers.delete(notify);
}

export function useGameState(): GameState | null {
  return useSyncExternalStore(subscribeGameState, () => gameState);
}

export function useWolf(): WolfView {
  return useSyncExternalStore(subscribeWolf, () => wolf);
}

function onWolf(event: { entry: WolfEntry; state: WolfState }): void {
  const { entry, state } = event;
  // 「谁在想」只更新局面
  if (entry.kind === 'think') return updateWolf((w) => ({ ...w, state }));
  // 新的一局：记录从头开始
  const fresh = entry.kind === 'narrator' && state.day === 0;
  updateWolf((w) => {
    let { marks, arrows, fx } = w;
    if (fresh) { marks = {}; arrows = []; fx = null; }
    // 演给这个视角看的一拍动作：画特效、上标记
    if (entry.kind === 'beat' && entry.shown && entry.stage === 'act') {
      fx = { id: ++fxSeq, beat: entry.beat };
      ({ marks, arrows } = applyBeat({ ...w, marks, arrows }, entry.beat));
    }
    if (entry.kind === 'narrator') {
      // 天黑：上一轮的票收起；天亮：今晚的标记清掉；开始投票：箭头从头画
      if (entry.text.includes('天黑')) arrows = [];
      if (entry.text.startsWith('天亮')) marks = dawnMarks(marks);
      if (entry.text.includes('请投票')) arrows = [];
    }
    return {
      ...w,
      state,
      fx,
      marks,
      arrows,
      feed: fresh ? [entry] : [...w.feed.slice(-299), entry],
      inner: entry.kind === 'inner' ? { ...w.inner, [entry.seat]: entry.text } : w.inner,
      faults: fresh ? {} : entry.kind === 'fault' ? { ...w.faults, [entry.seat]: { count: (w.faults[entry.seat]?.count ?? 0) + 1, text: entry.text } } : w.faults,
    };
  });
  if (entry.kind === 'inner') {
    setTimeout(() => updateWolf((w) => {
      if (w.inner[entry.seat] !== entry.text) return w;
      const inner = { ...w.inner };
      delete inner[entry.seat];
      return { ...w, inner };
    }), INNER_SHOW_MS);
  }
}

/** 别的角色说话（狼人杀的其他玩家、法官）：播她们的语音，播完回执 */
let voiceAudio: HTMLAudioElement | null = null;
let voiceTimer: ReturnType<typeof setTimeout> | null = null;
function onVoice(event: VoiceEvent): void {
  voiceAudio?.pause();
  if (voiceTimer) clearTimeout(voiceTimer);
  updateWolf((w) => ({ ...w, voice: { seat: event.seat, text: event.text, ...(event.tag ? { tag: event.tag } : {}) } }));
  const done = () => {
    updateWolf((w) => (w.voice?.text === event.text ? { ...w, voice: null } : w));
    if (!event.mute) void fetch(`/api/dsh-game/said?id=${encodeURIComponent(event.id)}`, { method: 'POST' }).catch(() => {});
  };
  const fallback = () => { voiceTimer = setTimeout(done, event.estimateMs); };
  if (!event.audio || event.mute) return fallback();
  voiceAudio = new Audio(`data:audio/mpeg;base64,${event.audio}`);
  // 心声：和大肥鱼的心声一样过内心独白效果
  const chain = event.tag === 'inner' ? monologueChain() : null;
  if (chain) {
    const node = chain.ctx.createMediaElementSource(voiceAudio);
    node.connect(chain.input);
    voiceAudio.addEventListener('ended', () => node.disconnect(), { once: true });
  }
  voiceAudio.onended = done;
  voiceAudio.onerror = fallback;
  voiceAudio.play().catch(fallback);
}

interface VoiceEvent {
  id: string;
  seat: number;
  name: string;
  tag?: 'inner' | 'wolf';
  text: string;
  audio: string | null;
  estimateMs: number;
  /** 不是这个页面出声：只显示，不放、不回执 */
  mute?: boolean;
}

// ── 事件流 ────────────────────────────────────────────

let source: EventSource | null = null;
let audio: HTMLAudioElement | null = null;
let audioTimer: ReturnType<typeof setTimeout> | null = null;

const finish = (event: SayEvent) => {
  // 说完了：队列里的「边吃边说」都换成「吃白饭」（表情片段还在播就让它播完再接上）
  update((s) => ({ ...s, bubble: null, queue: s.queue.map((n) => (n === 'ricetalk' ? 'riceloop' : n)) }));
  if (!event.mute) void fetch(`/api/dsh-game/said?id=${encodeURIComponent(event.id)}`, { method: 'POST' }).catch(() => {});
};

/**
 * 同一时间只有一个页面出声（宿主决定，见 runtime 的 audio）：这个页面的 id，宿主现在让谁出声。
 * 主人在哪个页面里点一下、按个键，就换成那个页面出声。
 */
const PAGE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let audioOwner: string | null = null;
let lastClaim = 0;
function claimAudio(): void {
  if (audioOwner === PAGE_ID || Date.now() - lastClaim < 1000) return;
  lastClaim = Date.now();
  void fetch(`/api/dsh-game/claim?page=${PAGE_ID}`, { method: 'POST' }).catch(() => {});
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', claimAudio, { capture: true });
  window.addEventListener('keydown', claimAudio, { capture: true });
}

/**
 * 内心独白：狼人杀里她同一个声音既在牌桌上发言、又说心声，心声过一遍效果（monologue.ts）和发言区分开。牌桌发言（voice）保持原声。
 * 浏览器还没允许出声（AudioContext 起不来）时照原声放，不会没声音。
 */
let monologue: { ctx: AudioContext; input: AudioNode } | null = null;

function monologueChain(): { ctx: AudioContext; input: AudioNode } | null {
  if (monologue) return monologue.ctx.state === 'running' ? monologue : null;
  try {
    const ctx = new AudioContext();
    monologue = { ctx, input: buildMonologue(ctx) };
    void ctx.resume().catch(() => {});
    return ctx.state === 'running' ? monologue : null;
  } catch {
    return null;
  }
}

function onSay(say: SayEvent): void {
  audio?.pause();
  if (audioTimer) clearTimeout(audioTimer);
  update((s) => ({
    ...s,
    bubble: say.text,
    queue: REACTIONS.has(say.mood) ? ['rice-exit', say.mood, 'rice-enter', 'ricetalk'] : ['ricetalk'],
  }));
  const fallback = () => { audioTimer = setTimeout(() => finish(say), say.estimateMs); };
  if (!say.audio || say.mute) return fallback();
  audio = new Audio(`data:audio/mpeg;base64,${say.audio}`);
  // 狼人杀进行中：心声走内心独白效果
  const chain = wolf.state && state.game === '狼人杀' ? monologueChain() : null;
  if (chain) {
    const node = chain.ctx.createMediaElementSource(audio);
    node.connect(chain.input);
    audio.addEventListener('ended', () => node.disconnect(), { once: true });
  }
  audio.onended = () => finish(say);
  audio.onerror = fallback;
  audio.play().catch(fallback);
}

/** （重新）连上事件流：有人在看游戏画面就带上画面 */
function connect(): void {
  source?.close();
  source = new EventSource(`/api/dsh-game/events?page=${PAGE_ID}${frameViewers.size ? '&frames=1' : ''}`);
  void preloadClips();
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as SayEvent | { type: string; game?: string; where?: string };
    if (event.type === 'say') return onSay(event as SayEvent);
    if (event.type === 'wolf') return onWolf(event as unknown as { entry: WolfEntry; state: WolfState });
    if (event.type === 'voice') return onVoice(event as unknown as VoiceEvent);
    if (event.type === 'game-state') return setGameState((event as unknown as { state: GameState }).state);
    if (event.type === 'audio-owner') {
      audioOwner = (event as { owner?: string | null }).owner ?? null;
      // 换成别的页面出声：这边正在放的停掉（那边会接着放下一句）
      // 正在放的这句当作放完（回执），游戏不用干等
      if (audioOwner !== PAGE_ID) {
        for (const playing of [audio, voiceAudio]) {
          if (playing && !playing.paused) {
            playing.pause();
            playing.onended?.call(playing, new Event('ended'));
          }
        }
      }
      return;
    }
    if (event.type === 'moment') {
      const moment = event as { game?: string; where?: string };
      update((s) => ({ ...s, game: moment.game ?? s.game, where: moment.where ?? s.where }));
    }
  };
  source.addEventListener('frame', (message) => {
    lastFrame = `data:image/jpeg;base64,${(message as MessageEvent).data}`;
    for (const viewer of frameViewers) viewer(lastFrame);
  });
}

const nextClip = () => update((s) => ({ ...s, queue: s.queue.length > 1 ? s.queue.slice(1) : s.queue }));
export const FISH_CSS = `
.dg-float{position:fixed;right:24px;bottom:24px;width:200px;z-index:40;pointer-events:none;font-family:system-ui,sans-serif}
.dg-fish{position:relative;width:100%}
.dg-player{position:relative;width:100%;aspect-ratio:496 / 864;filter:drop-shadow(0 0 16px rgba(80,150,255,.3))}
.dg-player video{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0}
.dg-player video[data-role=prev]{opacity:1;z-index:1}
.dg-player video[data-role=front]{opacity:1;z-index:2;animation:dg-clip-in .09s linear}
@keyframes dg-clip-in{from{opacity:0}}
.dg-bubble{position:absolute;right:0;bottom:calc(100% - 26px);width:max-content;max-width:300px;padding:10px 14px;border-radius:14px;
  font-size:14px;line-height:1.6;color:#e8f2ff;background:linear-gradient(180deg,rgba(24,38,72,.82),rgba(10,18,38,.86));
  border:1px solid rgba(134,220,255,.42);backdrop-filter:blur(12px) saturate(140%);-webkit-backdrop-filter:blur(12px) saturate(140%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 0 24px -8px rgba(134,220,255,.65),0 10px 28px rgba(0,0,0,.3);animation:dg-pop .2s ease-out}
.dg-bubble::after{content:'';position:absolute;right:42%;bottom:-7px;width:12px;height:12px;transform:rotate(45deg);
  background:rgba(12,20,42,.92);border-right:1px solid rgba(134,220,255,.42);border-bottom:1px solid rgba(134,220,255,.42)}
.dg-bubble small{display:block;font:11px "JetBrains Mono","Cascadia Code",Consolas,monospace;color:#86dcff;letter-spacing:.6px;margin-bottom:2px}
@keyframes dg-pop{from{transform:translateY(4px);opacity:0}to{transform:none;opacity:1}}
`;

/** 大肥鱼，说话时头顶冒气泡；宽度跟着外面的容器 */
export function Fish() {
  const { queue, bubble } = useStage();
  return (
    <div className="dg-fish">
      {bubble && <div className="dg-bubble" key={bubble}><small>大肥鱼</small>{bubble}</div>}
      <Player name={queue[0] ?? 'riceloop'} loop={queue.length <= 1} onEnded={nextClip} />
    </div>
  );
}

/**
 * 两个 <video> 轮流当前台（桌宠常用的双缓冲）：下一个片段先在后台加载、开播，真的画出第一帧了才换到前台，
 * 换的时候新片段在上面淡入 90 毫秒、旧的垫在下面——不会有一帧空白，片段中途切换时动作也不会硬跳。
 */
function Player({ name, loop, onEnded }: { name: string; loop: boolean; onEnded: () => void }) {
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0);
  // 刚换下来的那个：淡入期间垫在下面，之后停掉
  const [prev, setPrev] = useState<number | null>(null);
  const shown = useRef<string | null>(null);
  const frontRef = useRef(0);

  useEffect(() => {
    const videos = refs.map((r) => r.current!);
    const current = videos[frontRef.current];
    if (shown.current === null) {
      shown.current = name;
      current.src = clipUrl(name);
      current.loop = loop;
      current.play().catch(() => {});
      return;
    }
    if (shown.current === name) {
      current.loop = loop;
      return;
    }
    const next = 1 - frontRef.current;
    const back = videos[next];
    let cancelled = false;
    back.src = clipUrl(name);
    back.loop = loop;
    const reveal = () => {
      if (cancelled) return;
      shown.current = name;
      setPrev(frontRef.current);
      frontRef.current = next;
      setFront(next);
    };
    // 兜底：浏览器没报第一帧（页面在后台时不画）也最多等 250 毫秒
    const fallback = setTimeout(reveal, 250);
    back.play().then(() => {
      // 等这个片段真的画出第一帧再换上来
      if ('requestVideoFrameCallback' in back) back.requestVideoFrameCallback(() => { clearTimeout(fallback); reveal(); });
      else { clearTimeout(fallback); reveal(); }
    }).catch(() => { clearTimeout(fallback); reveal(); });
    return () => { cancelled = true; clearTimeout(fallback); };
  }, [name, loop]);

  useEffect(() => {
    if (prev === null) return;
    const timer = setTimeout(() => {
      refs[prev].current?.pause();
      setPrev(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [prev]);

  return (
    <div className="dg-player">
      {refs.map((ref, i) => (
        <video
          key={i}
          ref={ref}
          muted
          playsInline
          data-role={i === front ? 'front' : i === prev ? 'prev' : undefined}
          onEnded={() => { if (i === frontRef.current) onEnded(); }}
        />
      ))}
    </div>
  );
}

/** 右下角浮着的大肥鱼（游戏库和「游戏」标签开着时由它们自己的那只代替） */
export function FloatingFish() {
  const { docked } = useStage();
  if (docked > 0) return null;
  return <div className="dg-float"><Fish /></div>;
}
