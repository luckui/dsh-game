/**
 * Minecraft 的开局设置（游戏库里选中 Minecraft 时，横幅下面）：玩法、服务器、她的名字、摄像机客户端。
 *   - 玩法两张卡：单人（她自己玩，你在旁边看）；和你一起玩是下一阶段，先放着、点不了
 *   - 文字框离开时保存，开关点了就保存；存完宿主重新检查一遍（/api/dsh-game/mc-setup）
 *   - 每一项检查一行 ✓ / ✗：服务器连没连上（什么版本、几个人在线）、名字、客户端、Java、RCON、HUD 网页
 *   - 有问题时「让大肥鱼玩」按钮不能点，并写出原因
 * 设置和检查都在宿主（games/minecraft/setup.ts），这里只显示和改。
 */

import React, { useCallback, useEffect, useState } from 'react';

interface McSetup {
  mode: 'solo' | 'duo';
  ownerName: string;
  host: string;
  port: number;
  username: string;
  camera: boolean;
  cameraName: string;
  rconPort: number;
  rconPassword: string;
  clientDir: string;
  java: string;
  hudPort: number;
}
interface CheckItem { ok: boolean; label: string; problem?: string }
export interface McSetupCheck {
  setup: McSetup;
  version: string | null;
  items: Record<'server' | 'names' | 'client' | 'java' | 'rcon' | 'hud', CheckItem>;
  problem: string | null;
}

