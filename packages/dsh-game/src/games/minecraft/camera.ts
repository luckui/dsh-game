/**
 * 摄像机客户端：开一个真的 Minecraft 客户端（离线账户，旁观模式），自动挂在她身上，画面就是她的视角。
 * 主人看、OBS 抓直播画面都用这个窗口。主人自己想玩，用自己的客户端正常进服，互不干扰。
 *
 *   - 游戏文件（版本、库、资源）用主人装好的 .minecraft（HMCL 或官方启动器装的），不另下载
 *   - 摄像机有自己的游戏目录（DSH 主目录下），设置和主人自己玩的那份分开：失焦不暂停、不放背景音乐、跳过首次进入的引导
 *   - 开局后直接连服务器（--quickPlayMultiplayer）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CameraOptions {
  /** 装好游戏的 .minecraft（里面有 versions/<版本>/） */
  root: string;
  version: string;
  /** 摄像机在服务器里的名字 */
  username: string;
  host: string;
  port: number;
  /** 摄像机自己的游戏目录 */
  gameDir: string;
  /** java（空 = 自动找） */
  java: string;
  log?: (text: string) => void;
}

/** 摄像机客户端的设置：失焦不暂停、不放背景音乐、跳过首次进入的引导 */
const CAMERA_OPTIONS: Record<string, string> = {
  pauseOnLostFocus: 'false',
  onboardAccessibility: 'false',
  tutorialStep: 'none',
  skipMultiplayerWarning: 'true',
  joinedFirstServer: 'true',
  narrator: '0',
  soundCategory_music: '0.0',
  realmsNotifications: 'false',
  lang: 'zh_cn',
  renderDistance: '10',
  guiScale: '2',
};

/** 找 .minecraft：先看主人填的，再看官方启动器的默认位置 */
export function findMinecraftRoot(configured: string, version: string): string | null {
  const candidates = [configured.trim(), path.join(process.env.APPDATA ?? '', '.minecraft')].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'versions', version, `${version}.json`))) return dir;
  }
  return null;
}

/** 找 Java 21：主人填的 → HMCL 带的 → 官方启动器带的 → .minecraft/runtime → 系统 java */
export function findJava(configured: string, root: string): string {
  if (configured.trim()) return configured.trim();
  const home = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const candidates = [
    path.join(appdata, '.hmcl', 'java', 'windows-x86_64', 'mojang-java-runtime-delta', 'bin', 'javaw.exe'),
    path.join(home, '.hmcl', 'java', 'windows-x86_64', 'mojang-java-runtime-delta', 'bin', 'javaw.exe'),
    path.join(root, 'runtime', 'java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', 'javaw.exe'),
    path.join(root, 'runtime', 'java-runtime-delta', 'bin', 'javaw.exe'),
  ];
  // 官方启动器（微软商店版）把运行时放在 Packages 下
  try {
    for (const pkg of fs.readdirSync(path.join(local, 'Packages')).filter((d) => d.startsWith('Microsoft.4297127D64EC6'))) {
      candidates.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Local', 'runtime', 'java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', 'javaw.exe'));
    }
  } catch {
    // 没装官方启动器
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'javaw';
}

function writeOptions(gameDir: string): void {
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const keep = lines.filter((l) => !(l.split(':')[0] in CAMERA_OPTIONS));
  fs.writeFileSync(file, [...keep, ...Object.entries(CAMERA_OPTIONS).map(([k, v]) => `${k}:${v}`)].join('\n') + '\n');
}

export class CameraClient {
  private pid: number | null = null;
  private closed = false;

  constructor(private readonly options: CameraOptions) {}

  get running(): boolean {
    return this.pid !== null;
  }

  async start(): Promise<void> {
    if (this.pid) return;
    const o = this.options;
    writeOptions(o.gameDir);
    // 库是 CommonJS：按需加载（插件不玩 Minecraft 时不用它）
    const mod = (await import('minecraft-launcher-core')) as any;
    const { Client, Authenticator } = mod.default ?? mod;
    const launcher = new Client();
    launcher.on('debug', (e: unknown) => o.log?.(`[camera] ${String(e)}`));
    launcher.on('close', (code: unknown) => {
      o.log?.(`[camera] client closed (${String(code)})`);
      this.pid = null;
    });
    const child = await launcher.launch({
      root: o.root,
      version: { number: o.version, type: 'release' },
      authorization: await Authenticator.getAuth(o.username),
      memory: { max: '2G', min: '1G' },
      javaPath: o.java,
      overrides: { gameDirectory: o.gameDir, detached: false },
      window: { width: 1280, height: 720 },
      quickPlay: { type: 'multiplayer', identifier: `${o.host}:${o.port}` },
    } as never);
    if (!child || this.closed) {
      if (child) this.killPid(child.pid ?? null);
      return;
    }
    this.pid = child.pid ?? null;
    o.log?.(`[camera] started pid ${this.pid}`);
  }

  stop(): void {
    this.closed = true;
    this.killPid(this.pid);
    this.pid = null;
  }

  private killPid(pid: number | null): void {
    if (!pid) return;
    // 按 PID 结束（连同子进程），不会误伤别的 java
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(pid); } catch { /* 已经退了 */ }
  }
}
