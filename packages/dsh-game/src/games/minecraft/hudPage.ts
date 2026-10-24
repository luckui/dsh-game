/**
 * HUD 网页：和摄像机窗口上的 HUD 一样的东西（原版布局的红心、鸡腿、盔甲、氧气、经验条、快捷栏），画在透明网页上。
 * 直播时 OBS 用浏览器源打开它，叠在游戏窗口捕获上面（浏览器源由 OBS 自己渲染，服务器上远程桌面断开也照样有）。
 *
 *   http://127.0.0.1:<port>/          HUD 页（透明背景；铺满和游戏画面一样大的区域）
 *   http://127.0.0.1:<port>/events    状态推送（SSE，变了才推）
 *   http://127.0.0.1:<port>/tex/...   从游戏 jar 里取出来的贴图
 *
 * 自己开一个端口，不走 DSH 的地址：DSH 的地址要登录令牌，令牌每次重启都变，OBS 里的地址就失效了。
 * 页面按摄像机客户端的样子算大小：窗口 720 高、界面缩放 2，所以整个画面高 360 个界面单位。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export class HudPage {
  private server: http.Server | null = null;
  private listening = false;
  private readonly clients = new Set<http.ServerResponse>();
  private last = '';

  constructor(private readonly port: number, private readonly dir: string, private readonly log?: (text: string) => void) {}

  /** 页面地址（端口开好之后才有） */
  get url(): string | null {
    return this.listening ? `http://127.0.0.1:${this.port}/` : null;
  }

  start(): void {
    if (this.server || !this.port) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err) => this.log?.(`[hud-page] 端口 ${this.port} 开不了：${err.message}`));
    server.listen(this.port, '127.0.0.1', () => {
      this.listening = true;
      this.log?.(`[hud-page] ${this.url}`);
    });
    this.server = server;
  }

  /** 推一份新的 HUD 状态（和上次一样就不推） */
  push(text: string): void {
    if (text === this.last) return;
    this.last = text;
    for (const res of this.clients) res.write(`data: ${text}\n\n`);
  }

  stop(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.listening = false;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (this.last) res.write(`data: ${this.last}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      res.on('close', () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
      return;
    }
    const tex = url.pathname.match(/^\/tex\/([a-z0-9_/]+)\.png$/);
    if (tex) {
      fs.readFile(path.join(this.dir, `${tex[1]}.png`), (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404).end();
  }
}

/** HUD 页：布局和摄像机窗口上的 HUD（hudOverlay.ts 里的 C#）一样，照原版 */
const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>大肥鱼 HUD</title>
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{position:fixed;left:0;top:0;width:100%;height:100%}</style>
</head><body><canvas id="hud"></canvas>
<script>
(function () {
  var canvas = document.getElementById('hud');
  var g = canvas.getContext('2d');
  var state = null;
  var images = {};
  var colored = {};
  var glyphs = null;

  function img(id) {
    var e = images[id];
    if (!e) {
      e = images[id] = new Image();
      e.onload = draw;
      e.src = 'tex/' + id + '.png';
    }
    return e.complete && e.naturalWidth ? e : null;
  }

  // 贴图乘上一个颜色（染色、明暗）：动画贴图只取第一帧（正方形）
  function tinted(id, r, gg, b) {
    var im = img(id);
    if (!im) return null;
    var key = id + '|' + r.toFixed(3) + ',' + gg.toFixed(3) + ',' + b.toFixed(3);
    if (colored[key]) return colored[key];
    var c = document.createElement('canvas');
    c.width = im.width;
    c.height = Math.min(im.height, im.width);
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    if (r !== 1 || gg !== 1 || b !== 1) {
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = 'rgb(' + Math.round(r * 255) + ',' + Math.round(gg * 255) + ',' + Math.round(b * 255) + ')';
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(im, 0, 0);
    }
    return (colored[key] = c);
  }

  function pixel(id, px, py) {
    var im = img(id);
    if (!im) return [255, 255, 255];
    var c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    var d = x.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  function blit(sprite, x, y) {
    var im = img('gui/sprites/hud/' + sprite);
    if (im) g.drawImage(im, x, y);
  }

  // 一层贴图画进平行四边形（左上、右上、左下三个角），乘上亮度和染色
  function face(layer, light, ul, ur, ll) {
    var r = light, gg = light, b = light;
    var t = layer.tint;
    if (t !== undefined && t !== null) {
      var rgb = typeof t === 'number' ? [(t >> 16) & 255, (t >> 8) & 255, t & 255] : pixel(t.map, t.x, t.y);
      r *= rgb[0] / 255; gg *= rgb[1] / 255; b *= rgb[2] / 255;
    }
    var c = tinted(layer.tex, r, gg, b);
    if (!c) return;
    var w = c.width;
    g.save();
    g.transform((ur[0] - ul[0]) / w, (ur[1] - ul[1]) / w, (ll[0] - ul[0]) / w, (ll[1] - ul[1]) / w, ul[0], ul[1]);
    g.drawImage(c, 0, 0);
    g.restore();
  }

  // 游戏自带的像素字体（ascii.png，8x8 一格）：每个字的宽度看它最右边有颜色的那一列
  function measure() {
    var im = img('font/ascii');
    if (!im) return null;
    var c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    var data = x.getImageData(0, 0, im.width, im.height).data;
    var widths = [];
    for (var ch = 0; ch < 256; ch++) {
      var w = 0;
      for (var col = 7; col >= 0 && !w; col--)
        for (var row = 0; row < 8; row++)
          if (data[(((ch >> 4) * 8 + row) * im.width + (ch & 15) * 8 + col) * 4 + 3] > 0) { w = col + 1; break; }
      widths[ch] = ch === 32 ? 3 : w;
    }
    return widths;
  }

  function textWidth(t) {
    var w = 0;
    for (var i = 0; i < t.length; i++) w += (glyphs[t.charCodeAt(i)] || 5) + 1;
    return Math.max(0, w - 1);
  }

  function text(t, x, y, rgb, shadow) {
    if (shadow) text(t, x + 1, y + 1, [rgb[0] / 4, rgb[1] / 4, rgb[2] / 4], false);
    var font = tinted('font/ascii', rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    if (!font || !glyphs) return;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charCodeAt(i);
      if (ch > 255) ch = 63;
      g.drawImage(font, (ch & 15) * 8, (ch >> 4) * 8, 8, 8, x, y, 8, 8);
      x += glyphs[ch] + 1;
    }
  }

  function P(x, y, dx, dy) { return [x + dx, y + dy]; }

  function item(it, icons, x, y) {
    if (!it) return;
    var def = icons[it.name];
    if (def && def.flat) {
      def.flat.forEach(function (l) { face(l, 1, [x, y], [x + 16, y], [x, y + 16]); });
    } else if (def) {
      // 原版物品栏里方块的样子：斜 45 度、俯视 30 度，缩到 0.625；顶面最亮，左面次之，右面最暗
      def.top.forEach(function (l) { face(l, 1, P(x, y, 0.93, 3.68), P(x, y, 8, 0.14), P(x, y, 8, 7.22)); });
      def.left.forEach(function (l) { face(l, 0.8, P(x, y, 0.93, 3.68), P(x, y, 8, 7.22), P(x, y, 0.93, 12.34)); });
      def.right.forEach(function (l) { face(l, 0.6, P(x, y, 8, 7.22), P(x, y, 15.07, 3.68), P(x, y, 8, 15.88)); });
    } else {
      text(it.name.charAt(0).toUpperCase(), x + 5, y + 4, [255, 255, 255], true);
    }
    if (it.maxDamage && it.damage > 0) {
      var f = Math.max(0, (it.maxDamage - it.damage) / it.maxDamage);
      g.fillStyle = '#000';
      g.fillRect(x + 2, y + 13, 13, 2);
      g.fillStyle = 'hsl(' + Math.round(f * 120) + ',100%,50%)';
      g.fillRect(x + 2, y + 13, Math.max(0, Math.round(13 - it.damage * 13 / it.maxDamage)), 1);
    }
    if (it.count > 1) {
      var t = String(it.count);
      text(t, x + 19 - 2 - textWidth(t), y + 9, [255, 255, 255], true);
    }
  }

  function hud(h, icons, W, H) {
    var cx = Math.floor(W / 2), left = cx - 91, right = cx + 91, i, x;
    // 快捷栏
    blit('hotbar', left, H - 22);
    blit('hotbar_selection', left - 1 + h.selected * 20, H - 23);
    for (i = 0; i < 9; i++) item(h.hotbar[i], icons, cx - 90 + i * 20 + 2, H - 19);
    if (h.offhand) {
      blit('hotbar_offhand_left', left - 29, H - 23);
      item(h.offhand, icons, left - 26, H - 19);
    }
    // 经验条和等级
    blit('experience_bar_background', left, H - 29);
    var bar = img('gui/sprites/hud/experience_bar_progress');
    var filled = Math.min(182, Math.floor(h.progress * 183));
    if (bar && filled > 0) g.drawImage(bar, 0, 0, filled, 5, left, H - 29, filled, 5);
    if (h.level > 0) {
      var lv = String(h.level), tx = Math.floor((W - textWidth(lv)) / 2), ty = H - 35;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { text(lv, tx + d[0], ty + d[1], [0, 0, 0], false); });
      text(lv, tx, ty, [0x80, 0xff, 0x20], false);
    }
    // 红心（左下）和盔甲（红心上面一行）
    var health = Math.ceil(h.health);
    for (i = 0; i < 10; i++) {
      x = left + i * 8;
      blit('heart/container', x, H - 39);
      if (i * 2 + 1 < health) blit('heart/full', x, H - 39);
      else if (i * 2 + 1 === health) blit('heart/half', x, H - 39);
    }
    if (h.armor > 0)
      for (i = 0; i < 10; i++) blit(i * 2 + 1 < h.armor ? 'armor_full' : i * 2 + 1 === h.armor ? 'armor_half' : 'armor_empty', left + i * 8, H - 49);
    // 饱食度（右下，从右往左）和氧气（饱食度上面一行，在水里才有）
    for (i = 0; i < 10; i++) {
      x = right - i * 8 - 9;
      blit('food_empty', x, H - 39);
      if (i * 2 + 1 < h.food) blit('food_full', x, H - 39);
      else if (i * 2 + 1 === h.food) blit('food_half', x, H - 39);
    }
    if (h.oxygen < 20) {
      var bubbles = Math.floor((h.oxygen + 1) / 2);
      for (i = 0; i < 10; i++) blit(i < bubbles ? 'air' : 'air_empty', right - i * 8 - 9, H - 49);
    }
  }

  function draw() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!state) return;
    if (!glyphs) glyphs = measure();
    // 摄像机窗口 720 高、界面缩放 2：整个画面高 360 个界面单位
    var unit = canvas.height / 360;
    g.imageSmoothingEnabled = false;
    g.setTransform(unit, 0, 0, unit, 0, 0);
    hud(state.hud, state.icons, Math.floor(canvas.width / unit), 360);
  }

  addEventListener('resize', draw);
  var events = new EventSource('events');
  events.onmessage = function (e) { state = JSON.parse(e.data); draw(); };
})();
</script></body></html>`;
