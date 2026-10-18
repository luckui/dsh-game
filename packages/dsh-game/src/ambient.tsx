/**
 * 背景氛围层：很淡的代码雨 + 斜斜的雨丝，铺满父元素，放在毛玻璃面板后面（透过玻璃看是虚的）。
 * 一个 canvas、最多 30 帧/秒；页面不可见时停；系统设置了「减少动态效果」时放慢。
 */

import React, { useEffect, useRef } from 'react';

/** 代码雨的字：十六进制、片假名、一些符号；偶尔落下一个「鲸」或「饭」 */
const GLYPHS = '0123456789abcdefアイウエオカキクケコサシスセソタチツテトナニヌネノ{}[]<>/=+*;:$#';
const EASTER = '鲸饭';

interface Column { x: number; y: number; speed: number; length: number; glyphs: string[] }
interface Drop { x: number; y: number; speed: number; length: number; alpha: number }

export function Ambient({ density = 1 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cell = 16;
    let width = 0;
    let height = 0;
    let columns: Column[] = [];
    let drops: Drop[] = [];

    const glyph = () => (Math.random() < 0.004 ? EASTER[Math.floor(Math.random() * EASTER.length)] : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
    const column = (x: number, y = -Math.random() * height): Column => {
      const length = 6 + Math.floor(Math.random() * 16);
      return { x, y, speed: 0.6 + Math.random() * 1.4, length, glyphs: Array.from({ length }, glyph) };
    };
    const drop = (top = false): Drop => ({
      x: Math.random() * (width + 200) - 100,
      y: top ? -Math.random() * 200 : Math.random() * height,
      speed: 7 + Math.random() * 9,
      length: 18 + Math.random() * 46,
      alpha: 0.05 + Math.random() * 0.13,
    });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 代码雨只占一部分列，稀稀落落的
      columns = [];
      for (let x = 0; x < width; x += cell) if (Math.random() < 0.28 * density) columns.push(column(x, Math.random() * height));
      drops = Array.from({ length: Math.round((width * height) / 9000 * density) }, () => drop());
    };

    const draw = () => {
      g.clearRect(0, 0, width, height);
      g.font = `13px "JetBrains Mono", "Cascadia Code", Consolas, monospace`;
      g.textAlign = 'center';
      for (const c of columns) {
        for (let i = 0; i < c.length; i++) {
          const y = c.y - i * cell;
          if (y < -cell || y > height + cell) continue;
          // 头一个字最亮，越往后越淡
          const a = i === 0 ? 0.42 : 0.16 * (1 - i / c.length);
          g.fillStyle = i === 0 ? `rgba(190,236,255,${a})` : `rgba(90,170,255,${a})`;
          g.fillText(c.glyphs[i], c.x + cell / 2, y);
        }
      }
      g.lineWidth = 1;
      for (const d of drops) {
        const grd = g.createLinearGradient(d.x, d.y - d.length, d.x - d.length * 0.18, d.y);
        grd.addColorStop(0, 'rgba(160,210,255,0)');
        grd.addColorStop(1, `rgba(160,210,255,${d.alpha})`);
        g.strokeStyle = grd;
        g.beginPath();
        g.moveTo(d.x + d.length * 0.18, d.y - d.length);
        g.lineTo(d.x, d.y);
        g.stroke();
      }
    };

    const step = (pace: number) => {
      for (const c of columns) {
        c.y += c.speed * pace;
        if (Math.random() < 0.02) c.glyphs[Math.floor(Math.random() * c.length)] = glyph();
        if (c.y - c.length * cell > height) Object.assign(c, column(c.x));
      }
      for (const d of drops) {
        d.y += d.speed * pace;
        d.x -= d.speed * 0.18 * pace;
        if (d.y - d.length > height) Object.assign(d, drop(true));
      }
    };

    resize();
    draw();
    const observer = new ResizeObserver(() => {
      resize();
      draw();
    });
    observer.observe(canvas);
    // 系统要求减少动态效果时（远程桌面、关了「动画效果」的 Windows 很常见）：雨照下，但慢下来、帧率减半
    const pace = still ? 0.35 : 1;
    const interval = still ? 66 : 33;
    let raf = 0;
    let last = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < interval) return;
      last = t;
      step(pace);
      draw();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [density]);

  return <canvas ref={ref} className="dg-ambient" aria-hidden="true" />;
}

/** 幽蓝房间的共用样式：背景层、毛玻璃、荧光细线、轻按钮 */
export const ROOM_CSS = `
.dg-room{--dg-ink:#d6e4ff;--dg-dim:#7f92b6;--dg-faint:#4d5d7e;--dg-cyan:#86dcff;--dg-mint:#74f0cf;
  --dg-glass:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.018));--dg-line:rgba(150,195,255,.13);--dg-line-hi:rgba(134,220,255,.42);
  --dg-mono:"JetBrains Mono","Cascadia Code",Consolas,ui-monospace,monospace;
  position:relative;isolation:isolate;color:var(--dg-ink);font-family:system-ui,sans-serif;
  background:radial-gradient(1100px 650px at 85% -10%,rgba(46,96,200,.22),transparent 60%),
    radial-gradient(900px 600px at -5% 110%,rgba(24,64,150,.2),transparent 60%),linear-gradient(180deg,#070b18,#04060d)}
.dg-ambient{position:absolute;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
.dg-glass{background:var(--dg-glass);border:1px solid var(--dg-line);border-radius:16px;
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.dg-btn{font:500 13px/1 var(--dg-mono);letter-spacing:.3px;color:#bfeaff;background:rgba(134,220,255,.06);border:1px solid rgba(134,220,255,.32);
  border-radius:10px;padding:9px 14px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:all .16s ease}
.dg-btn:hover{background:rgba(134,220,255,.12);border-color:rgba(134,220,255,.6);color:#e6f8ff;box-shadow:0 0 18px -4px rgba(134,220,255,.55);text-shadow:0 0 8px rgba(134,220,255,.6)}
.dg-btn[aria-busy=true]{opacity:.55;cursor:progress}
`;
