/**
 * 她的游戏画面（网页）：用 prismarine-viewer 的渲染（three.js，在浏览器里画方块和生物），镜头由这里驱动。
 *
 *   http://127.0.0.1:<port>/first/   她的视角：镜头就是她的眼睛，跟着她转头、低头看方块
 *   http://127.0.0.1:<port>/third/   第三人称跟拍：镜头跟在她身后，能看到她自己（撞墙时拉近）
 *
 * prismarine-viewer 自带的服务端只在她走动时发位置、第三人称镜头只摆一次，看不出她在做什么；
 * 这里每 50 毫秒按她现在的位置和视线发一次镜头（转向做平滑），画面角落有一块信息条（在做什么、血量、目标）。
 * 渲染器的贴图做到 1.21.4，所以服务器用 1.21.4。
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';

export interface ViewOptions {
  port: number;
  viewDistance: number;
}

/** 信息条：一行一件（游戏层通过 worker 的 hud 命令更新） */
let hudLines: string[] = [];
const hudClients = new Set<{ write: (chunk: string) => void }>();

export function setHud(lines: string[]): void {
  hudLines = lines;
  const data = `data: ${JSON.stringify(lines)}\n\n`;
  for (const res of hudClients) res.write(data);
}

let stubbed = false;
/** prismarine-viewer 在服务端也 require 了原生的 canvas（只给浏览器里的名牌用）：给一个空的替身 */
function stubCanvas(): void {
  if (stubbed) return;
  stubbed = true;
  const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = mod._load;
  mod._load = function (request: string, ...rest: unknown[]) {
    if (request === 'canvas') {
      class Stub {}
      return { Canvas: Stub, Image: Stub, createCanvas: () => ({ getContext: () => ({}) }) };
    }
    return load.call(this, request, ...rest);
  };
}

const PAGE = (mode: 'first' | 'third') => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>大肥鱼的 Minecraft · ${mode === 'first' ? '她的视角' : '第三人称'}</title>
<style>
html{overflow:hidden}html,body{height:100%;margin:0;padding:0;background:#000}
canvas{height:100%;width:100%;font-size:0;margin:0;padding:0;display:block}
#hud{position:fixed;left:12px;top:12px;max-width:min(60vw,520px);font:600 14px/1.5 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#fff;
  background:rgba(8,12,24,.55);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 12px;pointer-events:none;
  text-shadow:0 1px 2px rgba(0,0,0,.6);backdrop-filter:blur(4px)}
#hud:empty{display:none}#hud div:first-child{font-size:15px}
#cross{position:fixed;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;pointer-events:none;${mode === 'first' ? '' : 'display:none;'}
  background:linear-gradient(#fff,#fff) center/2px 14px no-repeat,linear-gradient(#fff,#fff) center/14px 2px no-repeat;opacity:.7;mix-blend-mode:difference}
</style></head><body>
<div id="hud"></div><div id="cross"></div>
<script>
(function(){var hud=document.getElementById('hud');var es=new EventSource('hud');
es.onmessage=function(e){var lines=JSON.parse(e.data);hud.innerHTML='';lines.forEach(function(t){var d=document.createElement('div');d.textContent=t;hud.appendChild(d);});};})();
</script>
<script src="index.js"></script>
</body></html>`;

/** 第三人称镜头不被这些方块挡（看得穿） */
const SEE_THROUGH = /leaves|glass|ice$|_pane|fence|bars|torch|flower|grass$|fern|vine|snow$/;

/** 角度差收到 (-π, π] */
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

let server: { close: () => void } | null = null;

/** 给这个机器人开画面（换了机器人就关掉旧的再开） */
export function openView(bot: any, options: ViewOptions): void {
  stubCanvas();
  closeView();
  const req = createRequire(require.resolve('prismarine-viewer/package.json'));
  const express = req('express');
  const { Server } = req('socket.io');
  const { WorldView } = req('./viewer/lib/worldView');
  const publicDir = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');

  const app = express();
  const http = req('http').createServer(app);
  const sockets = new Set<any>();

  app.get('/', (_req: any, res: any) => res.redirect('/first/'));
  for (const mode of ['first', 'third'] as const) {
    app.get(`/${mode}/`, (_req: any, res: any) => res.type('html').send(PAGE(mode)));
    app.get(`/${mode}/hud`, (_req: any, res: any) => {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify(hudLines)}\n\n`);
      hudClients.add(res);
      res.on('close', () => hudClients.delete(res));
    });
    app.use(`/${mode}`, express.static(publicDir, { index: false }));

    const io = new Server(http, { path: `/${mode}/socket.io` });
    io.on('connection', (socket: any) => {
      sockets.add(socket);
      socket.emit('version', bot.version);
      const start = bot.entity.position;
      const worldView = new WorldView(bot.world, options.viewDistance, start, socket);
      worldView.init(start);
      worldView.listenToBot(bot);
      // 第三人称：先发一个不带视线的位置，网页才会建她的模型；之后镜头另发
      if (mode === 'third') socket.emit('position', { pos: start, yaw: bot.entity.yaw, addMesh: true });
      let camYaw = bot.entity.yaw;
      let camPitch = bot.entity.pitch;
      let lastChunkUpdate = 0;
      const tick = setInterval(() => {
        const e = bot.entity;
        if (!e?.position) return;
        // 转向平滑：每 50 毫秒追上一半，转身不会一抽一抽的
        camYaw += wrap(e.yaw - camYaw) * 0.5;
        camPitch += (e.pitch - camPitch) * 0.5;
        if (mode === 'first') {
          socket.emit('position', { pos: e.position, yaw: camYaw, pitch: camPitch });
        } else {
          socket.emit('position', { pos: e.position, yaw: e.yaw, addMesh: true });
          // 镜头在她身后 4.5 格、高 1.2 格，略微俯视；中间有实心方块挡着就拉近（树叶、玻璃这类透光的不算）
          const back = { x: Math.sin(camYaw), z: Math.cos(camYaw) };
          const head = e.position.offset(0, 1.6, 0);
          let dist = 4.5;
          for (let d = 0.5; d <= 4.5; d += 0.25) {
            const p = head.offset(back.x * d, 1.2 * (d / 4.5), back.z * d);
            const block = bot.blockAt(p.floored());
            if (block && block.boundingBox === 'block' && !SEE_THROUGH.test(block.name)) { dist = d - 0.4; break; }
          }
          if (dist < 1.6) {
            // 贴墙了：镜头会贴着后脑勺，先换回她的视角
            socket.emit('position', { pos: e.position, yaw: camYaw, pitch: camPitch });
          } else {
            const cam = { x: head.x + back.x * dist, y: head.y + 1.2 * (dist / 4.5) - 1.6, z: head.z + back.z * dist };
            socket.emit('position', { pos: cam, yaw: camYaw, pitch: -0.25 });
          }
        }
        if (Date.now() - lastChunkUpdate > 500) {
          lastChunkUpdate = Date.now();
          worldView.updatePosition(e.position);
        }
      }, 50);
      socket.on('disconnect', () => {
        clearInterval(tick);
        worldView.removeListenersFromBot(bot);
        sockets.delete(socket);
      });
    });
  }

  http.listen(options.port, '127.0.0.1');
  server = {
    close: () => {
      for (const s of sockets) s.disconnect(true);
      http.close();
    },
  };
}

export function closeView(): void {
  server?.close();
  server = null;
}
