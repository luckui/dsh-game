/**
 * 狼人杀牌桌：古堡圆厅里的术士祭坛（CSS 3D，不用 3D 库）。
 *   - 背景：古堡仪式大厅（assets/werewolf/hall.jpg），夜里冷暗、白天偏暖，月光光束和光尘
 *   - 祭坛：倾斜成透视的地面上一座发光魔法阵，几圈符文环各自转动；九芒星连着九个座位
 *   - 座位：魔法阵外圈的角色卡，始终面朝镜头，脚下发光底座；出局的人向后倒下、变灰、盖章
 *   - 镜头：开场从高处俯冲、魔法阵画出来、角色卡依次升起；有人说话时祭坛旋转，把他转到正前方；夜里镜头拉高
 *   - 魔法阵颜色跟着阶段走：夜晚冷蓝、狼人猩红、预言家紫、女巫翠绿、白天金色、投票玫瑰色；每次天黑天亮重新展开
 *   - 底部是视觉小说式的对白框；上帝视角下右上角显示心声；结局全员翻牌
 *   - 某个座位一步没做成（模型出错、Codex 没回应）：卡上挂一个警告角标，记录里写原因；慢的座位（Codex）想得久了显示「思考中」
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Beat, SeatState, WolfEntry, WolfState } from './games/werewolf/engine.js';
import { cnNumber } from './games/werewolf/rules.js';
import { useStage, useWolf, type SeatMarks } from './stage.js';

const ROLE_NAMES: Record<SeatState['role'], string> = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', villager: '平民' };
const DEATH_NAMES: Record<NonNullable<SeatState['death']>, string> = { night: '夜里出局', poison: '被毒出局', vote: '被放逐', shot: '被猎枪带走' };
const STEP_ROLE: Record<NonNullable<WolfState['step']>, SeatState['role']> = { wolf: 'wolf', seer: 'seer', witch: 'witch' };
const STEP_TITLE: Record<NonNullable<WolfState['step']>, string> = { wolf: '狼人睁眼', seer: '预言家睁眼', witch: '女巫睁眼' };

const asset = (file: string) => `/api/dsh-game/asset?path=werewolf/${file}`;

/** 魔法阵的颜色（跟着阶段走） */
function runeColor(state: WolfState): string {
  if (state.phase === 'end') return state.winner === 'wolf' ? '#ff4d6d' : '#f5cd76';
  if (state.phase === 'vote') return '#ff86ad';
  if (state.phase === 'night') return state.step === 'wolf' ? '#ff3d5e' : state.step === 'seer' ? '#b48cff' : state.step === 'witch' ? '#42f0a8' : '#7ab4ff';
  return '#f5cd76';
}

/** 座位在魔法阵上的角度（度）：1 号在正前方，顺时针排开 */
const seatAngle = (i: number, n: number) => 90 + (i * 360) / n;

/** 魔法阵上的点（viewBox -100..100），r=70 是座位那一圈 */
function onCircle(i: number, n: number, r = 70): [number, number] {
  const a = (seatAngle(i, n) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** 转到离 from 最近的那一圈（镜头走最短的路） */
function nearestAngle(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return from + d;
}

/** 逐字打出来 */
function useTypewriter(text: string | null, cps = 8): string {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    if (!text) return;
    const timer = setInterval(() => setShown((n) => (n >= text.length ? n : n + 1)), 1000 / cps);
    return () => clearInterval(timer);
  }, [text, cps]);
  return text ? text.slice(0, Math.max(shown, 1)) : '';
}

// ── 魔法阵 ────────────────────────────────────────────