async function request(body?: Partial<McSetup>): Promise<McSetupCheck> {
  const res = await fetch('/api/dsh-game/mc-setup', body
    ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as McSetupCheck;
}

const ITEM_NAMES: [keyof McSetupCheck['items'], string][] = [
  ['server', '服务器'], ['names', '名字'], ['client', '客户端'], ['java', 'Java'], ['rcon', 'RCON'], ['hud', 'HUD 网页'],
];

/** 一个文字框：改的时候只改草稿，离开（或回车）才保存 */
function Field({ label, value, type = 'text', placeholder, hint, disabled, onSave }: {
  label: string; value: string | number; type?: 'text' | 'number' | 'password'; placeholder?: string; hint?: string; disabled?: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => { if (draft !== String(value)) onSave(draft); };
  return (
    <label className="dg-mc-field">
      <span>{label}</span>
      <input
        type={type}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function McSetupPanel({ onCheck }: { onCheck: (check: McSetupCheck | null) => void }) {
  const [check, setCheck] = useState<McSetupCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(async (patch?: Partial<McSetup>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await request(patch);
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

  if (!check) return <section className="dg-mc"><div className="dg-mc-loading">{error ? `! 读不到开局设置：${error}` : '正在检查服务器和客户端……'}</div></section>;

  const { setup, items } = check;
  const save = (patch: Partial<McSetup>) => void apply(patch);
  const num = (v: string) => Number.parseInt(v, 10) || 0;

  return (
    <section className="dg-mc" aria-busy={busy}>
      <header className="dg-mc-head">
        <div>
          <h2>开局设置</h2>
          <p>她进哪个服务器、叫什么、怎么看她。改了就保存，保存完马上重新检查。</p>
        </div>
        <button className="dg-mc-btn" disabled={busy} onClick={() => void apply()}>{busy ? '检查中…' : '重新检查'}</button>
      </header>

      <div className="dg-mc-modes" role="radiogroup" aria-label="玩法">
        <button type="button" className="dg-mc-mode" role="radio" aria-checked={setup.mode === 'solo'} data-on={setup.mode === 'solo' ? '' : undefined} disabled={busy}>
          <b>她自己玩</b>
          <small>你在旁边看，想让她做什么就跟她说</small>
        </button>
        <button type="button" className="dg-mc-mode" role="radio" aria-checked={false} disabled>
          <b>和你一起玩</b>
          <small>你用自己的客户端进同一个服务器 · 下一阶段</small>
        </button>
      </div>

      <div className="dg-mc-cols">
        <div className="dg-mc-group">
          <h3>服务器</h3>
          <div className="dg-mc-row">
            <Field label="地址" value={setup.host} disabled={busy} onSave={(v) => save({ host: v })} />
            <Field label="端口" value={setup.port} type="number" disabled={busy} onSave={(v) => save({ port: num(v) })} />
          </div>
          <Field label="她在游戏里的名字" value={setup.username} hint="3~16 个英文字母、数字或下划线" disabled={busy} onSave={(v) => save({ username: v })} />
          <p className="dg-mc-note">Java 版、离线模式（online-mode=false）的服务器。她用离线账户进服，不需要正版账号。</p>
        </div>

        <div className="dg-mc-group">
          <h3>
            看她的画面
            <label className="dg-mc-switch">
              <input type="checkbox" checked={setup.camera} disabled={busy} onChange={(e) => save({ camera: e.target.checked })} />
              <span>{setup.camera ? '开摄像机客户端' : '不开'}</span>
            </label>
          </h3>
          {setup.camera ? (
            <>
              <p className="dg-mc-note">开一个真的 Minecraft 客户端，旁观模式挂在她身上：画面就是她的视角，可以切到背后、正面。直播时 OBS 抓这个窗口。</p>
              <div className="dg-mc-row">
                <Field label="摄像机的名字" value={setup.cameraName} disabled={busy} onSave={(v) => save({ cameraName: v })} />
                <Field label="HUD 网页端口" value={setup.hudPort} type="number" hint="0 = 不开" disabled={busy} onSave={(v) => save({ hudPort: num(v) })} />
              </div>
              <div className="dg-mc-row">
                <Field label="RCON 端口" value={setup.rconPort} type="number" disabled={busy} onSave={(v) => save({ rconPort: num(v) })} />
                <Field label="RCON 密码" value={setup.rconPassword} type="password" hint="server.properties 里的 rcon.password" disabled={busy} onSave={(v) => save({ rconPassword: v })} />
              </div>
              <Field label=".minecraft 目录" value={setup.clientDir} placeholder="不填：官方启动器的默认位置" hint="HMCL 或官方启动器装好服务器的那个版本" disabled={busy} onSave={(v) => save({ clientDir: v })} />
              <Field label="Java 21" value={setup.java} placeholder="不填：自动找 HMCL / 官方启动器带的" disabled={busy} onSave={(v) => save({ java: v })} />
            </>
          ) : (
            <p className="dg-mc-note">不开的话，你用自己的客户端进服、切旁观模式看她（/gamemode spectator，再 /spectate 她的名字）。</p>
          )}
        </div>
      </div>

      <ul className="dg-mc-checks">
        {ITEM_NAMES.map(([key, name]) => {
          const item = items[key];
          return (
            <li key={key} data-bad={item.ok ? undefined : ''}>
              <i>{item.ok ? '✓' : '✗'}</i>
              <b>{name}</b>
              <span title={item.problem ?? item.label}>{item.ok ? item.label : item.problem}</span>
            </li>
          );
        })}
      </ul>
      {error && <div className="dg-mc-problem">! {error}</div>}
    </section>
  );
}

export const MC_SETUP_CSS = `
.dg-mc{--grass:#7bd36b;--grass-dim:rgba(123,211,107,.35);--dirt:#8a5a3b;
  position:relative;margin-top:22px;padding:20px 22px 18px;border-radius:14px;transition:opacity .2s;
  background:linear-gradient(180deg,rgba(18,30,22,.92),rgba(8,12,14,.96));border:1px solid var(--grass-dim);
  box-shadow:0 24px 60px -26px rgba(0,0,0,.85),inset 0 3px 0 -1px rgba(123,211,107,.55),inset 0 0 0 1px rgba(0,0,0,.5)}
.dg-mc[aria-busy=true]{opacity:.85}
.dg-mc-loading{font:12px var(--dg-mono);color:var(--dg-dim)}
.dg-mc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.dg-mc-head h2{margin:0;font-size:18px;font-weight:700;letter-spacing:2px;color:#eaffe2}
.dg-mc-head p{margin:5px 0 0;font-size:12px;color:rgba(222,240,226,.7)}
.dg-mc-btn{flex:none;font-size:13px;color:#eaffe2;padding:7px 14px;border-radius:8px;cursor:pointer;background:rgba(40,70,40,.7);border:1px solid var(--grass-dim);transition:background .15s}
.dg-mc-btn:hover:not(:disabled){background:rgba(60,100,56,.85)}
.dg-mc-btn:disabled{opacity:.55;cursor:default}
.dg-mc-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0}
.dg-mc-mode{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 14px;border-radius:10px;text-align:left;font:inherit;color:inherit;cursor:default;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1)}
.dg-mc-mode b{font-size:14px;color:#eaffe2}
.dg-mc-mode small{font-size:11px;line-height:1.5;color:rgba(222,240,226,.6)}
.dg-mc-mode[data-on]{background:rgba(123,211,107,.12);border-color:var(--grass);box-shadow:inset 3px 0 0 var(--grass)}
.dg-mc-mode:disabled:not([data-on]){opacity:.5}
.dg-mc-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
@media (max-width:760px){.dg-mc-cols,.dg-mc-modes{grid-template-columns:1fr}}
.dg-mc-group{display:flex;flex-direction:column;gap:10px;min-width:0}
.dg-mc-group h3{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0;font-size:13px;letter-spacing:1px;color:var(--grass)}
.dg-mc-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.dg-mc-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dg-mc-field span{font-size:11px;color:rgba(222,240,226,.7)}
.dg-mc-field input{min-width:0;padding:7px 9px;border-radius:7px;font:12px var(--dg-mono);color:#eef8ee;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);outline:none;transition:border-color .15s}
.dg-mc-field input:focus{border-color:var(--grass)}
.dg-mc-field input:disabled{opacity:.6}
.dg-mc-field small{font-size:10px;color:rgba(222,240,226,.45)}
.dg-mc-note{margin:0;font-size:11px;line-height:1.6;color:rgba(222,240,226,.55)}
.dg-mc-switch{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:400;letter-spacing:0;color:rgba(222,240,226,.8);cursor:pointer}
.dg-mc-switch input{accent-color:var(--grass)}
.dg-mc-checks{list-style:none;margin:16px 0 0;padding:12px 0 0;border-top:1px solid rgba(123,211,107,.18);display:grid;gap:6px}
.dg-mc-checks li{display:grid;grid-template-columns:16px 64px minmax(0,1fr);align-items:baseline;gap:8px;font-size:12px}
.dg-mc-checks i{font-style:normal;color:var(--grass)}
.dg-mc-checks b{font-weight:600;color:#eaffe2}
.dg-mc-checks span{min-width:0;font:11px/1.5 var(--dg-mono);color:rgba(222,240,226,.7);overflow-wrap:anywhere}
.dg-mc-checks li[data-bad] i,.dg-mc-checks li[data-bad] span{color:#ffb3c0}
.dg-mc-problem{margin-top:12px;padding:9px 12px;border-radius:10px;font-size:12px;color:#ffd1d9;background:rgba(80,10,24,.5);border:1px solid rgba(255,120,140,.45)}
`;
