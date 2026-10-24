/**
 * 游戏库：侧栏「游戏」入口打开的页面。列出能玩的游戏；点「让大肥鱼玩」就开一个会话——
 * 用「大肥鱼玩游戏」预设、打开就停在「游戏」标签、替主人说第一句「去玩……吧！」。
 * 用到的都是 DSH 网页端的公开服务（sessions.create / uiWorkspace.openSession / remote.agentPresets / layout），
 * 只有「打开时停在哪个标签」借用了 ui-conversation 按会话存的选择（localStorage 的 dsh.conversation.<会话>）。
 */

import React, { useEffect, useState } from 'react';
import { Ambient } from './ambient.js';
import { clipUrl } from './stage.js';
import { WolfSetupPanel, type SetupCheck } from './wolfsetup.js';
import { McSetupPanel, type McSetupCheck } from './mcsetup.js';

export const PANEL_ID = 'dsh-game';
/** cordis.patch.yml 里插入的预设 */
const PRESET_ID = 'dsh-game';
/** client.tsx 注册的「游戏」标签 */
const GAME_VIEW = 'dsh-game';

interface LibraryEntry {
  id: string;
  name: string;
  subtitle: string;
  tags: string[];
  blurb: string;
  installed: boolean;
  getUrl: string;
  savedAt: string | null;
  /** 插件自带的游戏（不用安装） */
  builtin?: boolean;
  /** 插件自己带美术（封面里画了大肥鱼） */
  localArt?: Record<string, string>;
}

interface RemoteResult {
  ok: boolean;
  error?: { message: string };
}

/** 游戏库用到的 DSH 网页端服务 */
export interface LibraryServices {
  workspaces: { list: { getSnapshot(): { items: readonly { workspaceId: string }[] } } };
  uiWorkspace: { openSession(sessionId: string): void };
  sessions: {
    create(opts: { workspaceId: string }): Promise<string>;
    using<T>(target: string, options: { source: string }, operation: (reference: { ready: Promise<{ session: any }> }) => T | Promise<T>): Promise<T>;
  };
  remote: { agentPresets: { select(sessionId: string, presetId: string): Promise<RemoteResult> } };
  layout: { selectPanel(panelId: string | null): void };
}

let services: LibraryServices | null = null;

export function bindLibrary(ctx: LibraryServices): void {
  services = ctx;
}

/** 下次打开游戏库时选中哪个游戏（游戏画面里的「改座位」跳回来时用） */
let preselect: string | null = null;

/** 打开游戏库并选中一个游戏 */
export function openLibrary(gameId?: string): void {
  if (gameId) preselect = gameId;
  services?.layout.selectPanel(PANEL_ID);
}

/** 开一个会话让她玩这个游戏 */
async function play(entry: LibraryEntry): Promise<void> {
  const ctx = services;
  if (!ctx) throw new Error('插件还没准备好，刷新一下页面再试。');
  const workspace = ctx.workspaces.list.getSnapshot().items[0];
  if (!workspace) throw new Error('先在 DSH 里打开一个工作区。');
  // 新建一个会话（不复用已有的空白会话）：DSH 打开会话时才读它存的标签选择，
  // 已经打开过的空白会话早就读过了，提前写进去的「游戏」不会生效
  const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
  try {
    localStorage.setItem(`dsh.conversation.${sessionId}`, JSON.stringify({ draft: '', view: GAME_VIEW, viewRequest: null }));
  } catch {
    // 存不了就停在对话标签，不影响玩
  }
  ctx.uiWorkspace.openSession(sessionId);
  ctx.layout.selectPanel(null);
  const selected = await ctx.remote.agentPresets.select(sessionId, PRESET_ID);
  if (!selected.ok) throw new Error(selected.error?.message ?? '没能用上「大肥鱼玩游戏」预设。');
  const text = entry.savedAt ? `继续玩${entry.name}吧！` : `去玩${entry.name}吧！`;
  await ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
    const { session } = await reference.ready;
    const handle = session.beginSubmission({ mode: 'queue', text, attachments: [] });
    const result: RemoteResult = await session.prompt([{ type: 'text', text }], 'queue', undefined, handle.requestId);
    if (!result.ok) throw new Error(result.error?.message ?? '没发出去。');
  });
}

