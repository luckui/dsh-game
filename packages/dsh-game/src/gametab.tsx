/**
 * 会话里的「游戏」标签。版式（同一套变量，见 GAMETAB_CSS）：
 *   ┌ 标题栏：游戏名 · 进度 ─────────────────── ● LIVE  ■ 停止 ┐
 *   │ 游戏画面（可用空间里最大的 16:9）  │ 终端：她的思考、操作、说的话、主人的话 │
 *   │ 输入栏（和画面等宽）               │                                        │
 *   └──────────────────────────────────────────────────────────┘
 *   大肥鱼全身悬浮在右下角，和终端右边缘对齐，说话时头顶冒气泡。
 * 这个标签开着时，DSH 底部默认的输入框收起来（用画面下面的输入栏）；审批 / 提问面板不受影响。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Ambient } from './ambient.js';
import { CHARACTERS } from './games/werewolf/characters.js';
import { Fish, useDocked, useFrames, useGameState, useWolf } from './stage.js';
import type { GameState } from './runtime.js';
import { WolfTable } from './wolf.js';
import { openLibrary } from './library.js';

/** 影院模式：收起右边的思考终端，游戏画面占满（记在浏览器里，下次还是这样） */
const THEATER_KEY = 'dsh-game.theater';
function useTheater(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(THEATER_KEY) === '1';
    } catch {
      return false;
    }
  });
  // 影院模式时把 DSH 自己的标题和标签页那一排也收起来（见 GAMETAB_CSS 开头）
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.dshGameTheater = '';
    else delete root.dataset.dshGameTheater;
    return () => { delete root.dataset.dshGameTheater; };
  }, [on]);
  const toggle = () => setOn((v) => {
    try {
      localStorage.setItem(THEATER_KEY, v ? '0' : '1');
    } catch {
      // 存不了就只在这次有效
    }
    return !v;
  });
  return [on, toggle];
}

/** DSH 会话事件（只用到的字段） */
interface SessionEvent { type: string; seq?: number; time?: number; data?: any }
interface EventEntry { type: 'event' | 'transient'; event: SessionEvent }
interface Observable<T> { subscribe(listener: () => void): () => void; getSnapshot(): T }
/** 注册标签时按会话注入的东西 */
export interface GameTabInjected {
  /** 这个会话的事件窗口 */
  events?: Observable<{ entries: readonly EventEntry[] }>;
  /** 主人在终端里说的话，发进这个会话 */
  send?: (text: string) => Promise<{ ok: boolean; error?: { message: string } }>;
  /** 停止她这一轮 */
  stop?: () => Promise<void>;
  /** 这个标签所在的 DSH 会话 */
  sessionId?: string;
  /** 打开另一个会话（这局游戏在别的对话里时跳过去） */
  openSession?: (sessionId: string) => void;
}

/** shell / out：她动了游戏外面的文件（删 .chr），按终端命令和输出的样子显示 */
type LineKind = 'moment' | 'act' | 'think' | 'say' | 'chat' | 'owner' | 'note' | 'shell' | 'out';
interface Line { key: string; kind: LineKind; time: number | null; text: string; live?: boolean }

/** 终端最多留多少行 */
const MAX_LINES = 160;
/** 一段思考在终端里最多显示多少字 */
const THINK_CHARS = 200;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : typeof content === 'string' ? content : '';
const argsOf = (call: any): Record<string, unknown> => {
  try {
    return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? call.input ?? {};
  } catch {
    return {};
  }
};

/** 工具结果 → 终端行：时刻 / 她的操作 / 其他（报错等） */
function resultLine(text: string): { kind: LineKind; text: string } | null {
  const first = text.split('\n')[0].trim();
  if (!first) return null;
  const moment = /^【时刻】#(\d+)/.exec(first);
  if (moment) {
    const where = /【进度】(.+)/.exec(text)?.[1] ?? '';
    const skipped = /【快进的部分】（快进了 (\d+) 句）/.exec(text)?.[1];
    const waiting = /【游戏在等你：(.+?)】/.exec(text)?.[1];
    return { kind: 'moment', text: ['◆ #' + moment[1], where, skipped && `快进 ${skipped} 句`, waiting && `等你：${waiting}`].filter(Boolean).join(' · ') };
  }
  if (first.startsWith('这是《')) return { kind: 'act', text: '▸ 打开游戏' };
  const chosen = /^已选择「(.+)」/.exec(first);
  if (chosen) return { kind: 'act', text: `▸ 选了「${chosen[1]}」` };
  const word = /^已选「(.+?)」/.exec(first);
  if (word) return { kind: 'act', text: `▸ 挑词 ${word[1]}` };
  const deleted = /^已删除 (characters\/\S+\.chr)/.exec(first);
  if (deleted) return { kind: 'out', text: `removed '${deleted[1]}'` };
  if (/^(按 |读取存档|开始新游戏|主角的名字是|游戏已经打开)/.test(first)) return { kind: 'act', text: `▸ ${clip(first.split(/[。，]/)[0], 60)}` };
  return { kind: 'note', text: clip(first, 80) };
}