/** 一个符文：几笔直线和小圈组成的记号（按序号确定，每次画出来都一样） */
function runePath(k: number): string {
  const r = (n: number) => ((Math.sin(k * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const parts = ['M0,-4 L0,4'];
  if (r(1) > 0.3) parts.push(`M0,${(r(2) * 6 - 3).toFixed(1)} L${r(3) > 0.5 ? 2.6 : -2.6},${(r(4) * 6 - 4).toFixed(1)}`);
  if (r(5) > 0.45) parts.push(`M0,${(r(6) * 6 - 2).toFixed(1)} L${r(7) > 0.5 ? -2.4 : 2.4},${(r(8) * 4 + 0.5).toFixed(1)}`);
  if (r(9) > 0.7) parts.push('M-2,-4 L2,-4');
  if (r(10) > 0.75) parts.push(`M${(r(11) * 4 - 2).toFixed(1)},2 a1.2,1.2 0 1,0 0.1,0`);
  return parts.join(' ');
}

function RuneRing({ r, count, seed }: { r: number; count: number; seed: number }) {
  return (
    <g className="wt-c-runes">
      {Array.from({ length: count }, (_, k) => (
        <path key={k} d={runePath(k + seed)} transform={`rotate(${(k * 360) / count}) translate(0 ${-r}) scale(.9)`} />
      ))}
    </g>
  );
}

/** 一层魔法阵（各自一张 SVG、各自转：转动交给合成器，不用每帧重画） */
function Layer({ spin, children }: { spin?: 'slow' | 'rev' | 'fast'; children: React.ReactNode }) {
  return (
    <div className="wt-layer" data-spin={spin}>
      <svg viewBox="-100 -100 200 200" aria-hidden="true">{children}</svg>
    </div>
  );
}

/** 画出来的线（pathLength=1，展开动画用） */
const draw = { pathLength: 1, className: 'wt-c-line wt-c-draw' } as const;
const drawThin = { pathLength: 1, className: 'wt-c-line wt-c-thin wt-c-draw' } as const;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 连着所有座位的星形 {n/k}：k 取不到 n/2 的最大值；和 n 有公约数时画成几个交叠的多边形（6 人是六芒星） */
function starPath(pts: [number, number][]): string {
  const n = pts.length;
  const step = Math.max(1, Math.ceil(n / 2) - 1);
  const g = gcd(n, step);
  return Array.from({ length: g }, (_, start) => Array.from({ length: n / g }, (_, k) => pts[(start + k * step) % n])
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ') + ' Z').join(' ');
}

/** 魔法阵：外圈刻度、符文带、连着所有座位的星形、内圈六芒星、中央小阵 */
function MagicCircle({ n, alive }: { n: number; alive: boolean[] }) {
  const pts = Array.from({ length: n }, (_, i) => onCircle(i, n));
  const star = starPath(pts);
  return (
    <div className="wt-circle">
      <div className="wt-circle-core" />
      <Layer spin="slow">
        <circle r="96" {...draw} />
        <circle r="92.5" {...drawThin} />
        <g className="wt-c-ticks">
          {Array.from({ length: 72 }, (_, k) => (
            <line key={k} x1="0" y1={k % 6 ? -93.5 : -90.5} x2="0" y2="-96" transform={`rotate(${k * 5})`} />
          ))}
        </g>
      </Layer>
      <Layer spin="rev">
        <circle r="88.5" {...drawThin} />
        <RuneRing r={84.2} count={36} seed={3} />
        <circle r="80" {...drawThin} />
      </Layer>
      <Layer>
        <path d={star} {...drawThin} />
        <circle r="70" {...drawThin} />
        {pts.map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`} className="wt-c-node" data-dead={alive[i] ? undefined : ''}>
            <circle r="7.5" className="wt-c-line wt-c-thin" />
            <circle r="4.4" className="wt-c-node-core" />
          </g>
        ))}
      </Layer>
      <Layer spin="fast">
        <circle r="42" {...draw} />
        <RuneRing r={37.5} count={18} seed={61} />
        <circle r="33" {...drawThin} />
        <path d="M0,-33 L28.58,16.5 L-28.58,16.5 Z" {...drawThin} />
        <path d="M0,33 L28.58,-16.5 L-28.58,-16.5 Z" {...drawThin} />
      </Layer>
      <Layer spin="rev">
        <circle r="18" {...drawThin} />
        <circle r="12" {...draw} />
        {Array.from({ length: 8 }, (_, k) => <line key={k} x1="0" y1="-12" x2="0" y2="-18" transform={`rotate(${k * 45})`} className="wt-c-line wt-c-thin" />)}
      </Layer>
    </div>
  );
}

// ── 光尘 ─────────────────────────────────────────────

function Motes({ color }: { color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef(color);
  colorRef.current = color;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
      h = canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() * 1.6 + 0.4, v: Math.random() * 0.00035 + 0.0001, p: Math.random() * Math.PI * 2 }));
    let raf = 0;
    const tick = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = colorRef.current;
      for (const m of motes) {
        if (!still) {
          m.y -= m.v;
          m.x += Math.sin(t / 2400 + m.p) * 0.00012;
          if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
        }
        ctx.globalAlpha = (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t / 700 + m.p))) * (0.35 + 0.65 * m.y);
        ctx.beginPath();
        ctx.arc(m.x * w, m.y * h, m.s * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="wt-motes" aria-hidden="true" />;
}

// ── 座位 ─────────────────────────────────────────────

function Portrait({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="wt-initial">{name.slice(0, 1)}</span>
    : <img src={asset(`${id}.jpg`)} alt="" draggable={false} onError={() => setFailed(true)} />;
}

/** 想了这么久还没好才显示「思考中」（快的模型一闪而过，不显示） */
const SLOW_MS = 4000;

function useSlow(on: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!on) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [on]);
  return slow;
}

/** 这个视角是谁的眼睛：大肥鱼视角是她，主人视角是主人；上帝视角和结局是 null（全都看得到） */
function viewerOf(state: WolfState): SeatState | null {
  if (state.phase === 'end') return null;
  if (state.view === 'player') return state.seats[(state.ownerSeat ?? 0) - 1] ?? null;
  if (state.view === 'fish') return state.seats.find((s) => s.id === 'deepseek') ?? null;
  return null;
}

/**
 * 这个视角下能不能看到这个座位的身份：上帝视角全部；大肥鱼 / 主人视角只有自己、自己是狼时的狼队友；结局全员翻牌。
 * （预言家查到的结果显示成「验」标记，不在这里）
 */
function roleKnown(state: WolfState, seat: SeatState): boolean {
  const me = viewerOf(state);
  if (!me || seat.no === me.no) return true;
  return me.role === 'wolf' && seat.role === 'wolf';
}

/** 这个视角下看得到的标记：刀要自己是狼、救和毒要自己是女巫、验要是自己验的（中途切视角也不漏） */
function visibleMarks(state: WolfState, marks: SeatMarks | undefined): SeatMarks | undefined {
  const me = marks ? viewerOf(state) : null;
  if (!marks || !me) return marks;
  return {
    kill: me.role === 'wolf' ? marks.kill : undefined,
    saved: me.role === 'witch' ? marks.saved : undefined,
    poison: me.role === 'witch' ? marks.poison : undefined,
    checked: marks.checkedBy === me.no ? marks.checked : undefined,
  };
}

function Seat({ seat, index, n, state, speaking, color, fault, marks: allMarks, voteCount, pick, onPick }: {
  seat: SeatState; index: number; n: number; state: WolfState; speaking: boolean; color: string; fault?: { count: number; text: string }; marks?: SeatMarks; voteCount?: number;
  /** 主人选人时：can 能选、picked 选中了、off 这一步不能选 */
  pick?: { mode: 'can' | 'picked' | 'off'; verb: string };
  onPick?: () => void;
}) {
  const slow = useSlow(state.thinking?.includes(seat.no) ?? false);
  const [x, y] = onCircle(index, n);
  const reveal = roleKnown(state, seat);
  const marks = visibleMarks(state, allMarks);
  // 夜里谁睁眼：大肥鱼视角只看得到她知道身份的人
  const awake = state.phase === 'night' && !!state.step && seat.alive && seat.role === STEP_ROLE[state.step] && reveal;
  // 票数：揭晓过程中按已经揭晓的票数，揭晓完按结果
  const votes = state.phase === 'night' || state.phase === 'end' ? 0 : state.votes ? Object.values(state.votes).filter((t) => t === seat.no).length : (voteCount ?? 0);
  const vars = { '--c': color, '--i': index } as React.CSSProperties;
  const mine = state.ownerSeat === seat.no;
  return (
    <div className="wt-anchor" style={{ left: `${50 + x / 2}%`, top: `${50 + y / 2}%` }} data-owner={mine ? '' : undefined}>
      <div className="wt-pedestal" style={vars} data-on={speaking || awake ? '' : undefined} data-dead={seat.alive ? undefined : ''} />
      {/* 外层只负责面朝镜头（跟着镜头每帧变，不能有过渡），姿势（放大、倒下）在里层 */}
      <div
        className="wt-card"
        style={vars}
        data-no={seat.no}
        data-pick={pick?.mode}
        title={pick && pick.mode !== 'off' ? `${pick.verb} ${seat.no} 号 ${seat.name}` : undefined}
        onClick={pick && pick.mode !== 'off' ? onPick : undefined}
      >
        <div
          className="wt-pose"
          data-speaking={speaking ? '' : undefined}
          data-awake={awake ? state.step! : undefined}
          data-dead={seat.alive ? undefined : ''}
          data-flip={state.phase === 'end' ? '' : undefined}
        >
          {speaking && <div className="wt-beam" />}
          {pick?.mode === 'picked' && <span className="wt-pick-tag">{pick.verb}</span>}
          <div className="wt-card-inner">
            <div className="wt-face">
              <Portrait id={seat.id} name={seat.name} />
              <div className="wt-face-shine" />
              {!seat.alive && <span className="wt-stamp">{seat.death ? DEATH_NAMES[seat.death] : '出局'}</span>}
              {votes > 0 && <span className="wt-votes">{votes}</span>}
              {fault && <span className="wt-fault" title={fault.text}>⚠{fault.count > 1 ? ` ×${fault.count}` : ''}</span>}
              {reveal && <i className="wt-role" data-role={seat.role}>{ROLE_NAMES[seat.role]}</i>}
              <span className="wt-marks">
                {marks?.kill && <em data-mark="kill">刀</em>}
                {marks?.saved && <em data-mark="save">救</em>}
                {marks?.poison && <em data-mark="poison">毒</em>}
                {marks?.checked && <em data-mark={marks.checked === 'wolf' ? 'check-wolf' : 'check-good'}>验·{marks.checked === 'wolf' ? '狼' : '好'}</em>}
              </span>
              {/* 名牌压在卡面下沿：只会被挡住整张卡的东西挡住，不会伸到旁边的卡上 */}
              <b className="wt-no">{seat.no}</b>
              {mine && <span className="wt-you">你</span>}
              <div className="wt-plate"><span>{seat.name}</span></div>
            </div>
            <div className="wt-back">
              <img src={asset(`card-${seat.role}.jpg`)} alt="" draggable={false} />
              <span>{ROLE_NAMES[seat.role]}<small>{seat.no} {seat.name}</small></span>
            </div>
          </div>
          {slow
            ? <small className="wt-driver wt-thinking">{mine ? '轮到你' : `${seat.driver ?? ''} 思考中`}<i /><i /><i /></small>
            : seat.driver && <small className="wt-driver">{seat.driver}</small>}
        </div>
      </div>
    </div>
  );
}

// ── 覆盖层：标题、对白框、心声、记录 ───────────────────────

function Dialog({ who, color, id, text, narrator, tag }: { who: string; color: string; id: string | null; text: string; narrator: boolean; tag?: 'inner' | 'wolf' }) {
  const typed = useTypewriter(text, narrator ? 10 : 8);
  return (
    <div className="wt-dialog" style={{ '--c': color } as React.CSSProperties} data-narrator={narrator ? '' : undefined} data-tag={tag} key={text}>
      <div className="wt-dialog-face">{id ? <Portrait id={id} name={who} /> : <span className="wt-dialog-orb" />}</div>
      <div className="wt-dialog-body">
        <b>{who}</b>
        <p>{typed}{typed.length < text.length && <i className="wt-caret" />}</p>
      </div>
    </div>
  );
}

function InnerVoices({ state, inner, colors }: { state: WolfState; inner: Record<number, string>; colors: Record<string, string> }) {
  const items = Object.entries(inner).slice(-2);
  if (!items.length) return null;
  return (
    <div className="wt-inners">
      {items.map(([no, text]) => {
        const seat = state.seats[Number(no) - 1];
        if (!seat) return null;
        return (
          <div key={`${no}:${text}`} className="wt-inner" style={{ '--c': colors[seat.id] ?? '#9fb6ec' } as React.CSSProperties}>
            <div className="wt-inner-face"><Portrait id={seat.id} name={seat.name} /></div>
            <div><b>{seat.no} {seat.name} · 心声</b><p>{text}</p></div>
          </div>
        );
      })}
    </div>
  );
}

function Log({ feed, state, god, onClose }: { feed: WolfEntry[]; state: WolfState; god: boolean; onClose: () => void }) {
  const name = (n: number) => `${n} ${state.seats[n - 1]?.name ?? ''}`;
  const rows = feed.flatMap((e, i): React.ReactNode[] => {
    switch (e.kind) {
      case 'narrator': return [<li key={i} className="wt-log-n">{e.text}</li>];
      case 'speech': return [<li key={i}><b>{name(e.seat)}{e.last ? '（遗言）' : ''}</b>{e.text}</li>];
      case 'wolf_chat': return god ? [<li key={i} className="wt-log-w"><b>{name(e.seat)}（狼队）</b>{e.text}</li>] : [];
      // 主人上桌时她这局没念出来的心声：结束后复盘看
      case 'inner': return god ? [<li key={i} className="wt-log-i"><b>{name(e.seat)} 心声</b>{e.text}</li>] : [];
      case 'beat': {
        if (!god && !e.shown) return [];
        if (e.stage === 'inner') return e.seat && e.beat.inner[e.seat] ? [<li key={i} className="wt-log-i"><b>{name(e.seat)} 心声</b>{e.beat.inner[e.seat]}</li>] : [];
        const text = beatText(e.beat, name);
        return text && e.beat.act !== 'wolf_chat' && e.beat.act !== 'speak' ? [<li key={i} className="wt-log-a">{text}</li>] : [];
      }
      case 'fault': return [<li key={i} className="wt-log-f"><b>{name(e.seat)} 这一步没做成</b>{e.text}</li>];
      case 'vote': return [<li key={i} className="wt-log-v">投票：{Object.entries(e.votes).map(([f, t]) => `${f}→${t ?? '弃'}`).join('　')}</li>];
      default: return [];
    }
  });
  return (
    <div className="wt-log">
      <div className="wt-log-head"><span>牌桌记录</span><button onClick={onClose}>收起</button></div>
      <ol>{rows.reverse()}</ol>
    </div>
  );
}

// ── 动作演出：字幕和特效 ───────────────────────────────

/** 一拍动作写成一句话（字幕、记录） */
function beatText(beat: Beat, name: (n: number) => string): string {
  const t = beat.target ?? null;
  const who = name(beat.seats[0]);
  switch (beat.act) {
    case 'wolf_chat': return `${who} 在狼队里说话`;
    case 'kill': return t ? `狼人选择刀 ${name(t)}` : '狼人今晚没有刀人';
    case 'check': return t ? `预言家 ${who} 查验 ${name(t)}：${beat.result === 'wolf' ? '狼人' : '好人'}` : '';
    case 'save': return t ? `女巫用解药救了 ${name(t)}` : '';
    case 'poison': return t ? `女巫毒了 ${name(t)}` : '';
    case 'witch_pass': return '女巫今晚没有用药';
    case 'vote': return t ? `${who} 投给 ${name(t)}` : `${who} 弃票`;
    case 'shoot': return t ? `猎人 ${who} 开枪带走 ${name(t)}` : `猎人 ${who} 没有开枪`;
    default: return '';
  }
}

/** 地面上从 a 座位到 b 座位的一条弧线（和魔法阵同一个坐标系，跟着透视走）：两头收进底座边，中间往阵心弯 */
function floorArc(a: number, b: number, n: number): { d: string; end: [number, number]; dir: [number, number] } {
  const [ax0, ay0] = onCircle(a - 1, n);
  const [bx0, by0] = onCircle(b - 1, n);
  const [ax, ay] = [ax0 * 0.9, ay0 * 0.9];
  const [bx, by] = [bx0 * 0.88, by0 * 0.88];
  const [cx, cy] = [(ax + bx) * 0.18, (ay + by) * 0.18];
  const len = Math.hypot(bx - cx, by - cy) || 1;
  return { d: `M${ax.toFixed(2)},${ay.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${bx.toFixed(2)},${by.toFixed(2)}`, end: [bx, by], dir: [(bx - cx) / len, (by - cy) / len] };
}

/** 一条能量线：外圈光晕、亮芯、沿线流向目标的光点；arrow 时末端带一个小箭头 */
function EnergyLine({ a, b, n, color, arrow, delay = 0 }: { a: number; b: number; n: number; color: string; arrow?: boolean; delay?: number }) {
  const { d, end, dir } = floorArc(a, b, n);
  const [ex, ey] = end;
  const [dx, dy] = dir;
  const head = `M${(ex + dx * 2.6).toFixed(2)},${(ey + dy * 2.6).toFixed(2)} L${(ex - dx * 2.2 - dy * 2.2).toFixed(2)},${(ey - dy * 2.2 + dx * 2.2).toFixed(2)} L${(ex - dx * 2.2 + dy * 2.2).toFixed(2)},${(ey - dy * 2.2 - dx * 2.2).toFixed(2)} Z`;
  return (
    <g className="wt-energy" style={{ color, animationDelay: `${delay}s` } as React.CSSProperties}>
      <path className="wt-energy-glow" d={d} pathLength={1} style={{ animationDelay: `${delay}s` }} />
      <path className="wt-energy-core" d={d} pathLength={1} style={{ animationDelay: `${delay}s` }} />
      <path className="wt-energy-flow" d={d} pathLength={1} style={{ animationDelay: `${delay + 0.6}s` }} />
      {arrow && <path className="wt-energy-head" d={head} style={{ animationDelay: `${delay + 0.5}s` }} />}
    </g>
  );
}

/** 地面上目标脚下亮起的光环 */
function TargetRing({ seat, n, color }: { seat: number; n: number; color: string }) {
  const [x, y] = onCircle(seat - 1, n);
  return (
    <g className="wt-ring" style={{ color } as React.CSSProperties} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}>
      <circle r="9" />
      <circle r="12" className="wt-ring-out" />
    </g>
  );
}

const FX_COLOR: Partial<Record<Beat['act'], string>> = { kill: '#ff2d55', check: '#b48cff', save: '#6dffb0', poison: '#c05cff', shoot: '#ffb347' };

/**
 * 地面特效（画在魔法阵那一层，跟着透视）：这一拍的动作线 + 这一轮已经揭晓的投票线。
 * 刀人：每只狼一道红线；查验：紫线；女巫：药水沿线飞过去；猎人：橙色枪线。目标脚下亮一圈光环
 */
function FloorFx({ fx, arrows, n, colors, state, aim }: { fx: { id: number; beat: Beat } | null; arrows: { from: number; to: number }[]; n: number; colors: Record<string, string>; state: WolfState; aim?: { from: number; to: number; color: string } | null }) {
  const colorOf = (no: number) => colors[state.seats[no - 1]?.id ?? ''] ?? '#9fd8ff';
  const beat = fx?.beat;
  const target = beat?.target ?? null;
  const color = beat ? FX_COLOR[beat.act] : undefined;
  const showVotes = state.phase === 'vote' || state.phase === 'day';
  return (
    <svg className="wt-floorfx" viewBox="-100 -100 200 200" aria-hidden="true">
      {/* 主人正在选的人：先连一条线，确认了才算 */}
      {aim && aim.from !== aim.to && <EnergyLine key={`aim${aim.to}`} a={aim.from} b={aim.to} n={n} color={aim.color} arrow />}
      {aim && <TargetRing key={`aimr${aim.to}`} seat={aim.to} n={n} color={aim.color} />}
      {showVotes && arrows.map((a, i) => <EnergyLine key={`v${a.from}-${a.to}`} a={a.from} b={a.to} n={n} color={colorOf(a.from)} arrow delay={i === arrows.length - 1 ? 0 : -1} />)}
      {showVotes && [...new Set(arrows.map((a) => a.to))].map((to) => <TargetRing key={`r${to}`} seat={to} n={n} color="#ff86ad" />)}
      {beat && target && color && beat.act !== 'vote' && (
        <g key={fx!.id}>
          {beat.seats.map((from, i) => <EnergyLine key={from} a={from} b={target} n={n} color={color} delay={i * 0.12} />)}
          {(beat.act === 'save' || beat.act === 'poison') && (
            <circle className="wt-potion" r="3.4" style={{ color } as React.CSSProperties}>
              <animateMotion dur="1s" fill="freeze" path={floorArc(beat.seats[0], target, n).d} />
            </circle>
          )}
          <TargetRing seat={target} n={n} color={color} />
        </g>
      )}
    </svg>
  );
}

/** 字幕：这一拍发生了什么（看得清是谁对谁做了什么），停 3 秒 */
function Caption({ fx, state }: { fx: { id: number; beat: Beat } | null; state: WolfState }) {
  const [shown, setShown] = useState<{ id: number; text: string; act: Beat['act'] } | null>(null);
  useEffect(() => {
    if (!fx) return;
    const text = beatText(fx.beat, (n) => `${n} 号 ${state.seats[n - 1]?.name ?? ''}`);
    if (!text || fx.beat.act === 'speak') return;
    setShown({ id: fx.id, text, act: fx.beat.act });
    const timer = setTimeout(() => setShown((c) => (c?.id === fx.id ? null : c)), fx.beat.act === 'vote' ? 1800 : 3200);
    return () => clearTimeout(timer);
  }, [fx?.id]);
  if (!shown) return null;
  return <div className="wt-caption" data-act={shown.act} key={shown.id}>{shown.text}</div>;
}

// ── 镜头 ─────────────────────────────────────────────

/**
 * 镜头：开场从高处一边转一边俯冲下来；之后说话的人转到正前方、稍微推近；夜里镜头拉高、拉远。
 * 0 = 开场起点（刚挂上，还在高处），1 = 开场俯冲中（过渡时间长），2 = 正常
 */
function useCamera(state: WolfState | null, focus: number | null) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const orbit = useRef(0);
  useEffect(() => {
    const a = setTimeout(() => setStage(1), 60);
    const b = setTimeout(() => setStage(2), 3000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const n = state?.seats.length ?? 9;
  if (focus && focus > 0) orbit.current = nearestAngle(orbit.current, 90 - seatAngle(focus - 1, n));
  const night = state?.phase === 'night';
  if (stage === 0) return { tilt: 82, orbit: orbit.current - 100, zoom: 0.55, intro: true };
  return { tilt: night ? 66 : 61, orbit: orbit.current, zoom: focus ? 1.06 : night ? 0.95 : 1, intro: stage === 1 };
}

// ── 主人的行动条（主人上桌、轮到主人时，叠在牌桌底部；全屏时也在） ─────────

const TURN_LABEL: Record<string, string> = {
  speech: '轮到你发言', last_words: '留遗言', wolf_chat: '狼队私聊', wolf_kill: '今晚刀谁', seer_check: '查验谁',
  witch: '女巫用药', vote: '投给谁', hunter_shot: '开枪带走谁',
};
const AIM_COLOR: Record<string, string> = { kill: '#ff2d55', check: '#b48cff', poison: '#c05cff', vote: '#ffd27a', shoot: '#ffb347' };

function verbOf(action: string, self: boolean): string {
  if (action === 'kill') return self ? '自刀' : '刀';
  return ({ check: '验', poison: '毒', vote: '投给', shoot: '带走' } as Record<string, string>)[action] ?? '';
}

/**
 * 轮到主人时的行动条：发言类是输入框；选人类是「点桌上的牌 → 确认」；女巫多救、毒、不用药。
 * 动作和她的 game_act 一样，交给宿主 /api/dsh-game/wolf-act 用同一套检查
 */
function OwnerBar({ state, turn, picked, setPicked, poisoning, setPoisoning, seatAction }: {
  state: WolfState; turn: NonNullable<WolfState['ownerTurn']>; picked: number | null; setPicked: (n: number | null) => void;
  poisoning: boolean; setPoisoning: (on: boolean) => void; seatAction: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const has = (action: string) => turn.actions.some((a) => a.action === action);
  const name = (no: number) => `${no} 号 ${state.seats[no - 1]?.name ?? ''}`;
  const act = async (action: string, extra: { index?: number; text?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dsh-game/wolf-act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? `HTTP ${res.status}`);
      else setDraft('');
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (has('speak')) {
    const spec = turn.actions.find((a) => a.action === 'speak');
    const send = () => { const text = draft.trim(); if (text) void act('speak', { text }); };
    body = (
      <>
        <input
          autoFocus
          value={draft}
          placeholder={spec?.params?.text ?? '要说的话'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        <button type="button" className="wt-bar-go" disabled={busy || !draft.trim()} onClick={send}>说出来 ⏎</button>
        {turn.kind !== 'wolf_chat' && <button type="button" className="wt-bar-soft" disabled={busy} onClick={() => void act('speak', { text: '……（过）' })}>过</button>}
      </>
    );
  } else {
    body = (
      <>
        {turn.witch && !poisoning && <span className="wt-bar-note">{turn.witch.killed ? `今晚被刀的是 ${name(turn.witch.killed)}` : '今晚没有人被刀'}</span>}
        {has('save') && !poisoning && turn.witch?.killed && <button type="button" className="wt-bar-act" data-act="save" disabled={busy} onClick={() => void act('save')}>救 {turn.witch.killed} 号</button>}
        {has('poison') && !poisoning && <button type="button" className="wt-bar-act" data-act="poison" disabled={busy} onClick={() => setPoisoning(true)}>用毒药</button>}
        {seatAction && (
          picked
            ? <button type="button" className="wt-bar-act wt-bar-confirm" data-act={seatAction} disabled={busy} onClick={() => void act(seatAction, { index: picked })}>确认：{verbOf(seatAction, picked === state.ownerSeat)} {name(picked)}</button>
            : <span className="wt-bar-hint">点桌上亮着的人</span>
        )}
        {picked && <button type="button" className="wt-bar-soft" disabled={busy} onClick={() => setPicked(null)}>重选</button>}
        {poisoning && <button type="button" className="wt-bar-soft" disabled={busy} onClick={() => setPoisoning(false)}>先不毒</button>}
        {has('abstain') && <button type="button" className="wt-bar-soft" disabled={busy} onClick={() => void act('abstain')}>弃票</button>}
        {has('pass') && !poisoning && <button type="button" className="wt-bar-soft" disabled={busy} onClick={() => void act('pass')}>{turn.kind === 'witch' ? '不用药' : '不开枪'}</button>}
      </>
    );
  }
  return (
    <div className="wt-bar" key={`${turn.kind}:${turn.ask}`}>
      <b className="wt-bar-label" title={turn.ask}>{poisoning ? '毒谁' : TURN_LABEL[turn.kind] ?? '轮到你'}</b>
      {body}
      {error && <span className="wt-bar-error" title={error}>{error}</span>}
    </div>
  );
}

// ── 牌桌 ─────────────────────────────────────────────

export function WolfTable({ colors }: { colors: Record<string, string> }) {
  const { state, feed, voice, faults, fx, marks, arrows } = useWolf();
  const stage = useStage();
  const root = useRef<HTMLDivElement>(null);
  // 一拍动作刚演的 3 秒里魔法阵压暗，地面上的线看得清
  const [fxActive, setFxActive] = useState(false);
  useEffect(() => {
    if (!fx || fx.beat.act === 'vote' || fx.beat.act === 'speak' || fx.beat.act === 'wolf_chat') return;
    setFxActive(true);
    const timer = setTimeout(() => setFxActive(false), 3200);
    return () => clearTimeout(timer);
  }, [fx?.id]);
  const god = state?.view !== 'fish' && state?.view !== 'player';
  const player = state?.view === 'player';
  // 主人这一步：选中的座位（点桌上的牌），女巫是不是在选毒谁
  const turn = state?.ownerTurn ?? null;
  const turnKey = turn ? `${turn.kind}:${turn.ask}:${turn.options.join(',')}` : '';
  const [picked, setPicked] = useState<number | null>(null);
  const [poisoning, setPoisoning] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  useEffect(() => { setPicked(null); setPoisoning(false); }, [turnKey]);
  const seatAction = turn ? turn.actions.find((a) => a.params?.index && a.action !== 'poison')?.action ?? (poisoning ? 'poison' : null) : null;
  const setView = (view: 'god' | 'fish') => void fetch(`/api/dsh-game/wolf-view?view=${view}`, { method: 'POST' }).catch(() => {});
  const [showLog, setShowLog] = useState(false);
  const narrator = useMemo(() => [...feed].reverse().find((e) => e.kind === 'narrator') as Extract<WolfEntry, { kind: 'narrator' }> | undefined, [feed]);
  const focus = voice && voice.seat > 0 ? voice.seat : null;
  const camera = useCamera(state, focus);
  if (!state) return <div className="wt wt-empty"><span>等大肥鱼开局……</span></div>;

  const n = state.seats.length;
  const rune = runeColor(state);
  const title = state.phase === 'end' ? (state.winner === 'wolf' ? '狼人阵营胜利' : '好人阵营胜利') : state.day === 0 ? '月下狼人杀' : state.phase === 'night' ? `第 ${state.day} 夜` : `第 ${state.day} 天`;
  const subtitle = state.phase === 'end' ? '游戏结束 · 全员身份公开'
    : state.day === 0 ? (state.ownerSeat ? `${cnNumber(state.seats.length - 1)}位 AI 和你 · ${state.seats.length} 人局` : `${cnNumber(state.seats.length)}位 AI · ${state.seats.length} 人局`)
    : state.phase === 'night' ? (state.step ? STEP_TITLE[state.step] : '天黑请闭眼')
    : state.phase === 'vote' ? '放逐投票' : '白天发言';
  // 对白框：正在念的话；没人念的时候留着法官最近一句
  const speakingSeat = focus ? state.seats[focus - 1] : null;
  const dialog = voice
    ? speakingSeat
      ? { who: `${speakingSeat.no} · ${speakingSeat.name}${voice.tag === 'inner' ? ' · 心声' : voice.tag === 'wolf' ? ' · 狼队私聊' : ''}`, color: colors[speakingSeat.id] ?? '#9fb6ec', id: speakingSeat.id, text: voice.text, narrator: false, tag: voice.tag }
      : { who: '法官', color: rune, id: null, text: voice.text, narrator: true }
    : narrator ? { who: '法官', color: rune, id: null, text: narrator.text, narrator: true } : null;
  // 大肥鱼的心声就是她说的话（回复里写的文字）
  const fishSeat = state.seats.find((s) => s.id === 'deepseek')?.no;
  // 她的心声是说给观众听的：上帝视角关了也显示（游戏标签里大肥鱼的气泡在狼人杀时收起，免得盖住牌桌）
  // 主人上桌时这局听不到她的心声（结束后在记录里复盘）
  const inners = fishSeat && stage.bubble && !(player && state.phase !== 'end') ? { [fishSeat]: stage.bubble } : {};
  const ownerSeat = state.ownerSeat ? state.seats[state.ownerSeat - 1] : null;
  const ended = state.phase === 'end';
  // 每次天黑、天亮，魔法阵重新展开一次
  const faultCount = Object.values(faults).reduce((sum, f) => sum + f.count, 0);
  const unfold = `${state.phase === 'night' ? 'n' : state.phase === 'end' ? 'e' : 'd'}${state.day}`;

  return (
    <div
      ref={root}
      className="wt"
      data-view={god ? 'god' : player ? 'player' : 'fish'}
      data-picking={seatAction ? '' : undefined}
      data-turn={turn ? '' : undefined}
      data-voting={(state.phase === 'vote' && arrows.length) || fxActive ? '' : undefined}
      data-phase={state.phase === 'night' ? 'night' : state.phase === 'end' ? 'end' : 'day'}
      data-intro={camera.intro ? '' : undefined}
      style={{ '--rune': rune, '--tilt': `${camera.tilt}deg`, '--orbit': `${camera.orbit}deg`, '--zoom': camera.zoom } as React.CSSProperties}
    >
      <div className="wt-hall" />
      <div className="wt-grade" />
      <div className="wt-godray" />

      <div className="wt-camera">
        <div className="wt-floor">
          <div className="wt-floor-glow" />
          <MagicCircle key={unfold} n={n} alive={state.seats.map((s) => s.alive)} />
          <FloorFx fx={fx} arrows={arrows} n={n} colors={colors} state={state} aim={seatAction && picked && state.ownerSeat ? { from: state.ownerSeat, to: picked, color: AIM_COLOR[seatAction] ?? '#ffd27a' } : null} />
          <div className="wt-orb-anchor"><div className="wt-orb-face"><div className="wt-orb" data-live={voice && voice.seat === 0 ? '' : undefined} /></div></div>
          {state.seats.map((seat, i) => (
            <Seat
              key={seat.no} seat={seat} index={i} n={n} state={state} speaking={focus === seat.no} color={colors[seat.id] ?? '#86dcff'} fault={faults[seat.no]} marks={marks[seat.no]} voteCount={arrows.filter((a) => a.to === seat.no).length}
              pick={seatAction && turn ? { mode: picked === seat.no ? 'picked' : turn.options.includes(seat.no) ? 'can' : 'off', verb: verbOf(seatAction, seat.no === state.ownerSeat) } : undefined}
              onPick={() => setPicked((p) => (p === seat.no ? null : seat.no))}
            />
          ))}
        </div>
      </div>
      <Motes color={rune} />
      <div className="wt-vignette" />
      <Caption fx={fx} state={state} />

      <div className="wt-banner" key={title + subtitle}>
        <span className="wt-banner-orn" />
        <b>{title}</b>
        <small>{subtitle}</small>
      </div>

      <InnerVoices state={state} inner={inners} colors={colors} />
      {dialog && <Dialog {...dialog} />}

      <div className="wt-hud">
        <div className="wt-hud-left">
          <span className="wt-chip">{state.seats.filter((s) => s.alive).length} / {n} 存活</span>
          {faultCount > 0 && <button className="wt-chip wt-chip-fault" onClick={() => setShowLog(true)}>⚠ {faultCount} 步没做成 · 看记录</button>}
        </div>
        <div className="wt-hud-right">
          {ownerSeat
            ? <>
              <span className="wt-chip wt-chip-you" title="你也在桌上：只看得到你知道的事">主人视角 · 你是 {ownerSeat.no} 号{ownerSeat.role ? ` ${ROLE_NAMES[ownerSeat.role]}` : ''}</span>
              <button className="wt-toggle" data-on={showNotes ? '' : undefined} onClick={() => setShowNotes((v) => !v)}>你知道的</button>
            </>
            : <>
              <button className="wt-toggle" data-on={god ? '' : undefined} title="看所有人的身份、夜里的行动，念所有人的心声" onClick={() => setView('god')}>上帝视角</button>
              <button className="wt-toggle" data-on={god ? undefined : ''} title="只看大肥鱼知道的事" onClick={() => setView('fish')}>大肥鱼视角</button>
            </>}
          <button className="wt-toggle" data-on={showLog ? '' : undefined} onClick={() => setShowLog((v) => !v)}>{player && ended ? '复盘' : '记录'}</button>
        </div>
      </div>
      {showLog && <Log feed={feed} state={state} god={god || ended} onClose={() => setShowLog(false)} />}
      {showNotes && ownerSeat && (
        <div className="wt-notes" onClick={() => setShowNotes(false)}>
          {turn && <p className="wt-notes-ask">{turn.ask}</p>}
          {(state.ownerNotes ?? []).map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}
      {turn && <OwnerBar state={state} turn={turn} picked={picked} setPicked={setPicked} poisoning={poisoning} setPoisoning={setPoisoning} seatAction={seatAction} />}
    </div>
  );
}

export const WOLF_CSS = `
@property --tilt{syntax:'<angle>';inherits:true;initial-value:60deg}
@property --orbit{syntax:'<angle>';inherits:true;initial-value:0deg}
@property --zoom{syntax:'<number>';inherits:true;initial-value:1}
.wt{position:relative;width:100%;height:100%;overflow:clip;container-type:size;user-select:none;isolation:isolate;background:#03050c;
  --serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#e6eeff;
  transition:--tilt 1.6s cubic-bezier(.3,.7,.2,1),--orbit 1.5s cubic-bezier(.45,.05,.2,1),--zoom 1.4s cubic-bezier(.3,.7,.2,1)}
.wt[data-intro]{transition:--tilt 2.8s cubic-bezier(.25,.75,.2,1),--orbit 2.8s cubic-bezier(.25,.75,.2,1),--zoom 2.8s cubic-bezier(.25,.75,.2,1)}
.wt-empty{display:flex;align-items:center;justify-content:center;background:radial-gradient(60% 60% at 50% 40%,#0d1836,#04060d)}
.wt-empty span{font:13px var(--dg-mono);color:var(--dg-faint)}

/* 大厅：背景画（随镜头轻微视差）、调色（夜冷昼暖）、月光光束 */
.wt-hall{position:absolute;inset:-4%;background:#060a18 url("/api/dsh-game/asset?path=werewolf/hall.jpg") center 45%/cover no-repeat;
  transform:translateX(calc(sin(var(--orbit)) * -1.6cqw)) scale(calc(1.02 + (var(--zoom) - 1) * .3));transition:filter 2.4s ease;filter:brightness(.66) saturate(1.05)}
.wt[data-phase=day] .wt-hall,.wt[data-phase=end] .wt-hall{filter:brightness(.88) saturate(.95) sepia(.14)}
.wt-grade{position:absolute;inset:0;pointer-events:none;transition:opacity 2.4s ease;
  background:radial-gradient(60% 50% at 50% 64%,transparent,rgba(3,6,18,.5) 75%),linear-gradient(180deg,rgba(4,8,24,.5),rgba(4,8,24,.05) 40%,rgba(3,5,14,.55))}
.wt[data-phase=day] .wt-grade{opacity:.55}
.wt-godray{position:absolute;left:28%;top:-8%;width:44%;height:95%;pointer-events:none;opacity:.6;mix-blend-mode:screen;transform-origin:50% 0;
  background:conic-gradient(from 180deg at 50% 0%,transparent 162deg,rgba(170,200,255,.14) 172deg,rgba(200,220,255,.22) 180deg,rgba(170,200,255,.14) 188deg,transparent 198deg);
  filter:blur(8px);animation:wt-ray 11s ease-in-out infinite alternate;transition:opacity 2.4s}
.wt[data-phase=day] .wt-godray{opacity:.3}
@keyframes wt-ray{from{transform:rotate(-4deg)}to{transform:rotate(4deg)}}
.wt-motes{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:screen;opacity:.8}
.wt-vignette{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 14cqw 2cqw rgba(0,0,0,.7)}

/* 3D 舞台：地面躺平再按镜头转 */
.wt-camera{position:absolute;inset:0;perspective:110cqw;perspective-origin:50% 20%;transform-style:preserve-3d;pointer-events:none}
.wt-floor{position:absolute;left:50%;top:55%;width:58cqw;height:58cqw;margin:-29cqw 0 0 -29cqw;transform-style:preserve-3d;
  transform:scale(var(--zoom)) rotateX(var(--tilt)) rotateZ(var(--orbit))}
.wt-floor-glow{position:absolute;inset:-10%;border-radius:50%;transition:background 1.2s ease;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--rune) 26%,transparent),color-mix(in srgb,var(--rune) 9%,transparent) 62%,transparent)}

/* 魔法阵：每层一张 SVG，各自转 */
.wt-circle{position:absolute;inset:0}
.wt-circle-core{position:absolute;inset:6%;border-radius:50%;transition:background 1.2s ease;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--rune) 45%,transparent),color-mix(in srgb,var(--rune) 10%,transparent) 40%,transparent 75%)}
.wt-layer{position:absolute;inset:0;filter:drop-shadow(0 0 .2cqw var(--rune)) drop-shadow(0 0 .9cqw color-mix(in srgb,var(--rune) 60%,transparent))}
.wt-layer svg{display:block;width:100%;height:100%;overflow:visible}
.wt-layer[data-spin=slow]{animation:wt-spin 140s linear infinite}
.wt-layer[data-spin=rev]{animation:wt-spin 100s linear infinite reverse}
.wt-layer[data-spin=fast]{animation:wt-spin 70s linear infinite}
@keyframes wt-spin{to{transform:rotate(360deg)}}
.wt-c-line{fill:none;stroke:var(--rune);stroke-width:.55;transition:stroke 1.2s ease}
.wt-c-thin{stroke-width:.3;opacity:.85}
.wt-c-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:wt-draw 2.2s cubic-bezier(.55,0,.2,1) forwards}
.wt-layer:nth-child(3) .wt-c-draw{animation-delay:.15s}
.wt-layer:nth-child(4) .wt-c-draw{animation-delay:.5s}
.wt-layer:nth-child(5) .wt-c-draw{animation-delay:.8s}
.wt-layer:nth-child(6) .wt-c-draw{animation-delay:1s}
@keyframes wt-draw{to{stroke-dashoffset:0}}
.wt-c-ticks line{stroke:var(--rune);stroke-width:.3;opacity:.75}
.wt-c-ticks,.wt-c-runes{animation:wt-fade 1.6s .9s both}
.wt-c-runes path{fill:none;stroke:var(--rune);stroke-width:.45;stroke-linecap:round}
@keyframes wt-fade{from{opacity:0}}
.wt-c-node{animation:wt-fade 1s 1.4s both}
.wt-c-node-core{fill:color-mix(in srgb,var(--rune) 50%,#fff);animation:wt-node 2.6s ease-in-out infinite}
.wt-c-node[data-dead] .wt-c-node-core{fill:#30364c;animation:none}
@keyframes wt-node{50%{opacity:.35}}
.wt-arcs{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.wt-arcs path{fill:none;stroke:currentColor;stroke-width:1;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;
  filter:drop-shadow(0 0 1.5px currentColor);animation:wt-draw 1.1s ease forwards}
@media (prefers-reduced-motion:reduce){.wt-layer,.wt-godray{animation:none!important}}

/* 中央的法官水晶：立在阵心，面朝镜头 */
.wt-orb-anchor{position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d}
.wt-orb-face{position:absolute;left:-2cqw;bottom:0;width:4cqw;height:9cqw;transform-origin:50% 100%;transform:rotateZ(calc(var(--orbit) * -1)) rotateX(calc(var(--tilt) * -1))}
.wt-orb{position:absolute;left:0;right:0;bottom:2cqw;height:5.2cqw;opacity:.95;
  background:linear-gradient(160deg,#fff 0%,color-mix(in srgb,var(--rune) 55%,#fff) 30%,color-mix(in srgb,var(--rune) 75%,#000) 100%);
  clip-path:polygon(50% 0,100% 40%,50% 100%,0 40%);filter:drop-shadow(0 0 1.2cqw var(--rune));animation:wt-float 4s ease-in-out infinite}
.wt-orb::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 45%,rgba(255,255,255,.55) 50%,transparent 55%)}
.wt-orb[data-live]{animation:wt-float 4s ease-in-out infinite,wt-pulse .9s ease-in-out infinite}
@keyframes wt-float{50%{translate:0 -.9cqw}}
@keyframes wt-pulse{50%{filter:drop-shadow(0 0 2.6cqw var(--rune)) brightness(1.45)}}

/* 座位：底座贴地，卡片面朝镜头 */
.wt-anchor{position:absolute;width:0;height:0;transform-style:preserve-3d}
.wt-pedestal{position:absolute;left:-3.8cqw;top:-3.8cqw;width:7.6cqw;height:7.6cqw;border-radius:50%;opacity:.55;transition:opacity .6s,box-shadow .6s,filter .6s;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--c) 60%,transparent),color-mix(in srgb,var(--c) 20%,transparent) 55%,transparent 75%);
  box-shadow:0 0 0 .16cqw color-mix(in srgb,var(--c) 55%,transparent),0 0 2cqw color-mix(in srgb,var(--c) 35%,transparent)}
.wt-pedestal[data-on]{opacity:1;box-shadow:0 0 0 .24cqw var(--c),0 0 4.5cqw .8cqw color-mix(in srgb,var(--c) 65%,transparent)}
.wt-pedestal[data-dead]{opacity:.15;filter:grayscale(1)}
/* 卡牌在 3D 场景里会按图层自身大小栅格化再放大到屏幕，立绘发糊：放大 4 倍排版、再缩回 1/4，栅格化的分辨率跟着翻 4 倍；
   will-change 让镜头过渡时也保持这个分辨率（实测锐度：原来 629 → 5637） */
.wt-card{position:absolute;left:-3.3cqw;bottom:0;width:6.6cqw;transform-origin:50% 100%;transform-style:preserve-3d;zoom:4;will-change:transform;
  transform:rotateZ(calc(var(--orbit) * -1)) rotateX(calc(var(--tilt) * -1)) scale(.25)}
.wt[data-intro] .wt-card{animation:wt-rise 1s calc(1.2s + var(--i) * .13s) cubic-bezier(.2,.9,.3,1.15) both}
@keyframes wt-rise{from{opacity:0;scale:1 .15}}
.wt-pose{position:relative;transform-origin:50% 100%;transform-style:preserve-3d;transition:transform 1s cubic-bezier(.3,.7,.2,1)}
.wt-pose[data-speaking]{transform:translateY(-.8cqw) scale(1.16)}
.wt-pose[data-dead]{transform:rotateX(64deg)}
.wt-card-inner{position:relative;width:100%;aspect-ratio:3/4;transform-style:preserve-3d;transition:transform 1.2s cubic-bezier(.3,.7,.2,1)}
.wt-pose[data-flip] .wt-card-inner{transform:rotateY(180deg)}
.wt-pose[data-flip] .wt-card-inner{transition-delay:calc(var(--i) * .15s)}
.wt-face,.wt-back{position:absolute;inset:0;border-radius:.8cqw;overflow:hidden;backface-visibility:hidden;
  border:.16cqw solid color-mix(in srgb,var(--c) 70%,#fff 15%);transition:filter .8s,box-shadow .6s;
  box-shadow:0 0 0 .1cqw rgba(0,0,0,.6),0 1.2cqw 2.4cqw rgba(0,0,0,.55),0 0 1.6cqw -.2cqw color-mix(in srgb,var(--c) 70%,transparent)}
.wt-face img,.wt-back img{width:100%;height:100%;object-fit:cover;object-position:50% 16%;display:block}
.wt-face::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(5,9,21,.6));pointer-events:none}
.wt-face-shine{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.2) 45%,transparent 58%);
  transform:translateX(-120%);animation:wt-shine 8s calc(var(--i) * .8s) ease-in-out infinite}
