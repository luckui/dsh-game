/**
 * 通用 Ren'Py 连接器：把 mod（zz_dsh_game.rpy）和游戏专属文件装进游戏目录，开本机 TCP 服务等 mod 连过来，
 * 收游戏事件、发指令、截图。不碰 LLM，也不懂具体游戏；游戏专属的东西由各游戏的 profile 提供。
 *
 * 协议：一行一个 JSON。游戏 → 插件是 RenpyEvent，插件 → 游戏是 RenpyCommand。
 * 画面推流走第二个端口（port + 1）：每帧 4 字节长度（大端）+ JPEG。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 47821;
/** 比这小的截图当成没截到：窗口最小化时 Ren'Py 截到的是纯黑图（1280x720 约 5 KB，正常画面 1 MB 上下） */
const BLANK_IMAGE_BYTES = 20_000;
const MOD_FILE = 'zz_dsh_game.rpy';
const CONFIG_FILE = 'dsh_game.json';

// ── 游戏 → 插件 ──────────────────────────────────────────

export type RenpyEvent =
  | {
      type: 'hello'; renpy: string; playthrough: number | null; playername: string; label: string | null; mainMenu: boolean;
      /** 插件的存档（同一周目才有） */
      resume?: { label: string } | null;
    }
  | { type: 'saved'; ok: boolean }
  /** seq：台词编号（mod 留底用，插件交给 agent 后 ack） */
  | { type: 'say'; seq?: number; who: string; what: string }
  /** 重新连上时，mod 补发还没交给 agent 的台词 */
  | { type: 'backlog'; lines: { seq: number; who: string; what: string }[] }
  | { type: 'show'; name: string; tag?: string | null }
  | { type: 'hide'; name: string }
  | { type: 'scene' }
  | { type: 'label'; name: string; playthrough: number | null }
  | { type: 'main_menu'; on: boolean }
  | RenpyPrompt
  | { type: 'shot'; id: number; path: string; ok: boolean }
  | { type: 'error'; where: string; message: string };

/** 等玩家回答的提示：选项 / 写诗选词 / 弹窗 / 读诗 */
export type RenpyPrompt = { type: 'prompt'; id: string; choices: string[] } & (
  | { kind: 'menu'; caption?: string }
  | { kind: 'poem_word'; progress: number; total: number; points?: Record<string, number>[] }
  | { kind: 'dialog'; message: string }
  | { kind: 'poem_read'; author: string; title: string; text: string }
);

// ── 插件 → 游戏 ──────────────────────────────────────────

export type RenpyCommand =
  | { type: 'hold' }
  | { type: 'release' }
  | { type: 'answer'; id: string; index: number }
  | { type: 'name'; value: string }
  | { type: 'start' }
  | { type: 'save' }
  | { type: 'load' }
  | { type: 'afm'; time: number }
  | { type: 'shot'; id: number; path: string }
  | { type: 'skip'; on: boolean }
  /** 狂点：文字瞬间显示、自动前进压到最短（游戏关掉了跳过的长重复段落） */
  | { type: 'rush'; on: boolean }
  | { type: 'censor'; on: boolean }
  | { type: 'stream'; fps: number }
  /** 到这一句为止都交给 agent 了，mod 可以删掉留底 */
  | { type: 'ack'; seq: number }
  | { type: 'dev_jump'; label: string }
  | { type: 'dev_show'; name: string };

/** 装进游戏目录（相对 game/）的一个文件 */
export interface InstallFile {
  /** 相对 game/ 的目标路径，用 / 分隔 */
  target: string;
  /** 源文件绝对路径 */
  source: string;
}

export interface RenpyBridgeOptions {
  /** 游戏根目录（有 exe 和 game/ 的那一层） */
  gameDir: string;
  /** 启动游戏的可执行文件名 */
  exe: string;
  /** mod 源文件所在目录 */
  modDir: string;
  port?: number;
  /** 启动游戏时额外设置的环境变量（比如让游戏读到的「系统用户名」是她，而不是主人的电脑用户名） */
  env?: Record<string, string>;
}

/**
 * 事件：'event' (RenpyEvent)、'connected'、'disconnected'、'frame' (Buffer，一帧 JPEG)。
 * 同一时间只认一个游戏连接，新的连上来就换掉旧的。
 */
export class RenpyBridge extends EventEmitter {
  readonly gameDir: string;
  readonly port: number;
  private readonly exe: string;
  private readonly modDir: string;
  private readonly env: Record<string, string>;
  private server: net.Server | null = null;
  private frameServer: net.Server | null = null;
  private client: net.Socket | null = null;
  private shotSeq = 0;
  private readonly shots = new Map<number, (ok: boolean) => void>();
  private installed: string[] = [];