/** 会话事件 → 终端行（最新的在最前） */
function feedOf(entries: readonly EventEntry[]): Line[] {
  const lines: Line[] = [];
  let liveThink = '';
  let liveChat = '';
  let liveTime: number | null = null;
  for (const entry of entries.slice(-600)) {
    const e = entry.event;
    const time = e.time ?? null;
    const key = `${e.seq ?? ''}`;
    if (entry.type === 'transient') {
      const chunk = e.data?.chunk;
      if (chunk?.type === 'reasoning-delta') liveThink += chunk.text;
      else if (chunk?.type === 'text-delta') liveChat += chunk.text;
      liveTime = time;
      continue;
    }
    if (e.type === 'user/message') {
      const text = oneLine(textOf(e.data?.message?.content ?? e.data?.content));
      if (text) lines.push({ key: `${key}u`, kind: 'owner', time, text });
    } else if (e.type === 'assistant/message') {
      // 这条消息定稿了：之前边写边推的临时文本就是它，丢掉
      liveThink = '';
      liveChat = '';
      const parts: any[] = e.data?.message?.content ?? [];
      parts.forEach((part, i) => {
        if (part?.type === 'reasoning' && part.text?.trim()) lines.push({ key: `${key}r${i}`, kind: 'think', time, text: clip(oneLine(part.text), THINK_CHARS) });
        else if (part?.type === 'text' && part.text?.trim()) lines.push({ key: `${key}t${i}`, kind: 'chat', time, text: oneLine(part.text) });
        else if (part?.type === 'tool-call') {
          const args = argsOf(part);
          // 删角色文件：一调用就打出命令（结果回来再打输出），删除过程中终端上就看得到
          if (args.action === 'delete_character' && typeof args.name === 'string') {
            lines.push({ key: `${key}c${i}`, kind: 'shell', time, text: `rm characters/${args.name.trim().toLowerCase()}.chr` });
          }
        }
      });
    } else if (e.type === 'tool/result') {
      const line = resultLine(textOf(e.data?.message?.content));
      if (line) lines.push({ key: `${key}x`, time, ...line });
    }
  }
  if (liveThink.trim()) lines.push({ key: 'live-think', kind: 'think', time: liveTime, text: clip(oneLine(liveThink).slice(-THINK_CHARS), THINK_CHARS + 1), live: true });
  if (liveChat.trim()) lines.push({ key: 'live-chat', kind: 'chat', time: liveTime, text: oneLine(liveChat), live: true });
  return lines.reverse().slice(0, MAX_LINES);
}

/** 标题栏：打开游戏时的游戏名（「这是《…》」）、最近一个时刻的进度 */
function headOf(entries: readonly EventEntry[]): { game: string | null; where: string | null } {
  let game: string | null = null;
  let where: string | null = null;
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event.type !== 'tool/result') continue;
    const text = textOf(entry.event.data?.message?.content);
    game = /^这是《(.+?)》/.exec(text)?.[1] ?? game;
    where = /【进度】(.+)/.exec(text)?.[1] ?? where;
  }
  return { game, where };
}