const two = (n: number) => String(n).padStart(2, '0');
const savedLabel = (iso: string) => {
  const d = new Date(iso);
  return `存档 · ${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const art = (entry: LibraryEntry, kind: 'capsule' | 'hero' | 'logo') => `/api/dsh-game/art?game=${entry.id}&kind=${kind}`;
const statusOf = (entry: LibraryEntry) => (entry.builtin ? '插件自带 · 每局重新发牌' : entry.installed ? (entry.savedAt ? savedLabel(entry.savedAt) : '已安装 · 还没玩过') : '这台电脑上没找到');

export const LIBRARY_CSS = `
.dg-lib-room{height:100%;overflow:hidden}
/* 整页背景：当前游戏的横幅大图，重度模糊、压暗，只透出一点颜色（毛玻璃后面要有东西可透） */
.dg-lib-backdrop{position:absolute;inset:-60px;z-index:-2;background-size:cover;background-position:center;filter:blur(80px) saturate(140%) brightness(.5);opacity:.32;transition:background-image .4s}
.dg-lib{position:relative;height:100%;overflow:auto;padding:28px clamp(24px,4vw,56px) 48px;box-sizing:border-box}
.dg-lib-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.dg-path{font:12px var(--dg-mono);color:var(--dg-faint);letter-spacing:.4px}
.dg-path b{color:var(--dg-cyan);font-weight:400}
.dg-lib-hint{font-size:12px;color:var(--dg-dim)}
/* 横幅：当前选中的游戏。大图按自己的宽高比跟着宽度走；信息栏是压在大图下沿的一条毛玻璃，高度跟着内容走（任何缩放都不会裁掉） */
.dg-hero{position:relative;isolation:isolate;container-type:inline-size;border-radius:22px;padding-bottom:16px;background:rgba(8,14,32,.4);border:1px solid rgba(255,255,255,.12);
  box-shadow:0 34px 80px -28px rgba(0,0,0,.75),inset 0 1px 0 rgba(255,255,255,.08)}
.dg-hero-art{position:relative;width:100%;aspect-ratio:3840 / 1240;max-height:320px;border-radius:21px 21px 0 0;overflow:hidden;background-size:cover;background-position:center}
.dg-hero-art::after{content:'';position:absolute;inset:0;background:linear-gradient(0deg,rgba(8,14,32,.9) 0%,rgba(8,14,32,.25) 38%,transparent 60%)}
.dg-hero-logo{position:absolute;left:28px;bottom:72px;z-index:1;max-width:28%;max-height:44%;filter:drop-shadow(0 8px 22px rgba(0,0,0,.5))}
.dg-hero-fish{position:absolute;right:26px;bottom:48px;z-index:1;height:72%;pointer-events:none;filter:drop-shadow(0 10px 26px rgba(0,0,0,.5))}
.dg-hero-bar{position:relative;z-index:2;margin:-58px 16px 0;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 20px;border-radius:16px;
  background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.2);
  backdrop-filter:blur(22px) saturate(170%);-webkit-backdrop-filter:blur(22px) saturate(170%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 20px 50px -20px rgba(0,0,0,.6)}
.dg-hero-text{flex:1;min-width:0}
.dg-hero-text h1{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:19px;font-weight:600;margin:0;color:#f3f7ff;letter-spacing:1px}
.dg-hero-text h1 small{font:12px var(--dg-mono);font-weight:400;color:rgba(220,232,255,.6);letter-spacing:.3px}
.dg-hero-text p{margin:6px 0 0;font-size:13px;line-height:1.7;color:rgba(226,236,255,.82);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dg-hero-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.dg-tags{display:flex;gap:6px;flex-wrap:wrap}
.dg-tag{font:11px var(--dg-mono);color:rgba(226,236,255,.75);border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);border-radius:6px;padding:2px 7px}
.dg-hero-actions{display:flex;align-items:center;gap:12px}
.dg-btn-primary{font-size:14px;padding:11px 18px;color:#eaf9ff;background:rgba(134,220,255,.16);border-color:rgba(134,220,255,.6);
  box-shadow:0 0 22px -8px rgba(134,220,255,.8),inset 0 1px 0 rgba(255,255,255,.18)}
.dg-btn-primary:hover{background:rgba(134,220,255,.26);box-shadow:0 0 30px -6px rgba(134,220,255,.9),inset 0 1px 0 rgba(255,255,255,.25)}
.dg-meta{font:11px var(--dg-mono);color:rgba(220,232,255,.6)}
/* 窄的时候信息栏上下排 */
@container (max-width: 760px){.dg-hero-bar{flex-direction:column;align-items:stretch}.dg-hero-side{align-items:flex-start}}
/* 游戏架：竖版封面，一排放得下几个就放几个，多了往下排 */
.dg-section{display:flex;align-items:center;gap:10px;font:12px var(--dg-mono);color:var(--dg-dim);letter-spacing:.6px;margin:30px 0 16px}
.dg-section::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--dg-line),transparent)}
.dg-section span{color:var(--dg-faint)}
.dg-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,180px));gap:24px 22px}
.dg-capsule{position:relative;aspect-ratio:2 / 3;padding:0;border-radius:16px;border:1px solid rgba(255,255,255,.16);cursor:pointer;overflow:hidden;
  background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.03));backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);
  box-shadow:0 16px 36px -14px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.14);transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,border-color .25s}
