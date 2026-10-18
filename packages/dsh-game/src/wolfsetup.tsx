/**
 * 狼人杀的开局设置（游戏库里选中狼人杀时，横幅下面）：谁上桌、每个座位由谁驱动。做成游戏里的「入座」界面：
 *   - 每个座位一张角色卡：点头像让她上桌 / 离席；卡下面一个 ◀ ▶ 选择器换驱动（默认模型 / DSH 里配好的模型 / Codex / 不上桌）
 *   - 卡下面写着这个座位能不能用（模型 DSH 里有没有、Codex 装没装、登没登录）
 *   - 改了马上存（宿主 /api/dsh-game/wolf-setup），存完重新检查；有问题时「让大肥鱼玩」按钮不能点，并写出原因
 * 设置和检查都在宿主（games/werewolf/setup.ts），这里只显示和改。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ModelOption { id: string; provider: string; providerName: string; name: string }
interface SeatCheck { ok: boolean; label: string; problem?: string }
export interface SetupCheck {
  setup: { defaultModel: string; seats: Record<string, string>; owner?: boolean };
  characters: { id: string; name: string; color: string }[];
  models: ModelOption[] | null;
  codex: { installed: boolean; loggedIn: boolean; detail: string };
  seats: Record<string, SeatCheck>;
  players: number;
  board: string | null;
  problem: string | null;
  /** 狼人杀的角色和法官念得出来吗（配了豆包新版的 API Key） */
  voiced?: boolean;
}

const SELF_ID = 'deepseek';
/** 主人自己的座位：点头像上桌 / 离席，没有驱动可选 */
const OWNER_ID = 'owner';
const portrait = (id: string) => `/api/dsh-game/asset?path=werewolf/${id}.jpg`;
const shortName = (model: string) => model.split('/').pop() ?? model;

async function request(body?: SetupCheck['setup']): Promise<SetupCheck> {
  const res = await fetch('/api/dsh-game/wolf-setup', body
    ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as SetupCheck;
}

interface Choice { value: string; label: string; sub: string }

/** 一个座位能选的驱动：默认模型、DSH 里的模型、Codex、不上桌（当前值不在里面也放进去，标出来） */
function seatChoices(check: SetupCheck, current: string): Choice[] {
  const { models, codex, setup } = check;
  const list: Choice[] = [{ value: 'default', label: '默认模型', sub: shortName(setup.defaultModel) }];
  if (current.includes('/') && !(models ?? []).some((m) => m.id === current)) list.push({ value: current, label: shortName(current), sub: 'DSH 里没找到' });
  for (const m of models ?? []) list.push({ value: m.id, label: m.name, sub: m.providerName });
  list.push({ value: 'codex', label: 'Codex', sub: codex.loggedIn ? '你的 ChatGPT 订阅' : '还不能用' });
  if (current === 'claude-code') list.push({ value: 'claude-code', label: 'Claude Code', sub: '你的 Claude 订阅' });
  list.push({ value: 'off', label: '不上桌', sub: '这局不参加' });
  return list;
}

function modelChoices(check: SetupCheck): Choice[] {
  const { models, setup } = check;
  const list: Choice[] = (models ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.providerName }));
  if (!list.some((c) => c.value === setup.defaultModel)) list.unshift({ value: setup.defaultModel, label: shortName(setup.defaultModel), sub: 'DSH 里没找到' });
  return list;
}

/** 鼠标在选择器上停这么久，滚轮才用来切换（只是划过去时滚轮照常滚页面） */
const WHEEL_ARM_MS = 350;

/**
 * 游戏里常见的左右切换选择器：◀ 当前项 ▶。
 *   - 底边一条细轨，亮的那一段是当前项的位置（一共几项、在第几项一眼看得出）
 *   - 鼠标停在上面后滚轮上下切换
 *   - 点中间展开全部选项，点一项选中（Esc 或点别处收起）
 */