  constructor(options: RenpyBridgeOptions) {
    super();
    this.gameDir = options.gameDir;
    this.exe = options.exe;
    this.modDir = options.modDir;
    this.port = options.port ?? DEFAULT_PORT;
    this.env = options.env ?? {};
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** 装 mod、写配置、放游戏专属文件（重复装是覆盖）；mod 改过就删掉旧的编译结果 */
  install(config: Record<string, unknown>, files: InstallFile[] = []): void {
    const game = path.join(this.gameDir, 'game');
    const src = path.join(this.modDir, MOD_FILE);
    const dst = path.join(game, MOD_FILE);
    const changed = !fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== fs.readFileSync(src, 'utf8');
    if (changed) {
      fs.copyFileSync(src, dst);
      fs.rmSync(path.join(game, `${MOD_FILE}c`), { force: true });
    }
    fs.writeFileSync(path.join(game, CONFIG_FILE), JSON.stringify({ ...config, port: this.port, frame_port: this.port + 1 }));
    this.installed = [MOD_FILE, `${MOD_FILE}c`, CONFIG_FILE];
    for (const file of files) {
      const target = path.join(game, ...file.target.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.source, target);
      this.installed.push(file.target);
    }
  }

  /** 卸载：删掉装进去的所有文件和因此新建的空目录，游戏回到原样 */
  uninstall(): void {
    const game = path.join(this.gameDir, 'game');
    for (const rel of this.installed) fs.rmSync(path.join(game, ...rel.split('/')), { force: true });
    const dirs = new Set(this.installed.filter((r) => r.includes('/')).map((r) => r.split('/')[0]));
    for (const dir of dirs) removeEmptyDirs(path.join(game, dir));
    this.installed = [];
  }

  async listen(): Promise<void> {
    if (this.server) return;
    this.server = await serve(this.port, (socket) => this.accept(socket));
    this.frameServer = await serve(this.port + 1, (socket) => this.acceptFrames(socket));
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    // 画面连接也要断掉：server.close 要等所有连接都断了才回调，游戏还开着时不断就一直等
    for (const socket of this.frameSockets) socket.destroy();
    this.frameSockets.clear();
    for (const server of [this.server, this.frameServer]) {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.server = null;
    this.frameServer = null;
    for (const done of this.shots.values()) done(false);
    this.shots.clear();
  }

  /** 游戏没开就开一下 */
  launch(): void {
    if (this.connected) return;
    const child = spawn(path.join(this.gameDir, this.exe), [], { cwd: this.gameDir, detached: true, stdio: 'ignore', env: { ...process.env, ...this.env } });
    child.unref();
  }

  send(command: RenpyCommand): boolean {
    if (!this.client) return false;
    this.client.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  /** 让游戏自己截一张当前画面；返回图片字节，没连上、失败或截到空图（窗口最小化）返回 null */
  screenshot(timeoutMs = 5000): Promise<Uint8Array | null> {
    const id = ++this.shotSeq;
    const dir = path.join(os.tmpdir(), 'dsh-game');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${id}.png`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.shots.delete(id);
        if (!ok) return resolve(null);
        try {
          const data = fs.readFileSync(file);
          fs.rmSync(file, { force: true });
          resolve(data.length < BLANK_IMAGE_BYTES ? null : new Uint8Array(data));
        } catch {
          resolve(null);
        }
      };
      this.shots.set(id, finish);
      if (!this.send({ type: 'shot', id, path: file })) finish(false);
    });
  }

  /** 画面推流连接：按「4 字节长度 + JPEG」切帧 */
  /** 游戏连上来的画面连接（关的时候一起断掉） */
  private readonly frameSockets = new Set<net.Socket>();

  private acceptFrames(socket: net.Socket): void {
    this.frameSockets.add(socket);
    socket.on('close', () => this.frameSockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < 4 + size) break;
        this.emit('frame', buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private accept(socket: net.Socket): void {
    this.client?.destroy();
    this.client = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: RenpyEvent;
        try {
          event = JSON.parse(line) as RenpyEvent;
        } catch {
          continue;
        }
        if (event.type === 'shot') this.shots.get(event.id)?.(event.ok);
        this.emit('event', event);
      }
    });
    const drop = () => {
      if (this.client !== socket) return;
      this.client = null;
      this.emit('disconnected');
    };
    socket.on('close', drop);
    socket.on('error', drop);
    this.emit('connected');
  }
}

function serve(port: number, onSocket: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onSocket);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function removeEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** 在 Steam 各个库里找一个游戏目录（按 steamapps/common 下的文件夹名） */
export function findSteamGame(folder: string, exe: string): string | null {
  const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  const libraries = new Set<string>(roots);
  for (const root of roots) {
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'));
    } catch {
      // 没装在这
    }
  }
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', folder);
    if (fs.existsSync(path.join(dir, exe))) return dir;
  }
  return null;
}