const hhmm = (time: number | null) => {
  if (!time) return '';
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const LABELS: Partial<Record<LineKind, string>> = { think: 'think', say: '说 ›', chat: '说 ›', owner: '主人 ›', shell: 'dafeiyu@game ~ $' };

const noop = () => () => {};
const EMPTY: { entries: readonly EventEntry[] } = { entries: [] };

/** 这个会话的事件窗口（她的思考、操作、主人的话都从这里来） */
function useEvents(events: GameTabInjected['events']): readonly EventEntry[] {
  const subscribeEvents = useMemo(() => (events ? (listener: () => void) => events.subscribe(listener) : noop), [events]);
  return useSyncExternalStore(subscribeEvents, () => events?.getSnapshot() ?? EMPTY).entries;
}

/** 游戏画面下面的输入栏（和画面等宽）：主人跟她说话 */
function OwnerInput({ send }: { send: GameTabInjected['send'] }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !send) return;
    setDraft('');
    setError(null);
    try {
      const result = await send(text);
      if (!result.ok) setError(result.error?.message ?? '没发出去');
    } catch (err) {
      console.error('dsh-game: 发送失败', err);
      setError(String((err as Error)?.message ?? err));
      setDraft(text);
    }
  };

  return (
    <label className="dg-input">
      <span className="dg-input-who">主人 ›</span>
      <input
        value={draft}
        placeholder={error ? `没发出去：${error}` : '对大肥鱼说点什么…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
      />
      <button type="button" className="dg-send" disabled={!draft.trim()} onClick={() => void submit()}>发送 ⏎</button>
    </label>
  );
}

function Terminal({ entries }: { entries: readonly EventEntry[] }) {
  const lines = useMemo(() => feedOf(entries), [entries]);
  return (
    <div className="dg-term">
      <div className="dg-term-bar"><span><b>dafeiyu</b>@game ~ 思考</span><span className="dg-term-dots"><i /><i /><i /></span></div>
      <div className="dg-feed">
        {lines.map((line) => (
          <div className={`dg-ln dg-ln-${line.kind}`} key={line.key}>
            <time>{line.live ? '' : hhmm(line.time)}</time>
            <span className="dg-ln-t">
              {LABELS[line.kind] && <span className="dg-ln-k">{LABELS[line.kind]}</span>}
              {line.text}
              {line.live && <span className="dg-cursor" />}
            </span>
          </div>
        ))}
        {!lines.length && <div className="dg-ln dg-ln-note"><time /><span className="dg-ln-t">等她开始玩……</span></div>}
      </div>
    </div>
  );
}

/** 主人上桌时思考终端的位置：她的思考这局先不给看 */
function SealedTerminal() {
  return (
    <div className="dg-term dg-term-sealed">
      <div className="dg-term-bar"><span><b>dafeiyu</b>@game ~ 思考</span><span className="dg-term-dots"><i /><i /><i /></span></div>
      <div className="dg-sealed">
        <b>你也在桌上</b>
        <p>她的思考和心声这局先封起来，免得你看到她的底牌。</p>
        <p>这局结束后，这里和牌桌右上的「复盘」都能看。</p>
      </div>
    </div>
  );
}

/** 游戏画面：游戏自己推来的 MJPEG，<img> 直接显示。这个连接开着，插件才让游戏推流 */
function GameScreen({ onLive }: { onLive: (live: boolean) => void }) {
  const [live, setLive] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => onLive(live), [live, onLive]);
  // 画面走舞台的事件流（不另开连接）：每来一帧直接换 <img> 的地址，不经过 React 重渲染
  useFrames((frame) => {
    if (ref.current) ref.current.src = frame;
    setLive(true);
  });
  return (
    <div className="dg-screen">
      {!live && <span className="dg-idle">waiting for game…</span>}
      <img ref={ref} alt="" style={live ? undefined : { display: 'none' }} />
    </div>
  );
}

/** 她这局看过的图（每 3 秒问一次有没有新的） */
function useGallery(): { id: number; label: string; at: number }[] {
  const [items, setItems] = useState<{ id: number; label: string; at: number }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/dsh-game/gallery', { cache: 'no-store' }).then((r) => r.json()).then((list) => { if (alive && Array.isArray(list)) setItems(list); }).catch(() => {});
    void load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return items;
}

/**
 * 画面在游戏客户端窗口里（Minecraft 摄像机）：说明 + 视角切换（往那个窗口发 F5，不用碰它）。
 * 她看过图（图纸的渲染图、切开图、地形图）时，这块地方显示她最新看到的那张，下面一排是前几张，点了看那张（点最新的回到跟着最新）
 */