.dg-capsule img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
/* 掠过的一道反光：鼠标移上去时从左扫到右 */
.dg-capsule::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.22) 48%,transparent 60%);transform:translateX(-120%);transition:transform .8s ease}
.dg-capsule:hover{transform:translateY(-8px);border-color:rgba(134,220,255,.45);box-shadow:0 30px 56px -18px rgba(0,0,0,.8),0 0 30px -8px rgba(134,220,255,.55),inset 0 1px 0 rgba(255,255,255,.2)}
.dg-capsule:hover::after{transform:translateX(120%)}
.dg-capsule[data-selected]{border-color:rgba(134,220,255,.75);box-shadow:0 0 0 1px rgba(134,220,255,.5),0 22px 48px -16px rgba(0,0,0,.75),0 0 34px -6px rgba(134,220,255,.6)}
.dg-capsule-info{position:absolute;left:8px;right:8px;bottom:8px;display:flex;flex-direction:column;gap:3px;text-align:left;padding:8px 10px;border-radius:11px;
  background:rgba(8,14,32,.5);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%)}
.dg-capsule-info b{font-size:13px;font-weight:500;color:#f1f6ff}
.dg-state{font:10px var(--dg-mono);color:rgba(220,232,255,.6);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dg-state::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dg-faint)}
.dg-state[data-on]::before{background:var(--dg-mint);box-shadow:0 0 8px var(--dg-mint)}
.dg-capsule-soon{cursor:default;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-style:dashed;border-color:rgba(134,220,255,.3);
  color:#d4e2ff;font-size:15px;letter-spacing:2px;background:radial-gradient(circle at 50% 38%,rgba(134,220,255,.16),transparent 60%),linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.02))}
.dg-capsule-soon:hover{transform:none;border-color:rgba(255,255,255,.16);box-shadow:0 16px 36px -14px rgba(0,0,0,.7)}
.dg-capsule-soon small{font:11px var(--dg-mono);color:var(--dg-dim);letter-spacing:.4px}
.dg-capsule-soon svg{width:34px;height:34px;color:var(--dg-cyan);opacity:.85;filter:drop-shadow(0 0 10px rgba(134,220,255,.6))}
.dg-lib-error{margin-top:16px;font:12px var(--dg-mono);color:#ff9aa8}
.dg-btn-primary:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.dg-hero-blocked{font-size:11px;color:#ffb3bf}
`;

/** blocked：现在开不了（比如狼人杀的开局设置有问题），按钮不能点，写出原因 */
function Hero({ entry, busy, blocked, onPlay }: { entry: LibraryEntry; busy: boolean; blocked?: string | null; onPlay: () => void }) {
  const [logo, setLogo] = useState(true);
  useEffect(() => setLogo(true), [entry.id]);
  return (
    <section className="dg-hero">
      <div className="dg-hero-art" style={{ backgroundImage: `url(${art(entry, 'hero')})` }}>
        {logo && <img className="dg-hero-logo" src={art(entry, 'logo')} alt="" onError={() => setLogo(false)} />}
        {/* 插件自己带美术的游戏（狼人杀、Minecraft）：封面里本来就有大肥鱼 */}
        {!entry.localArt && <video className="dg-hero-fish" src={clipUrl('riceloop')} muted autoPlay loop playsInline />}
      </div>
      <div className="dg-hero-bar">
        <div className="dg-hero-text">
          <h1>{entry.name}<small>{entry.subtitle}</small></h1>
          <p>{entry.blurb}</p>
        </div>
        <div className="dg-hero-side">
          <div className="dg-tags">{entry.tags.map((t) => <span className="dg-tag" key={t}>{t}</span>)}</div>
          <div className="dg-hero-actions">
            <span className="dg-meta">{statusOf(entry)}</span>
            {entry.installed
              ? (
                <button className="dg-btn dg-btn-primary" aria-busy={busy} disabled={!!blocked} title={blocked ?? undefined} onClick={onPlay}>
                  ▶ {entry.savedAt ? '让大肥鱼继续玩' : '让大肥鱼玩'}
                </button>
              )
              : <a className="dg-btn dg-btn-primary" href={entry.getUrl} target="_blank" rel="noreferrer">↗ Steam 免费领取</a>}
          </div>
          {blocked && <span className="dg-hero-blocked">{blocked}</span>}
        </div>
      </div>
    </section>
  );
}

export function GameLibrary() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    const id = preselect;
    preselect = null;
    return id;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 狼人杀的开局设置检查结果（选中狼人杀时面板给的）
  const [wolfCheck, setWolfCheck] = useState<SetupCheck | null>(null);
  // Minecraft 的开局设置检查结果（选中 Minecraft 时面板给的）
  const [mcCheck, setMcCheck] = useState<McSetupCheck | null>(null);

  useEffect(() => {
    fetch('/api/dsh-game/library').then((r) => r.json()).then(setEntries).catch(() => setEntries([]));
  }, []);

  const current = entries?.find((e) => e.id === selected) ?? entries?.[0];

  const start = async (entry: LibraryEntry) => {
    if (busy) return;
    setBusy(entry.id);
    setError(null);
    try {
      await play(entry);
    } catch (err) {
      // 页面可能已经切到会话了，这里的提示看不到：控制台也留一份
      console.error('dsh-game: 开始游戏失败', err);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dg-room dg-lib-room">
      {current && <div className="dg-lib-backdrop" style={{ backgroundImage: `url(${art(current, 'hero')})` }} />}
      <Ambient density={0.5} />
      <div className="dg-lib">
        <div className="dg-lib-top">
          <span className="dg-path">~/dsh-game/<b>library</b></span>
          <span className="dg-lib-hint">选一个游戏，大肥鱼自己玩，你在旁边看；想跟她说话，就在游戏画面下面的输入栏里说</span>
        </div>
        {current && (
          <Hero
            entry={current}
            busy={busy === current.id}
            blocked={current.id === 'werewolf'
              ? (wolfCheck ? (wolfCheck.problem ? '开局设置有问题，见下面' : null) : '正在检查开局设置……')
              : current.id === 'minecraft'
                ? (mcCheck ? (mcCheck.problem ? '开局设置有问题，见下面' : null) : '正在检查服务器和客户端……')
                : null}
            onPlay={() => void start(current)}
          />
        )}
        {current?.id === 'werewolf' && <WolfSetupPanel onCheck={setWolfCheck} />}
        {current?.id === 'minecraft' && <McSetupPanel onCheck={setMcCheck} />}
        <div className="dg-section">游戏库 <span>{entries ? entries.length : '…'}</span></div>
        <div className="dg-shelf">
          {entries?.map((entry) => (
            <button className="dg-capsule" key={entry.id} data-selected={entry.id === current?.id ? '' : undefined} onClick={() => setSelected(entry.id)}>
              <img src={art(entry, 'capsule')} alt="" />
              <span className="dg-capsule-info">
                <b>{entry.name}</b>
                <span className="dg-state" data-on={entry.installed ? '' : undefined}>{entry.builtin ? '插件自带' : entry.installed ? (entry.savedAt ? '有存档' : '已安装') : '未安装'}</span>
              </span>
            </button>
          ))}
          <div className="dg-capsule dg-capsule-soon">
            <GamepadIcon />
            更多游戏
            <small>骗子酒馆 · 制作中</small>
          </div>
        </div>
        {error && <div className="dg-lib-error">! {error}</div>}
      </div>
    </div>
  );
}

/** 侧栏「游戏」入口的图标 */
export function GamepadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8h10a5 5 0 0 1 4.6 7l-.7 1.6a2.5 2.5 0 0 1-4.2.6L15 15H9l-1.7 2.2a2.5 2.5 0 0 1-4.2-.6L2.4 15A5 5 0 0 1 7 8z" />
      <path d="M8 11v3M6.5 12.5h3M16 12h.01M18 13.5h.01" />
    </svg>
  );
}