@keyframes wt-shine{0%,72%{transform:translateX(-120%)}88%,100%{transform:translateX(120%)}}
.wt-back{transform:rotateY(180deg);border-color:rgba(232,200,130,.8)}
.wt-back span{position:absolute;left:0;right:0;bottom:.5cqw;text-align:center;font:700 1.15cqw var(--serif);letter-spacing:.2cqw;color:#f6e6bd;
  text-shadow:0 0 .8cqw rgba(0,0,0,.95),0 0 1cqw rgba(255,210,140,.5)}
.wt-initial{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font:600 3.4cqw var(--serif);color:color-mix(in srgb,var(--c) 80%,#fff);
  background:radial-gradient(circle at 50% 35%,color-mix(in srgb,var(--c) 35%,#0b1430),#070b18)}
.wt-pose[data-dead] .wt-face,.wt-pose[data-dead] .wt-back{filter:grayscale(1) brightness(.6)}
.wt-pose[data-speaking] .wt-face{box-shadow:0 0 0 .2cqw var(--c),0 0 3.4cqw .5cqw color-mix(in srgb,var(--c) 70%,transparent),0 1.2cqw 2.4cqw rgba(0,0,0,.55)}
.wt-pose[data-awake=wolf] .wt-face{box-shadow:0 0 0 .22cqw #ff3d5e,0 0 3.4cqw .6cqw rgba(255,50,90,.65)}
.wt-pose[data-awake=seer] .wt-face{box-shadow:0 0 0 .22cqw #b48cff,0 0 3.4cqw .6cqw rgba(160,110,255,.6)}
.wt-pose[data-awake=witch] .wt-face{box-shadow:0 0 0 .22cqw #42f0a8,0 0 3.4cqw .6cqw rgba(60,230,160,.55)}
.wt[data-phase=night] .wt-pose:not([data-awake]):not([data-dead]):not([data-speaking]) .wt-face img{filter:brightness(.5) saturate(.8)}
.wt-beam{position:absolute;left:-35%;right:-35%;bottom:15%;height:26cqw;pointer-events:none;
  background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--c) 20%,transparent) 55%,color-mix(in srgb,var(--c) 36%,transparent));
  clip-path:polygon(42% 0,58% 0,100% 100%,0 100%);filter:blur(.4cqw);animation:wt-fade 1.2s ease}
.wt-stamp{position:absolute;left:50%;top:46%;z-index:2;white-space:nowrap;transform:translate(-50%,-50%) rotate(-12deg);
  font:700 .95cqw var(--serif);letter-spacing:.12cqw;color:#ffb3bf;padding:.25cqw .6cqw;border:.14cqw solid rgba(255,140,160,.8);border-radius:.35cqw;
  background:rgba(40,8,16,.6);animation:wt-stamp .5s .5s cubic-bezier(.2,.9,.3,1.4) both}
@keyframes wt-stamp{from{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(1.8)}}
.wt-votes{position:absolute;right:.35cqw;bottom:2.4cqw;z-index:2;min-width:1.7cqw;height:1.7cqw;display:flex;align-items:center;justify-content:center;
  font:700 1cqw var(--dg-mono);color:#fff;border-radius:99px;background:radial-gradient(circle at 35% 30%,#ff9ab0,#d23a5c);box-shadow:0 0 1.2cqw rgba(255,90,130,.8)}
.wt-plate{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:.3cqw;padding:.3cqw .25cqw .35cqw;white-space:nowrap;overflow:hidden;
  border-top:1px solid color-mix(in srgb,var(--c) 55%,transparent);
  background:linear-gradient(180deg,rgba(10,16,36,.55),rgba(6,10,24,.92));font:500 max(.8cqw,9.5px)/1 system-ui,sans-serif}
.wt-no{position:absolute;right:.3cqw;top:.3cqw;z-index:3;display:flex;align-items:center;justify-content:center;min-width:max(1.35cqw,14px);height:max(1.35cqw,14px);
  border-radius:99px;font:700 max(.8cqw,9px) var(--dg-mono);color:#0a1020;background:var(--c);box-shadow:0 0 .6cqw rgba(0,0,0,.6)}
.wt-plate span{overflow:hidden;text-overflow:ellipsis}
.wt-role{position:absolute;left:0;top:.35cqw;z-index:2;padding:.1cqw .45cqw .1cqw .35cqw;border-radius:0 99px 99px 0;font:600 max(.7cqw,9px)/1.4 var(--serif);font-style:normal;
  color:#f3e7c6;background:rgba(10,14,30,.82);border:1px solid rgba(214,190,130,.45);border-left:0}
.wt-role[data-role=wolf]{color:#ffb3c0;border-color:rgba(255,120,150,.55)}
.wt-pose[data-flip] .wt-role{display:none}
.wt-back small{display:block;margin-top:.15cqw;font:500 max(.62cqw,8.5px) system-ui,sans-serif;letter-spacing:0;color:#d9dff0}
.wt-driver{display:block;margin-top:.2cqw;text-align:center;font:500 max(.62cqw,8.5px) var(--dg-mono);color:rgba(170,190,230,.8);text-shadow:0 0 .4cqw #000;white-space:nowrap}
.wt-thinking{width:max-content;margin:.3cqw auto 0;padding:.15cqw .55cqw;border-radius:99px;font-size:max(.7cqw,9.5px);color:#dff6ff;
  background:rgba(40,110,170,.55);border:1px solid rgba(134,220,255,.5);box-shadow:0 0 1cqw rgba(134,220,255,.45)}
.wt-thinking i{display:inline-block;width:.25cqw;height:.25cqw;min-width:2px;min-height:2px;margin-left:.15cqw;border-radius:50%;background:currentColor;animation:wt-dot 1.2s ease-in-out infinite}
.wt-thinking i:nth-child(2){animation-delay:.2s}
.wt-thinking i:nth-child(3){animation-delay:.4s}
@keyframes wt-dot{0%,100%{opacity:.25}50%{opacity:1}}
.wt-fault{position:absolute;right:.3cqw;top:max(2cqw,20px);z-index:2;padding:.1cqw .45cqw;border-radius:99px;font:700 max(.8cqw,9px) var(--dg-mono);color:#2a1600;
  background:radial-gradient(circle at 35% 30%,#ffe2a8,#ffb03b);box-shadow:0 0 1cqw rgba(255,170,60,.8)}

/* 画面小的时候（游戏标签里没开影院模式）：魔法阵往上挪给对白框让位，卡片大一点，模型名只在思考时显示，心声只留最新一条 */
@container (max-width: 820px){
  .wt-floor{top:49%}
  .wt-card{left:-3.8cqw;width:7.6cqw}
  .wt-driver:not(.wt-thinking){display:none}
  .wt-inners{width:28cqw}
  .wt-inner:not(:last-child){display:none}
  .wt-inner p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .wt-dialog{width:88%;bottom:1cqw;padding:.6cqw 1cqw;gap:1cqw}
  .wt-dialog-face{width:max(4.2cqw,30px);height:max(4.2cqw,30px)}
  .wt-dialog-body p{min-height:0}
  .wt-banner b{font-size:max(2.6cqw,17px)}
}

/* 座位标记：刀 / 救 / 毒 / 验 */
.wt-marks{position:absolute;left:.3cqw;bottom:max(1.9cqw,20px);z-index:3;display:flex;flex-direction:column;gap:.2cqw;align-items:flex-start}
.wt-marks em{font:700 max(.72cqw,9px)/1.4 var(--serif);font-style:normal;padding:0 .4cqw;border-radius:.3cqw;color:#fff;box-shadow:0 0 .8cqw rgba(0,0,0,.6);animation:wt-mark-in .4s cubic-bezier(.2,.9,.3,1.4)}
.wt-marks em[data-mark=kill]{background:#d8243f;box-shadow:0 0 1cqw rgba(255,40,70,.8)}
.wt-marks em[data-mark=save]{background:#2fae6a;box-shadow:0 0 1cqw rgba(80,255,150,.7)}
.wt-marks em[data-mark=poison]{background:#6a1fa8;box-shadow:0 0 1cqw rgba(170,80,255,.8)}
.wt-marks em[data-mark=check-wolf]{background:#5b1426;border:1px solid #ff6b8a}
.wt-marks em[data-mark=check-good]{background:#4d3d10;border:1px solid #f5cd76}
@keyframes wt-mark-in{from{transform:scale(2.2);opacity:0}}

/* 地面特效：能量线（光晕 + 亮芯 + 流动光点）、目标光环、药水 */
.wt-floorfx{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.wt-energy path{fill:none;stroke:currentColor;stroke-linecap:round}
.wt-energy-glow{stroke-width:3.2;opacity:.35;filter:blur(1.2px);stroke-dasharray:1;stroke-dashoffset:1;animation:wt-draw .6s ease-out forwards}
.wt-energy-core{stroke-width:1.1;stroke-dasharray:1;stroke-dashoffset:1;filter:drop-shadow(0 0 1.2px currentColor) drop-shadow(0 0 3px currentColor);animation:wt-draw .6s ease-out forwards}
.wt-energy-flow{stroke:#fff!important;stroke-width:.9;stroke-dasharray:.015 .06;opacity:0;filter:drop-shadow(0 0 2px currentColor);animation:wt-flow 1.1s linear infinite,wt-fade-in-to .3s forwards}
@keyframes wt-flow{from{stroke-dashoffset:.075}to{stroke-dashoffset:0}}
@keyframes wt-fade-in-to{to{opacity:.9}}
.wt-energy-head{fill:currentColor;stroke:none!important;opacity:0;filter:drop-shadow(0 0 2px currentColor);animation:wt-fade-in-to .3s forwards}
.wt-ring{animation:wt-fade .5s ease-out}
.wt-ring circle{fill:none;stroke:currentColor;stroke-width:.9;filter:drop-shadow(0 0 2px currentColor)}
.wt-ring .wt-ring-out{stroke-width:.4;opacity:.6;transform-box:fill-box;transform-origin:center;animation:wt-ring-pulse 1.4s ease-out infinite}
@keyframes wt-ring-pulse{from{opacity:.8;scale:.7}to{opacity:0;scale:1.4}}
.wt-potion{fill:#fff;stroke:currentColor;stroke-width:1.2;filter:drop-shadow(0 0 3px currentColor) drop-shadow(0 0 6px currentColor)}
.wt[data-voting] .wt-circle{opacity:.55;transition:opacity .8s}

/* 字幕：这一拍发生了什么 */
.wt-caption{position:absolute;left:50%;top:max(7.2cqw,62px);transform:translateX(-50%);z-index:6;pointer-events:none;white-space:nowrap;
  padding:.45cqw 1.4cqw;border-radius:99px;font:600 max(1.1cqw,13px) var(--serif);letter-spacing:.1cqw;color:#fff;
  background:rgba(10,12,28,.82);border:1px solid rgba(255,255,255,.25);box-shadow:0 .6cqw 2cqw rgba(0,0,0,.6);animation:wt-rise-in .35s ease}
.wt-caption[data-act=kill]{border-color:#ff4d6d;box-shadow:0 0 2cqw -.4cqw #ff2d55}
.wt-caption[data-act=check]{border-color:#b48cff;box-shadow:0 0 2cqw -.4cqw #a070ff}
.wt-caption[data-act=save]{border-color:#42f0a8}
.wt-caption[data-act=poison]{border-color:#b05cff}
.wt-caption[data-act=shoot]{border-color:#ffb347}

/* 对白框里的心声 / 狼队私聊 */
.wt-dialog[data-tag=inner]{border-style:dashed;background:linear-gradient(180deg,rgba(20,18,44,.82),rgba(10,10,28,.9))}
.wt-dialog[data-tag=inner] .wt-dialog-body p{font-family:var(--serif);font-style:italic;color:#d9d4ff}
.wt-dialog[data-tag=wolf]{border-color:rgba(255,80,110,.7);box-shadow:0 1cqw 3cqw rgba(0,0,0,.6),0 0 3cqw -1cqw rgba(255,60,90,.8)}
.wt-dialog[data-tag=wolf] .wt-dialog-body b{color:#ff9aac}

/* 标题 */
.wt-banner{position:absolute;left:50%;top:1.8cqw;transform:translateX(-50%);text-align:center;z-index:5;pointer-events:none;animation:wt-banner 1.1s cubic-bezier(.2,.8,.2,1)}
.wt-banner b{display:block;white-space:nowrap;font:600 2.6cqw/1.1 var(--serif);letter-spacing:.5cqw;color:#f6ecd0;
  text-shadow:0 0 1.4cqw color-mix(in srgb,var(--rune) 70%,transparent),0 .2cqw .4cqw rgba(0,0,0,.8)}
.wt-banner small{display:block;margin-top:.45cqw;font:500 max(1cqw,11px) var(--serif);letter-spacing:.45cqw;color:color-mix(in srgb,var(--rune) 65%,#fff);text-shadow:0 0 .6cqw #000}
.wt-banner-orn{display:block;width:22cqw;height:1cqw;margin:0 auto .4cqw;
  background:radial-gradient(circle,color-mix(in srgb,var(--rune) 80%,#fff) 0 .22cqw,transparent .3cqw) center/1cqw 1cqw no-repeat,
  linear-gradient(90deg,transparent,color-mix(in srgb,var(--rune) 80%,#fff) 50%,transparent) center/100% 1px no-repeat}
.wt[data-phase=end] .wt-banner b{font-size:3.4cqw}
@keyframes wt-banner{from{opacity:0;letter-spacing:1.4cqw;filter:blur(.4cqw)}}

/* 对白框（视觉小说式） */
.wt-dialog{position:absolute;left:50%;bottom:1.2cqw;transform:translateX(-50%);width:min(60cqw,92%);z-index:6;display:flex;gap:1.2cqw;align-items:flex-start;
  padding:.8cqw 1.3cqw;border-radius:1.1cqw;background:linear-gradient(180deg,rgba(12,18,42,.86),rgba(6,10,26,.92));
  border:1px solid color-mix(in srgb,var(--c) 45%,rgba(214,190,130,.4));backdrop-filter:blur(12px);
  box-shadow:0 1cqw 3cqw rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06),0 0 3cqw -1cqw color-mix(in srgb,var(--c) 60%,transparent);animation:wt-rise-in .35s ease}
.wt-dialog::before{content:"";position:absolute;left:1.4cqw;right:1.4cqw;top:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--c),transparent)}
@keyframes wt-rise-in{from{opacity:0;translate:0 .8cqw}}
.wt-dialog-face{flex:none;width:4.2cqw;height:4.2cqw;border-radius:50%;overflow:hidden;border:.16cqw solid var(--c);box-shadow:0 0 1.4cqw color-mix(in srgb,var(--c) 55%,transparent)}
.wt-dialog-face img{width:100%;height:100%;object-fit:cover;object-position:50% 14%}
.wt-dialog-orb{display:block;width:100%;height:100%;background:radial-gradient(circle at 40% 35%,#fff,color-mix(in srgb,var(--c) 70%,#fff) 30%,color-mix(in srgb,var(--c) 60%,#000) 100%)}
.wt-dialog-body{min-width:0;flex:1}
.wt-dialog-body b{font:600 max(1.05cqw,12px) var(--serif);letter-spacing:.12cqw;color:var(--c)}
.wt-dialog-body p{margin:.25cqw 0 0;font:max(1.2cqw,13px)/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#eef3ff;min-height:3.8cqw}
.wt-dialog[data-narrator] .wt-dialog-body p{font-family:var(--serif);color:#f3ead2}
.wt-caret{display:inline-block;width:.45cqw;height:1.2cqw;margin-left:.25cqw;vertical-align:-.12cqw;background:var(--c);animation:wt-blink 1s steps(1) infinite}
@keyframes wt-blink{50%{opacity:0}}

/* 心声（上帝视角） */
.wt-inners{position:absolute;right:1.4cqw;top:4.4cqw;width:21cqw;z-index:6;display:flex;flex-direction:column;gap:.7cqw}
.wt-inner{display:flex;gap:.7cqw;padding:.6cqw .8cqw;border-radius:.9cqw;background:rgba(8,12,30,.72);border:1px dashed color-mix(in srgb,var(--c) 45%,transparent);
  backdrop-filter:blur(10px);animation:wt-rise-in .35s ease}
.wt-inner-face{flex:none;width:2.6cqw;height:2.6cqw;border-radius:50%;overflow:hidden;border:1px solid var(--c)}
.wt-inner-face img{width:100%;height:100%;object-fit:cover;object-position:50% 14%}
.wt-inner b{display:block;font:600 max(.72cqw,9.5px) var(--dg-mono);color:var(--c)}
.wt-inner p{margin:.15cqw 0 0;font:italic max(.9cqw,11px)/1.5 var(--serif);color:#cdd6f0}

/* 顶栏、记录 */
.wt-hud{position:absolute;left:1.4cqw;right:1.4cqw;top:1.2cqw;display:flex;justify-content:space-between;align-items:center;z-index:7;pointer-events:none}
.wt-hud > *{pointer-events:auto}
.wt-hud-right,.wt-hud-left{display:flex;gap:.6cqw}
/* 主人选人：能选的牌可以点、亮金边，不能选的压暗；选中的头上挂动词 */
.wt[data-picking] .wt-card[data-pick=can],.wt[data-picking] .wt-card[data-pick=picked]{pointer-events:auto;cursor:pointer}
.wt[data-picking] .wt-card[data-pick=can] .wt-face{box-shadow:0 0 0 .14cqw rgba(255,214,130,.7),0 0 1.6cqw rgba(255,210,120,.35)}
.wt[data-picking] .wt-card[data-pick=can]:hover .wt-face{box-shadow:0 0 0 .22cqw #ffd982,0 0 3cqw .4cqw rgba(255,210,120,.65)}
.wt[data-picking] .wt-card[data-pick=picked] .wt-face{box-shadow:0 0 0 .26cqw #fff1c4,0 0 3.6cqw .7cqw rgba(255,214,130,.85)}
.wt[data-picking] .wt-card[data-pick=off] .wt-pose{filter:brightness(.45) saturate(.6)}
.wt-pick-tag{position:absolute;left:50%;top:-1.9cqw;transform:translateX(-50%);z-index:4;white-space:nowrap;font:700 max(1.05cqw,12px) var(--serif);color:#2a1b02;
  background:linear-gradient(#ffe7a8,#d9a94a);border-radius:99px;padding:.15em .7em;box-shadow:0 0 1cqw rgba(255,210,120,.8)}
/* 行动条：叠在牌桌底部，对白框让到它上面 */
.wt-bar{position:absolute;left:50%;bottom:1.2cqw;transform:translateX(-50%);z-index:8;width:min(64cqw,94%);display:flex;align-items:center;gap:.8cqw;
  padding:.7cqw 1cqw;border-radius:1cqw;border:1px solid rgba(231,201,138,.7);background:linear-gradient(rgba(30,22,8,.86),rgba(12,10,22,.92));
  box-shadow:0 0 2.4cqw rgba(255,210,120,.35);font-size:max(1.05cqw,12px);animation:wt-bar-in .35s cubic-bezier(.2,.8,.2,1)}
@keyframes wt-bar-in{from{opacity:0;transform:translate(-50%,40%)}}
.wt[data-turn] .wt-dialog{bottom:calc(1.2cqw + max(3.6cqw,40px))}
/* 对白框只是显示：点击穿过去；主人选人时变淡，后面的牌看得见、点得到 */
.wt-dialog{pointer-events:none}
.wt[data-picking] .wt-dialog{opacity:.3;transition:opacity .3s}
.wt-bar-label{flex:none;font:700 max(1.15cqw,13px) var(--serif);color:#f3dca6;letter-spacing:.1em}
.wt-bar input{flex:1;min-width:0;background:rgba(0,0,0,.35);border:1px solid rgba(231,201,138,.35);border-radius:.6cqw;outline:none;color:#fff3dc;
  padding:.5cqw .8cqw;font:inherit}
.wt-bar input:focus{border-color:#e7c98a}
.wt-bar button{flex:none;font:inherit;border-radius:.6cqw;padding:.45cqw .9cqw;cursor:pointer;white-space:nowrap;transition:all .15s}
.wt-bar button:disabled{opacity:.45;cursor:default}
.wt-bar-go,.wt-bar-act{color:#2a1b02;font-weight:700;background:linear-gradient(#ffe7a8,#d9a94a);border:1px solid #ffe7a8}
.wt-bar-act[data-act=kill]{background:linear-gradient(#ff8fa5,#d8304f);color:#fff;border-color:#ffb3c2}
.wt-bar-act[data-act=check]{background:linear-gradient(#d9c4ff,#8f62e8);color:#fff;border-color:#e2d3ff}
.wt-bar-act[data-act=save]{background:linear-gradient(#b4ffd6,#2fbf7c);color:#06261a;border-color:#c9ffe3}
.wt-bar-act[data-act=poison]{background:linear-gradient(#e7b8ff,#9a3fd6);color:#fff;border-color:#f0d0ff}
.wt-bar-act[data-act=shoot]{background:linear-gradient(#ffd9a0,#e08a1e);color:#2a1300;border-color:#ffe3b8}
.wt-bar-soft{color:#d9c9a4;background:transparent;border:1px solid rgba(231,201,138,.35)}
.wt-bar-soft:hover:not(:disabled){border-color:#e7c98a;color:#f3dca6}
.wt-bar-note,.wt-bar-hint{flex:none;color:#cbb88f}
.wt-bar-hint{flex:1;opacity:.85;animation:wt-hint 1.6s ease-in-out infinite}
@keyframes wt-hint{50%{opacity:.45}}
.wt-bar-error{flex:none;max-width:30%;color:#ff9db0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wt-notes{position:absolute;right:1.4cqw;top:4.4cqw;z-index:9;width:min(34cqw,90%);max-height:60%;overflow:auto;padding:1cqw 1.3cqw;border-radius:1cqw;
  border:1px solid rgba(231,201,138,.45);background:rgba(10,12,26,.94);backdrop-filter:blur(8px);font-size:max(1cqw,12px);line-height:1.6}
.wt-notes p{margin:0 0 .3em}
.wt-notes-ask{color:#f3dca6}
.wt-chip-you{color:#f3dca6;border-color:rgba(231,201,138,.55);background:rgba(36,26,8,.62)}
.wt-you{position:absolute;right:6%;top:5%;z-index:3;font:700 max(1cqw,12px) var(--serif);color:#2a1b02;background:linear-gradient(#ffe7a8,#d9a94a);border-radius:99px;padding:.1em .5em;box-shadow:0 0 .8cqw rgba(255,210,120,.8)}
.wt-anchor[data-owner] .wt-pedestal{box-shadow:0 0 1.6cqw rgba(255,214,130,.55)}
.wt-chip-fault{cursor:pointer;color:#ffd08a;border-color:rgba(255,190,110,.45);background:rgba(40,22,6,.6)}
.wt-chip,.wt-toggle{font:500 max(.88cqw,11px) var(--dg-mono);color:#b9c8ee;padding:.35cqw .8cqw;border-radius:99px;background:rgba(8,12,30,.6);
  border:1px solid rgba(150,190,255,.2);backdrop-filter:blur(8px)}
.wt-toggle{cursor:pointer;transition:all .15s}
.wt-toggle:hover{border-color:rgba(150,200,255,.45);color:#e6f4ff}
.wt-toggle[data-on]{color:#f3e7c6;border-color:rgba(214,190,130,.55);box-shadow:0 0 1.2cqw -.3cqw rgba(214,190,130,.55)}
.wt-log{position:absolute;left:1.4cqw;top:4cqw;bottom:1.4cqw;width:26cqw;z-index:8;display:flex;flex-direction:column;border-radius:1cqw;
  background:rgba(6,10,26,.9);border:1px solid rgba(150,190,255,.18);backdrop-filter:blur(14px);box-shadow:0 1cqw 3cqw rgba(0,0,0,.5);animation:wt-rise-in .25s ease}
.wt-log-head{display:flex;justify-content:space-between;align-items:center;padding:.7cqw 1cqw;border-bottom:1px solid rgba(150,190,255,.12);font:600 .95cqw var(--serif);color:#f3e7c6}
.wt-log-head button{font:.8cqw var(--dg-mono);color:#8ea2d6;background:none;border:0;cursor:pointer}
.wt-log ol{list-style:none;margin:0;padding:.6cqw 1cqw;overflow:auto;flex:1;display:flex;flex-direction:column;gap:.55cqw}
.wt-log li{font:max(.88cqw,12px)/1.55 system-ui,sans-serif;color:#dbe4ff}
.wt-log li b{display:block;font:600 .78cqw var(--dg-mono);color:#9fb6ec;margin-bottom:.1cqw}
.wt-log-n{color:#e9d9ad!important;font-family:var(--serif)!important}
.wt-log-w b{color:#ff9aac!important}
.wt-log-i{font-style:italic;color:#aab6d8!important}
.wt-log-a{color:#a9c7ff!important}
.wt-log-f{color:#ffd08a!important}
.wt-log-f b{color:#ffb35c!important}
.wt-log-i{font-style:italic}
.wt-log-v{color:#ffc2cb!important;font-family:var(--dg-mono)!important;font-size:.8cqw!important}
`;