function ClientScreen({ title, note, perspective }: { title: string; note: string; perspective: string | null }) {
  const gallery = useGallery();
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState('');
  const pick = async (mode: string) => {
    setError('');
    const res = await fetch(`/api/dsh-game/view?mode=${mode}`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) setError((await res?.text().catch(() => '')) || '切换失败');
  };
  const views: [string, string][] = [['follow', '跟拍'], ['first', '她的视角'], ['back', '背后'], ['front', '正面']];
  const viewButtons = perspective && (
    <div className="dg-client-views">
      {views.map(([mode, label]) => (
        <button key={mode} className={`dg-stop dg-tool${perspective === mode ? ' on' : ''}`} onClick={() => void pick(mode)}>{label}</button>
      ))}
    </div>
  );
  const latest = gallery[gallery.length - 1];
  const shown = gallery.find((g) => g.id === picked) ?? latest;
  if (shown) {
    return (
      <div className="dg-screen dg-screen-gallery">
        <div className="dg-gallery-top" title={note}>
          <span><b>{shown.label}</b>{shown !== latest ? ' · 前几张' : ' · 她刚看到的'}</span>
          <span className="dg-gallery-hint">游戏画面在客户端窗口里</span>
          {viewButtons}
        </div>
        <img className="dg-gallery-main" src={`/api/dsh-game/gallery-image?id=${shown.id}&t=${shown.at}`} alt={shown.label} />
        <div className="dg-gallery-strip">
          {gallery.slice(-12).map((g) => (
            <button key={g.id} className={g.id === shown.id ? 'on' : ''} title={g.label} onClick={() => setPicked(g.id === latest.id ? null : g.id)}>
              <img src={`/api/dsh-game/gallery-image?id=${g.id}&t=${g.at}`} alt={g.label} />
            </button>
          ))}
        </div>
        {error && <p className="dg-client-error">{error}</p>}
      </div>
    );
  }
  return (
    <div className="dg-screen dg-screen-note">
      <b>{`${title}的画面在游戏客户端窗口里`}</b>
      <p>{note}</p>
      {viewButtons}
      {error && <p className="dg-client-error">{error}</p>}
    </div>
  );
}

/** 这个标签开着时收起 DSH 默认的输入框卡片（审批 / 提问面板换掉输入框时，默认卡片本来就藏着，不受影响） */
function useHideComposer(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.dshGameView = '';
    return () => { delete root.dataset.dshGameView; };
  }, []);
}

/** 狼人杀角色的主题色（座位光环、气泡、投票线） */
const WOLF_COLORS = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.color]));

const STATUS_LABEL: Record<GameState['status'], string> = { running: '进行中', paused: '暂停中', finished: '已结束', none: '没有游戏' };

/** 画面区里的说明（没有游戏 / 这局在别的对话里） */
function ScreenNote({ title, text, action }: { title: string; text?: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="dg-screen dg-screen-note">
      <b>{title}</b>
      {text && <p>{text}</p>}
      {action && <button className="dg-stop dg-tool" onClick={action.run}>{action.label}</button>}
    </div>
  );
}