function Picker({ choices, value, disabled, label, onChange }: { choices: Choice[]; value: string; disabled: boolean; label: string; onChange: (value: string) => void }) {
  const index = Math.max(0, choices.findIndex((c) => c.value === value));
  const current = choices[index];
  const count = choices.length;
  const off = disabled || count < 2;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const step = useRef<(d: number) => void>(() => {});
  step.current = (d: number) => { if (!off) onChange(choices[(index + d + count) % count].value); };

  // 滚轮：停稳了才接管；触控板一次滚动会来很多下，攒够一格才切一项
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acc = 0;
    const enter = () => { timer = setTimeout(() => { armed = true; }, WHEEL_ARM_MS); };
    const leave = () => { clearTimeout(timer); armed = false; acc = 0; };
    const wheel = (e: WheelEvent) => {
      if (!armed || (e.target as HTMLElement).closest('.dg-pick-list')) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      step.current(acc > 0 ? 1 : -1);
      acc = 0;
    };
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  // 展开的列表：点别处、按 Esc 收起；打开时把当前项滚到眼前
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    root.current?.querySelector('.dg-pick-item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="dg-pick" ref={root} role="group" aria-label={label} data-open={open ? '' : undefined} data-off={off ? '' : undefined}
      title={off ? undefined : `${index + 1} / ${count} · 滚轮切换 · 点中间看全部`}>
      <button type="button" className="dg-pick-arrow" disabled={off} aria-label="上一个" onClick={() => step.current(-1)}>◀</button>
      <button type="button" className="dg-pick-value" disabled={off} aria-live="polite" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <b>{current?.label}</b>
        <small>{current?.sub}</small>
      </button>
      <button type="button" className="dg-pick-arrow" disabled={off} aria-label="下一个" onClick={() => step.current(1)}>▶</button>
      {count > 1 && <i className="dg-pick-track" style={{ '--n': count, '--i': index } as React.CSSProperties} />}
      {open && (
        <div className="dg-pick-list" role="listbox" aria-label={label}>
          {choices.map((c, i) => (
            <button
              type="button"
              key={c.value}
              className="dg-pick-item"
              role="option"
              aria-selected={i === index}
              onClick={() => { onChange(c.value); setOpen(false); }}
            >
              <b>{c.label}</b>
              <small>{c.sub}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WolfSetupPanel({ onCheck }: { onCheck: (check: SetupCheck | null) => void }) {
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(async (body?: SetupCheck['setup']) => {
    setBusy(true);
    setError(null);
    try {
      const next = await request(body);
      setCheck(next);
      onCheck(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onCheck]);

  useEffect(() => {
    void apply();
    return () => onCheck(null);
  }, [apply, onCheck]);

  if (!check) return <section className="dg-ws"><div className="dg-ws-loading">{error ? `! 读不到开局设置：${error}` : '正在读开局设置……'}</div></section>;

  const { setup, codex } = check;
  const change = (patch: Partial<SetupCheck['setup']>) => void apply({ ...setup, ...patch, seats: { ...setup.seats, ...patch.seats } });
  const defaultOk = !check.models || check.models.some((m) => m.id === setup.defaultModel);

  return (
    <section className="dg-ws" aria-busy={busy}>
      <header className="dg-ws-head">
        <div className="dg-ws-title">
          <span className="dg-ws-orn" />
          <h2>入座</h2>
          <p>选谁上桌、每个座位由哪个 AI 来想。点头像让她上桌或离席，◀ ▶ 换驱动。改了马上保存。</p>
        </div>
        <div className="dg-ws-crest" data-bad={check.problem ? '' : undefined}>
          <b>{check.players}</b>
          <span>人局</span>
        </div>
      </header>
      <div className="dg-ws-board" data-bad={check.problem ? '' : undefined}>{check.board ?? '人数不对：6 到 10 人才能开局'}</div>

      <div className="dg-ws-default">
        <span className="dg-ws-label">默认模型</span>
        <Picker choices={modelChoices(check)} value={setup.defaultModel} disabled={busy} label="默认模型" onChange={(v) => change({ defaultModel: v })} />
        <span className="dg-ws-note" data-bad={defaultOk ? undefined : ''}>{defaultOk ? '选了「默认模型」的座位都用它' : 'DSH 里没有这个模型，换一个'}</span>
      </div>

      <div className="dg-ws-grid">
        {check.characters.map((c) => {
          const self = c.id === SELF_ID;
          const owner = c.id === OWNER_ID;
          const how = setup.seats[c.id] ?? 'default';
          const seat = check.seats[c.id];
          const off = owner ? !setup.owner : how === 'off';
          // 点头像：上桌 ↔ 离席
          const toggle = () => {
            if (self || busy) return;
            if (owner) change({ owner: !setup.owner });
            else change({ seats: { [c.id]: off ? 'default' : 'off' } });
          };
          return (
            <div className="dg-ws-seat" key={c.id} style={{ '--c': c.color } as React.CSSProperties} data-off={off ? '' : undefined} data-bad={seat?.ok ? undefined : ''}>
              <button type="button" className="dg-ws-card" disabled={self || busy} onClick={toggle} aria-label={self ? c.name : owner ? (off ? '你自己上桌' : '你离席') : `${c.name}：${off ? '让她上桌' : '让她离席'}`}>
                <img src={portrait(c.id)} alt="" draggable={false} />
                <span className="dg-ws-name">{c.name}</span>
                {off && <span className="dg-ws-stamp">离席</span>}
                {self && <span className="dg-ws-host">主播</span>}
                {owner && !off && <span className="dg-ws-host">你</span>}
              </button>
              {self
                ? <div className="dg-ws-fixed"><b>大肥鱼本人</b><small>每局都在</small></div>
                : owner
                ? <div className="dg-ws-fixed"><b>{off ? '点头像上桌' : '你自己'}</b><small>{off ? '和她们一起玩' : '主人视角'}</small></div>
                : <Picker choices={seatChoices(check, how)} value={how} disabled={busy} label={`${c.name} 由谁驱动`} onChange={(v) => change({ seats: { [c.id]: v } })} />}
              <small className="dg-ws-status">{self ? '她自己做决定' : owner ? (off ? '这局只看不玩' : '✓ 轮到你时在行动面板里做') : off ? '这局不参加' : seat?.ok ? `✓ ${seat.label}` : `✗ ${seat?.problem ?? '不可用'}`}</small>
            </div>
          );
        })}
      </div>

      <footer className="dg-ws-foot">
        <span>
          Codex：{codex.loggedIn ? `✓ ${codex.detail}` : codex.detail}。用 Codex 的座位每一步要十几到二十几秒。
          模型的 API Key 在 DSH 设置的「模型」里配，这里只选用哪个。
        </span>
        <button className="dg-ws-btn" disabled={busy} onClick={() => void apply()}>重新检查</button>
      </footer>
      {check.voiced === false && <div className="dg-ws-note-line">还没配豆包语音的新版 API Key：这局大家的话只显示文字，没有声音。在侧栏「插件」→ dsh-game 的设置里填。</div>}
      {check.problem && <div className="dg-ws-problem">开不了局：{check.problem}</div>}
      {error && <div className="dg-ws-problem">! {error}</div>}
    </section>
  );
}

export const WOLF_SETUP_CSS = `
.dg-ws{--gold:#d9b871;--gold-dim:rgba(217,184,113,.45);--serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;
  position:relative;margin-top:22px;padding:22px 24px 18px;border-radius:18px;
  background:radial-gradient(120% 90% at 50% 0%,rgba(30,36,74,.78),rgba(6,8,20,.95) 72%),#070a18 url("/api/dsh-game/asset?path=werewolf/hall.jpg") center/cover;
  border:1px solid var(--gold-dim);box-shadow:0 24px 60px -26px rgba(0,0,0,.85),inset 0 0 0 1px rgba(0,0,0,.6),inset 0 0 60px rgba(0,0,0,.55);transition:opacity .2s}
.dg-ws::before,.dg-ws::after{content:"";position:absolute;width:26px;height:26px;border:2px solid var(--gold);opacity:.7;pointer-events:none}
.dg-ws::before{left:8px;top:8px;border-right:0;border-bottom:0;border-top-left-radius:10px}
.dg-ws::after{right:8px;bottom:8px;border-left:0;border-top:0;border-bottom-right-radius:10px}
.dg-ws[aria-busy=true]{opacity:.88}
.dg-ws-loading{font:12px var(--dg-mono);color:var(--dg-dim)}
.dg-ws-head{display:flex;justify-content:space-between;align-items:center;gap:16px}
.dg-ws-orn{display:block;width:120px;height:8px;margin-bottom:6px;
  background:radial-gradient(circle,var(--gold) 0 2.5px,transparent 3.5px) left center/8px 8px no-repeat,linear-gradient(90deg,var(--gold),transparent) 10px center/110px 1px no-repeat}
.dg-ws-title h2{margin:0;font:600 22px/1.2 var(--serif);letter-spacing:8px;color:#f6ecd0;text-shadow:0 0 18px rgba(217,184,113,.45)}
.dg-ws-title p{margin:6px 0 0;font-size:12px;color:rgba(226,232,255,.72)}
.dg-ws-crest{flex:none;width:74px;height:74px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(circle at 50% 35%,rgba(217,184,113,.35),rgba(20,18,30,.95) 70%);border:2px solid var(--gold);box-shadow:0 0 22px -4px rgba(217,184,113,.6),inset 0 0 12px rgba(0,0,0,.7)}
.dg-ws-crest b{font:700 28px/1 var(--serif);color:#fff3d1}
.dg-ws-crest span{font:12px var(--serif);letter-spacing:2px;color:var(--gold)}
.dg-ws-crest[data-bad]{border-color:#ff8aa0;box-shadow:0 0 22px -4px rgba(255,120,150,.6)}
.dg-ws-board{margin:12px 0 4px;text-align:center;font:13px var(--serif);letter-spacing:2px;color:#e9dcb4}
.dg-ws-board[data-bad]{color:#ffb3c0}
.dg-ws-default{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin:10px 0 18px}
.dg-ws-label{font:14px var(--serif);letter-spacing:2px;color:#f3e7c6}
.dg-ws-note{font-size:11px;color:rgba(220,228,255,.6)}
.dg-ws-note[data-bad]{color:#ffb3c0}
/* ◀ 选项 ▶ */
.dg-pick{display:flex;align-items:stretch;min-width:0;border-radius:10px;background:linear-gradient(180deg,rgba(16,20,44,.92),rgba(8,10,24,.95));
  border:1px solid var(--gold-dim);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 4px 14px -6px rgba(0,0,0,.7)}
.dg-pick-arrow{flex:none;width:26px;padding:0;font-size:10px;color:var(--gold);background:transparent;border:0;cursor:pointer;transition:color .15s,text-shadow .15s}
.dg-pick-arrow:hover:not(:disabled){color:#fff3d1;text-shadow:0 0 8px var(--gold)}
.dg-pick-arrow:disabled{opacity:.3;cursor:default}
.dg-pick{position:relative}
.dg-pick-value{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:5px 2px 7px;text-align:center;
  background:transparent;border:0;cursor:pointer;font:inherit;color:inherit;border-radius:6px;transition:background .15s}
.dg-pick-value:hover:not(:disabled){background:rgba(217,184,113,.08)}
.dg-pick-value:disabled{cursor:default}
.dg-pick[data-open] .dg-pick-value{background:rgba(217,184,113,.12)}
/* 底边的细轨：整条是全部选项，亮的那一段是当前项 */
.dg-pick-track{position:absolute;left:26px;right:26px;bottom:3px;height:2px;border-radius:2px;background:rgba(217,184,113,.14);pointer-events:none}
.dg-pick-track::after{content:"";position:absolute;top:0;bottom:0;border-radius:2px;width:max(4px,calc(100% / var(--n)));left:calc(100% * var(--i) / var(--n));
  background:var(--gold);box-shadow:0 0 6px var(--gold);transition:left .22s cubic-bezier(.3,.7,.2,1)}
.dg-pick[data-off] .dg-pick-track{display:none}
/* 展开的全部选项：和面板同一套金边深底 */
.dg-pick-list{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;min-width:180px;max-height:260px;overflow:auto;padding:5px;border-radius:10px;
  background:linear-gradient(180deg,rgba(18,22,48,.98),rgba(8,10,24,.98));border:1px solid var(--gold-dim);
  box-shadow:0 18px 40px -12px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05);scrollbar-width:thin;scrollbar-color:var(--gold-dim) transparent;
  animation:dg-pick-in .16s ease-out}
@keyframes dg-pick-in{from{opacity:0;transform:translateY(-4px)}}
.dg-pick-item{display:flex;flex-direction:column;align-items:flex-start;width:100%;padding:6px 10px;border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit}
.dg-pick-item:hover{background:rgba(217,184,113,.1)}
.dg-pick-item[aria-selected="true"]{background:rgba(217,184,113,.16);box-shadow:inset 2px 0 0 var(--gold)}
.dg-pick-item b{font:600 13px/1.3 var(--serif);color:#f6ecd0}
.dg-pick-item small{font:10px/1.3 system-ui,sans-serif;color:rgba(220,228,255,.55)}
.dg-ws-note-line{margin-top:10px;font-size:12px;color:#e8d29c;opacity:.85}
.dg-pick-value b{max-width:100%;font:600 13px/1.25 var(--serif);color:#f6ecd0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-pick-value small{max-width:100%;font:10px/1.3 system-ui,sans-serif;color:rgba(220,228,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-ws-default .dg-pick{width:240px}
/* 角色卡 */
.dg-ws-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:16px 14px}
.dg-ws-seat{display:flex;flex-direction:column;gap:8px;min-width:0}
.dg-ws-card{position:relative;padding:0;aspect-ratio:3/4;border-radius:12px;overflow:hidden;cursor:pointer;background:#0a0e1e;
  border:2px solid color-mix(in srgb,var(--c) 70%,var(--gold) 30%);
  box-shadow:0 12px 26px -12px rgba(0,0,0,.85),0 0 18px -6px color-mix(in srgb,var(--c) 70%,transparent),inset 0 0 0 1px rgba(0,0,0,.5);
  transition:transform .2s cubic-bezier(.2,.8,.2,1),filter .25s,box-shadow .25s}
.dg-ws-card:hover:not(:disabled){transform:translateY(-4px);box-shadow:0 18px 32px -12px rgba(0,0,0,.9),0 0 26px -4px color-mix(in srgb,var(--c) 80%,transparent)}
.dg-ws-card:disabled{cursor:default}
.dg-ws-card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 15%}
.dg-ws-card::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(5,8,20,.92))}
.dg-ws-name{position:absolute;left:0;right:0;bottom:7px;z-index:1;text-align:center;font:600 14px var(--serif);letter-spacing:1px;color:#fff;text-shadow:0 1px 6px #000}
.dg-ws-host{position:absolute;left:6px;top:6px;z-index:1;padding:1px 7px;border-radius:99px;font:600 10px var(--serif);color:#0a1020;background:var(--gold)}
.dg-ws-stamp{position:absolute;left:50%;top:45%;z-index:1;transform:translate(-50%,-50%) rotate(-14deg);padding:2px 10px;border:2px solid rgba(255,190,200,.85);border-radius:6px;
  font:700 15px var(--serif);letter-spacing:4px;color:#ffd1d9;background:rgba(40,8,16,.6)}
.dg-ws-seat[data-off] .dg-ws-card{border-color:rgba(160,170,190,.4);box-shadow:0 12px 26px -12px rgba(0,0,0,.85)}
.dg-ws-seat[data-off] .dg-ws-card img{filter:grayscale(1) brightness(.5)}
.dg-ws-seat[data-bad] .dg-ws-card{border-color:#ff7a92;box-shadow:0 0 0 1px #ff7a92,0 0 22px -4px rgba(255,100,130,.7)}
.dg-ws-fixed{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:5px 2px;border-radius:10px;border:1px dashed var(--gold-dim)}
.dg-ws-fixed b{font:600 13px/1.25 var(--serif);color:#bfeaff}
.dg-ws-fixed small{font-size:10px;color:rgba(220,228,255,.55)}
.dg-ws-status{min-height:14px;text-align:center;font:10px/1.4 var(--dg-mono);color:rgba(170,230,200,.85);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dg-ws-seat[data-off] .dg-ws-status{color:rgba(220,228,255,.45)}
.dg-ws-seat[data-bad] .dg-ws-status{color:#ffb3c0}
.dg-ws-foot{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:18px;padding-top:12px;border-top:1px solid rgba(217,184,113,.2);font-size:11px;line-height:1.6;color:rgba(220,228,255,.6)}
.dg-ws-btn{flex:none;font:13px var(--serif);letter-spacing:2px;color:#f6ecd0;padding:7px 16px;border-radius:9px;cursor:pointer;
  background:linear-gradient(180deg,rgba(60,52,30,.9),rgba(26,22,14,.95));border:1px solid var(--gold);box-shadow:0 0 14px -6px rgba(217,184,113,.7);transition:box-shadow .15s,color .15s}
.dg-ws-btn:hover:not(:disabled){color:#fff;box-shadow:0 0 20px -4px rgba(217,184,113,.9)}
.dg-ws-btn:disabled{opacity:.5;cursor:default}
.dg-ws-problem{margin-top:12px;padding:9px 12px;border-radius:10px;font-size:12px;color:#ffd1d9;background:rgba(80,10,24,.5);border:1px solid rgba(255,120,140,.45)}
`;