export function GameView({ sessionId, events, send, stop, openSession }: GameTabInjected) {
  const entries = useEvents(events);
  const head = useMemo(() => headOf(entries), [entries]);
  const [frameLive, setLive] = useState(false);
  const state = useGameState();
  // 这局属于别的对话：这里不显示它的画面，给一个跳过去的按钮
  const elsewhere = !!(state && state.status !== 'none' && state.owner && sessionId && state.owner !== sessionId);
  const status = state?.status ?? 'none';
  const mine = !elsewhere && status !== 'none';
  // 插件自带的狼人杀：画面区是牌桌，不是游戏推流
  const wolf = useWolf().state;
  const showWolf = mine && state?.game === 'werewolf' && !!wolf;
  const game = state?.title ?? head.game;
  const where = showWolf && wolf ? (wolf.phase === 'end' ? null : `第 ${wolf.day} ${wolf.phase === 'night' ? '夜' : '天'}`) : mine ? head.where : null;
  const [theater, toggleTheater] = useTheater();
  // 「结束这局」点两下才生效（第一下变成「确定结束？」，3 秒内再点一下）
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClose]);
  const closeGame = () => {
    if (!confirmClose) return setConfirmClose(true);
    setConfirmClose(false);
    void fetch('/api/dsh-game/close', { method: 'POST' }).catch(() => {});
  };
  const pause = () => {
    // 停住她这一轮，牌桌也停在下一句话之前；她回来时接着走
    void fetch('/api/dsh-game/pause', { method: 'POST' }).catch(() => {});
    void stop?.().catch(() => {});
  };
  const say = (text: string) => void send?.(text).catch(() => {});
  const screen = useRef<HTMLDivElement>(null);
  const fullscreen = () => void screen.current?.requestFullscreen?.().catch(() => {});
  useDocked();
  useHideComposer();

  let screenBody: React.ReactNode;
  if (elsewhere) {
    screenBody = <ScreenNote title={`这局${state?.title ?? '游戏'}在另一个对话里进行`} text="一次只有一局游戏，它属于开局的那个对话。" action={state?.owner && openSession ? { label: '跳到那个对话', run: () => openSession(state.owner!) } : undefined} />;
  } else if (status === 'none') {
    const closed = state?.closed;
    const text = closed?.note ?? (closed ? `上一局${closed.title}已经结束了。` : '去游戏库选一个游戏，让大肥鱼开始玩。');
    screenBody = <ScreenNote title="没有进行中的游戏" text={text} action={{ label: '打开游戏库', run: () => openLibrary(closed?.game) }} />;
  } else if (showWolf) {
    screenBody = <div className="dg-screen dg-screen-wolf"><WolfTable colors={WOLF_COLORS} /></div>;
  } else if (state?.note) {
    // 画面不在插件里（Minecraft：在摄像机客户端窗口里），给视角切换按钮
    screenBody = <ClientScreen title={state.title ?? '游戏'} note={state.note} perspective={state.perspective ?? null} />;
  } else {
    screenBody = <GameScreen onLive={setLive} />;
  }

  const controls = (
    <>
      <span className="dg-live" data-on={mine && status === 'running' && (showWolf || frameLive) ? '' : undefined} data-status={elsewhere ? 'elsewhere' : status}>
        {elsewhere ? '在别的对话里' : STATUS_LABEL[status]}
      </span>
      <button className="dg-stop dg-tool dg-theater-btn" data-on={theater ? '' : undefined} title={theater ? '回到普通布局（显示 DSH 的标签页和右边的思考终端）' : '收起 DSH 的标题栏和右边的思考终端，游戏画面变大'} onClick={toggleTheater}>{theater ? '◧ 退出影院' : '▭ 影院模式'}</button>
      <button className="dg-stop dg-tool dg-full-btn" title="游戏画面全屏（Esc 退出）" onClick={fullscreen}>⛶ 全屏</button>
      {mine && status === 'running' && <button className="dg-stop" title="她停下，牌桌也停在下一句话之前" onClick={pause}>■ 停止</button>}
      {mine && status === 'paused' && <button className="dg-stop dg-tool" data-on="" title="让她接着玩（会替你跟她说一句「继续玩吧！」）" onClick={() => say('继续玩吧！')}>▶ 继续</button>}
      {mine && status === 'finished' && state?.game === 'werewolf' && <button className="dg-stop dg-tool" onClick={() => openLibrary('werewolf')}>改座位</button>}
      {mine && status === 'finished' && <button className="dg-stop dg-tool" data-on="" onClick={() => say('再来一局吧！')}>↻ 再来一局</button>}
      {mine && <button className="dg-stop" data-confirm={confirmClose ? '' : undefined} title="结束这局游戏（点两下）" onClick={closeGame}>{confirmClose ? '确定结束？' : '✕ 结束这局'}</button>}
    </>
  );

  return (
    <div className="dg-room dg-gametab">
      <Ambient density={0.6} />
      <div className="dg-layout" data-theater={theater ? '' : undefined} data-wolf={showWolf ? '' : undefined} data-noinput={showWolf && wolf.ownerSeat ? '' : undefined}>
        <div className="dg-stage">
          <div className="dg-head">
            <div>
              <span className="dg-game">{game ?? '游戏'}</span>
              {where && <span className="dg-where">{where}</span>}
            </div>
            <div className="dg-head-right">{controls}</div>
          </div>
          <div className="dg-screen-slot" ref={screen}>
            {screenBody}
            {/* 影院模式和全屏时没有标题栏：同样的按钮浮在画面左上角 */}
            <div className="dg-hover-bar">{controls}</div>
          </div>
          {/* 主人也在桌上：她的思考里有她的身份和盘算，这局结束前封起来 */}
          {!theater && (showWolf && wolf.ownerSeat && wolf.phase !== 'end' ? <SealedTerminal /> : <Terminal entries={entries} />)}
          {/* 主人上桌：没有输入栏（这局不能私聊她），行动条在牌桌里，全屏时也能操作 */}
          {!(showWolf && wolf.ownerSeat) && <OwnerInput send={send} />}
        </div>
        <div className="dg-tab-fish"><Fish /></div>
      </div>
    </div>
  );
}

export const GAMETAB_CSS = `
html[data-dsh-game-view] [data-composer-card]{display:none!important}
/* 影院模式：DSH 顶上的会话标题和「对话 / 轨迹 / 游戏」那一排收起来（按标签页的 data 属性认，DSH 改了结构就只是不收，不会坏） */
html[data-dsh-game-view][data-dsh-game-theater] header:has([data-conversation-tabs]){display:none!important}
.dg-gametab{height:100%;overflow:hidden;container-type:size;--gap:14px}
/* 版式变量放在铺满标签的 .dg-layout 上（cq 单位按标签算），版式块和大肥鱼都用它们 */
.dg-layout{position:absolute;inset:0;--side:320px;--head:34px;--head-gap:var(--gap);--input:46px;--input-gap:var(--gap);--pad:24px;
  --fw:min(calc(100cqw - 2 * var(--pad) - var(--side) - var(--gap)), calc((100cqh - 2 * var(--pad) - var(--head) - var(--head-gap) - var(--input) - var(--input-gap)) * 16 / 9));
  --total:calc(var(--fw) + var(--gap) + var(--side))}
/* 版式块在标签里上下左右居中：窗口偏高时上下留白相等 */
.dg-stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;
  grid-template-columns:var(--fw) var(--side);grid-template-rows:var(--head) calc(var(--fw) * 9 / 16) var(--input);gap:var(--gap)}
/* 左列：画面在上、输入栏在下，等宽；右列：终端从画面顶一直到输入栏底 */
.dg-screen-slot{grid-column:1;grid-row:2;display:flex;min-width:0;min-height:0;position:relative}
/* 浮在画面左上角的按钮：只在影院模式和全屏时有；鼠标移到画面上才看得清（底部留给对白框和行动条） */
.dg-hover-bar{display:none;position:absolute;left:10px;top:10px;z-index:20;align-items:center;gap:8px;padding:5px 8px;border-radius:10px;
  background:rgba(4,6,16,.72);border:1px solid var(--dg-line);backdrop-filter:blur(6px);opacity:.35;transition:opacity .25s}
.dg-screen-slot:hover .dg-hover-bar,.dg-hover-bar:focus-within{opacity:1}
.dg-layout[data-theater] .dg-hover-bar,.dg-screen-slot:fullscreen .dg-hover-bar{display:flex}
.dg-screen-slot:fullscreen .dg-theater-btn,.dg-screen-slot:fullscreen .dg-full-btn{display:none}
/* 狼人杀左上角的存活人数让到按钮下面 */
.dg-layout[data-theater] .wt-hud-left,.dg-screen-slot:fullscreen .wt-hud-left{margin-top:40px}
.dg-hover-bar .dg-live{font-size:10px}
.dg-screen-slot > .dg-screen{flex:1}
.dg-client-views{display:flex;gap:6px;margin-top:10px}
.dg-client-views .on{background:rgba(120,150,255,.85);color:#fff;border-color:transparent}
.dg-client-error{color:#ff9aa8}
/* 全屏：画面铺满屏幕，游戏推流的画面按比例放，不拉伸 */
.dg-screen-slot:fullscreen{background:#000}
.dg-screen-slot:fullscreen > .dg-screen{border-radius:0;border:0}
.dg-screen-slot:fullscreen img{object-fit:contain}
/* 影院模式：没有右列，画面按整个标签的宽度算 */
/* 影院模式：没有标题栏那一行（按钮浮在画面上），留白也收窄 */
.dg-layout[data-theater]{--side:0px;--head:0px;--head-gap:0px;--pad:10px;--fw:min(calc(100cqw - 2 * var(--pad)), calc((100cqh - 2 * var(--pad) - var(--head) - var(--head-gap) - var(--input) - var(--input-gap)) * 16 / 9));--total:var(--fw)}
.dg-layout[data-theater] .dg-head{display:none}
.dg-layout[data-theater] .dg-stage{row-gap:0}
.dg-layout[data-theater] .dg-input{margin-top:var(--input-gap)}
/* 主人上桌：没有输入栏那一行，画面往下长 */
.dg-layout[data-noinput]{--input:0px;--input-gap:0px}
.dg-layout[data-noinput] .dg-stage{grid-template-rows:var(--head) calc(var(--fw) * 9 / 16)}
.dg-layout[data-noinput] .dg-term{grid-row:2}
.dg-layout[data-theater] .dg-stage{grid-template-columns:var(--fw)}
.dg-layout[data-theater] .dg-head{grid-column:1}
.dg-layout[data-wolf] .dg-tab-fish .dg-bubble{display:none}
.dg-layout[data-theater] .dg-tab-fish{width:130px;right:max(4px,calc((100cqw - var(--fw)) / 2 - 140px))}
.dg-term{grid-column:2;grid-row:2 / 4}
.dg-input{grid-column:1;grid-row:3}
.dg-head{grid-column:1 / 3;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 4px;border-bottom:1px solid var(--dg-line)}
.dg-game{font-size:15px;font-weight:500;color:#eef4ff;letter-spacing:1px}
.dg-where{font:12px var(--dg-mono);color:var(--dg-dim);margin-left:12px}
.dg-head > div:first-child{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dg-head-right{flex:none}
.dg-head-right button{white-space:nowrap}
.dg-head-right{display:flex;align-items:center;gap:14px}
.dg-live{font:11px var(--dg-mono);color:var(--dg-faint);letter-spacing:.8px;display:flex;align-items:center;gap:7px}
.dg-live::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--dg-faint)}
.dg-live[data-on]{color:#cdeeff}
.dg-live[data-on]::before{background:var(--dg-mint);box-shadow:0 0 8px var(--dg-mint)}
.dg-live[data-status=paused]{color:#ffd08a}
.dg-live[data-status=paused]::before{background:#ffb35c}
.dg-live[data-status=finished]{color:#c9d4f0}
.dg-live[data-status=elsewhere]{color:#9fb6ec}
.dg-stop[data-confirm]{color:#ffc2cb;border-color:rgba(255,150,170,.6);box-shadow:0 0 14px -5px rgba(255,140,165,.7)}
.dg-screen-gallery{position:relative;background:#dfe4ec}
.dg-screen .dg-gallery-main{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.dg-gallery-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:10px;padding:6px 10px;font-size:12px;color:#c9d4f0;background:linear-gradient(180deg,rgba(6,10,22,.85),rgba(6,10,22,0))}
.dg-gallery-top > span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dg-gallery-top b{color:#fff;font-weight:500}
.dg-gallery-top .dg-client-views{margin:0 0 0 auto;flex:none}
.dg-gallery-top .dg-client-views button{padding:2px 7px}
.dg-gallery-hint{font:10px var(--dg-mono);color:#9fb0d0;white-space:nowrap}
@container (max-width:520px){.dg-gallery-hint{display:none}}
.dg-gallery-strip{position:absolute;left:0;right:0;bottom:0;display:flex;gap:5px;padding:14px 8px 6px;overflow-x:auto;background:linear-gradient(0deg,rgba(6,10,22,.75),rgba(6,10,22,0))}
.dg-gallery-strip button{flex:none;width:40px;height:40px;padding:0;border-radius:5px;border:1px solid rgba(255,255,255,.35);background:#dfe4ec;cursor:pointer;overflow:hidden;opacity:.75}
.dg-gallery-strip button.on{opacity:1;border-color:rgba(134,220,255,.95);box-shadow:0 0 10px -2px rgba(134,220,255,.9)}
.dg-screen .dg-gallery-strip img{width:100%;height:100%;object-fit:cover}
.dg-screen-note{flex-direction:column;gap:10px;padding:24px;text-align:center;background:radial-gradient(60% 60% at 50% 40%,#0d1836,#04060d)}
.dg-screen-note b{font-size:16px;font-weight:500;color:#e8f0ff;letter-spacing:1px}
.dg-screen-note p{margin:0;max-width:440px;font-size:13px;line-height:1.7;color:var(--dg-dim)}
.dg-stop{font:11px var(--dg-mono);letter-spacing:.6px;color:var(--dg-dim);background:transparent;border:1px solid var(--dg-line);border-radius:7px;padding:4px 9px;cursor:pointer;transition:all .15s}
.dg-stop:hover{color:#ffc2cb;border-color:rgba(255,150,170,.45);box-shadow:0 0 14px -5px rgba(255,140,165,.6)}
.dg-stop[data-on]{color:#cdeeff;border-color:rgba(134,220,255,.45)}
.dg-tool:hover{color:#cdeeff;border-color:rgba(134,220,255,.5);box-shadow:0 0 14px -5px rgba(134,220,255,.6)}
.dg-screen{border-radius:12px;overflow:hidden;border:1px solid var(--dg-line);background:#000;display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 50px -16px rgba(134,220,255,.5)}
.dg-screen img{width:100%;height:100%;display:block}
.dg-screen-wolf{background:#04060d;align-items:stretch;justify-content:stretch}
.dg-idle{font:13px var(--dg-mono);color:var(--dg-faint)}
/* 终端：输入行在最上，记录最新的在前；越往下越淡（大肥鱼站在下面） */
.dg-term{position:relative;border-radius:12px;border:1px solid var(--dg-line);background:var(--dg-glass);display:flex;flex-direction:column;min-height:0;overflow:hidden;
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%)}
.dg-term-bar{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid var(--dg-line);font:11px var(--dg-mono);color:var(--dg-dim);letter-spacing:.6px}
.dg-term-bar b{color:var(--dg-cyan);font-weight:400}
.dg-term-dots{display:flex;gap:5px}.dg-term-dots i{width:7px;height:7px;border-radius:50%;background:var(--dg-faint)}
/* 输入栏：毛玻璃，和画面等宽；聚焦时边线亮起 */
.dg-input{display:flex;align-items:center;gap:12px;padding:0 8px 0 16px;border-radius:12px;border:1px solid var(--dg-line);background:var(--dg-glass);
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);transition:border-color .15s,box-shadow .15s;cursor:text}
.dg-input:focus-within{border-color:var(--dg-line-hi);box-shadow:0 0 20px -8px rgba(134,220,255,.7)}
.dg-input-who{font:12px var(--dg-mono);color:#e7c98a;flex:none}
.dg-sealed{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center;color:var(--dg-dim);font-size:13px;line-height:1.6}
.dg-sealed b{font-size:15px;color:#f3dca6;letter-spacing:1px}
.dg-sealed p{margin:0}
.dg-owner[data-turn]{border-color:rgba(231,201,138,.75);box-shadow:0 0 22px -6px rgba(255,210,120,.7);animation:dg-turn 1.8s ease-in-out infinite}
@keyframes dg-turn{50%{box-shadow:0 0 30px -4px rgba(255,210,120,.9)}}
.dg-ops{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none}

.dg-input input{flex:1;min-width:0;height:100%;background:transparent;border:none;outline:none;color:var(--dg-ink);font-size:14px}
.dg-input input::placeholder{color:var(--dg-faint)}
.dg-send{flex:none;font:12px var(--dg-mono);color:#bfeaff;background:rgba(134,220,255,.06);border:1px solid rgba(134,220,255,.3);border-radius:8px;padding:6px 12px;cursor:pointer;transition:all .15s}
.dg-send:hover:not(:disabled){background:rgba(134,220,255,.12);border-color:rgba(134,220,255,.6);box-shadow:0 0 14px -4px rgba(134,220,255,.55)}
.dg-send:disabled{opacity:.35;cursor:default}
.dg-feed{flex:1;min-height:0;overflow:hidden;padding:8px 12px;font:12px/1.65 var(--dg-mono);
  -webkit-mask-image:linear-gradient(#000 45%,transparent 94%);mask-image:linear-gradient(#000 45%,transparent 94%)}
.dg-ln{display:grid;grid-template-columns:40px 1fr;gap:8px;margin-bottom:3px;word-break:break-word}
.dg-ln time{color:var(--dg-faint)}
.dg-ln-t{color:var(--dg-dim)}
.dg-ln-k{color:var(--dg-faint);margin-right:6px;font-style:normal}
.dg-ln-moment .dg-ln-t{color:var(--dg-cyan)}
.dg-ln-act .dg-ln-t{color:var(--dg-mint)}
.dg-ln-think .dg-ln-t{color:#6f82a6;font-style:italic}
.dg-ln-say .dg-ln-t,.dg-ln-chat .dg-ln-t{color:#eaf3ff}
.dg-ln-owner .dg-ln-t{color:#e7c98a}
.dg-ln-note .dg-ln-t{color:var(--dg-faint)}
.dg-ln-shell .dg-ln-k{color:var(--dg-mint)}
.dg-ln-shell .dg-ln-t{color:#eaf3ff}
.dg-ln-out .dg-ln-t{color:#ffb4c2;text-shadow:0 0 10px rgba(255,120,150,.45)}
.dg-cursor{display:inline-block;width:7px;height:13px;margin-left:3px;background:var(--dg-cyan);vertical-align:-2px;box-shadow:0 0 8px var(--dg-cyan);animation:dg-blink 1s steps(1) infinite}
@keyframes dg-blink{50%{opacity:0}}
/* 大肥鱼：右边和终端右边缘对齐，脚踩在标签底部 */
.dg-tab-fish{position:absolute;right:calc((100cqw - var(--total)) / 2 - 6px);bottom:10px;width:170px;z-index:6;pointer-events:none}
`;
