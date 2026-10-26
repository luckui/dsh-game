/**
 * 摄像机客户端：开一个真的 Minecraft 客户端（离线账户，旁观模式），自动挂在她身上，画面就是她的视角。
 * 主人看、OBS 抓直播画面都用这个窗口。主人自己想玩，用自己的客户端正常进服，互不干扰。
 *
 *   - 游戏文件（版本、库、资源）用主人装好的 .minecraft（HMCL 或官方启动器装的），不另下载
 *   - 摄像机有自己的游戏目录（DSH 主目录下），设置和主人自己玩的那份分开：失焦不暂停、不放背景音乐、跳过首次进入的引导
 *   - 开局后直接连服务器（--quickPlayMultiplayer）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MinecraftHudState } from './body/contracts.js';
import { GameJar } from './gameJar.js';
import { HudAssets, HudOverlay, hudPayload, releaseStaleClip } from './hudOverlay.js';
import { HudPage } from './hudPage.js';

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
  /** HUD 网页的端口（0 = 不开） */
  hudPort: number;
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
  // 1.21.2 起「非活动帧率限制」默认 afk：一分钟没有键鼠输入限到 30 帧，再过 9 分钟限到 10 帧。
  // 摄像机客户端从来没人操作，直播大部分时间都是 10 帧（直播科在服务器上实测：afk 11 分钟后约 10 帧，minimized 一直约 33 帧）
  inactivityFpsLimit: 'minimized',
  maxFps: '60',
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

/**
 * 写摄像机的设置。options.txt 要带上这个游戏版本的数据版本号（version:）：没有的话游戏当它是很老版本的设置文件，
 * 先拿去转换，我们写的设置（比如失焦不暂停）可能就不作数了。数据版本号从游戏 jar 里的 version.json 读
 */
function writeOptions(gameDir: string, root: string, version: string): void {
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const dataVersion = readDataVersion(path.join(root, 'versions', version, `${version}.jar`));
  const ours: Record<string, string> = { ...(dataVersion ? { version: String(dataVersion) } : {}), ...CAMERA_OPTIONS };
  const keep = lines.filter((l) => !(l.split(':')[0] in ours));
  fs.writeFileSync(file, [...Object.entries(ours).map(([k, v]) => `${k}:${v}`), ...keep].join('\n') + '\n');
}

/** 游戏 jar 里 version.json 的 world_version */
function readDataVersion(jar: string): number | null {
  try {
    return Number(new GameJar(jar).json('version.json')?.world_version) || null;
  } catch {
    // 读不到就不写版本号
    return null;
  }
}

export class CameraClient {
  private pid: number | null = null;
  private closed = false;
  private hudAssets: HudAssets | null = null;
  private hud: HudOverlay | null = null;
  private hudPage: HudPage | null = null;

  constructor(private readonly options: CameraOptions) {}

  get running(): boolean {
    return this.pid !== null;
  }

  async start(): Promise<void> {
    if (this.pid) return;
    const o = this.options;
    writeOptions(o.gameDir, o.root, o.version);
    releaseStaleClip(path.join(o.gameDir, 'hud'));
    // 库是 CommonJS：按需加载（插件不玩 Minecraft 时不用它）
    const mod = (await import('minecraft-launcher-core')) as any;
    const { Client, Authenticator } = mod.default ?? mod;
    const launcher = new Client();
    launcher.on('debug', (e: unknown) => o.log?.(`[camera] ${String(e)}`));
    launcher.on('close', (code: unknown) => {
      o.log?.(`[camera] client closed (${String(code)})`);
      this.pid = null;
      this.stopHudSoon();
    });
    const child = await launcher.launch({
      root: o.root,
      version: { number: o.version, type: 'release' },
      authorization: await Authenticator.getAuth(o.username),
      memory: { max: '2G', min: '1G' },
      javaPath: o.java,
      // 工作目录也放摄像机自己的目录：游戏的日志写在工作目录下，别写进主人的 .minecraft
      overrides: { gameDirectory: o.gameDir, cwd: o.gameDir, detached: false },
      window: { width: 1280, height: 720 },
      quickPlay: { type: 'multiplayer', identifier: `${o.host}:${o.port}` },
    } as never);
    if (!child || this.closed) {
      if (child) this.killPid(child.pid ?? null);
      return;
    }
    this.pid = child.pid ?? null;
    o.log?.(`[camera] started pid ${this.pid}`);
    if (this.pid && process.platform === 'win32') {
      this.keepOutOfTheWay(this.pid);
      const dir = path.join(o.gameDir, 'hud');
      try {
        this.hudAssets = new HudAssets(new GameJar(path.join(o.root, 'versions', o.version, `${o.version}.jar`)), dir);
        this.hud = new HudOverlay(dir, o.log);
        this.hud.start(this.pid);
        if (o.hudPort) {
          this.hudPage = new HudPage(o.hudPort, dir, o.log);
          this.hudPage.start();
        }
      } catch (err) {
        o.log?.(`[camera] no HUD: ${(err as Error).message}`);
      }
    }
  }

  /** HUD 画她现在的状态（摄像机窗口上的、HUD 网页上的） */
  showHud(state: MinecraftHudState): void {
    if (!this.hudAssets) return;
    const text = hudPayload(this.hudAssets, state);
    this.hud?.write(text);
    this.hudPage?.push(text);
  }

  /** HUD 网页的地址（没开是 null） */
  get hudUrl(): string | null {
    return this.hudPage?.url ?? null;
  }

  /** OBS 窗口捕获认窗口用的「标题:窗口类:程序」（标题里的冒号 OBS 写成 #3A）；还不知道标题时是 null */
  get obsWindow(): string | null {
    const title = this.hud?.windowTitle;
    if (!title) return null;
    return `${title.replace(/:/g, '#3A')}:GLFW30:${path.basename(this.options.java || 'javaw.exe')}`;
  }

  /**
   * 摄像机窗口只是给人看的：设成「不可激活」（WS_EX_NOACTIVATE），点它不会抢焦点、不会把鼠标锁进游戏；
   * 它刚打开时抢走的焦点还给原来的窗口。拖动窗口、OBS 抓画面都不受影响。
   */
  private keepOutOfTheWay(pid: number): void {
    const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CamWin {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$prev = [CamWin]::GetForegroundWindow()
$deadline = (Get-Date).AddSeconds(120)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if (-not $p) { exit 1 }
  if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -like 'Minecraft*') { $h = $p.MainWindowHandle; break }
  Start-Sleep -Milliseconds 200
}
if ($h -eq [IntPtr]::Zero) { exit 1 }
$ex = [CamWin]::GetWindowLong($h, -20)
[CamWin]::SetWindowLong($h, -20, ($ex -bor 0x08000000)) | Out-Null
for ($i = 0; $i -lt 40; $i++) {
  if ([CamWin]::GetForegroundWindow() -eq $h -and $prev -ne [IntPtr]::Zero -and $prev -ne $h) {
    [CamWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [CamWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [CamWin]::SetForegroundWindow($prev) | Out-Null
  }
  Start-Sleep -Milliseconds 500
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    ps.on('exit', (code) => this.options.log?.(`[camera] window set to no-activate (${code === 0 ? 'ok' : `exit ${code}`})`));
  }

  /** 往摄像机窗口发按键（PostMessage，窗口不用激活）：vk 是虚拟键码，scan 是扫描码（GLFW 靠它认键），按 times 次 */
  pressKey(vk: number, scan: number, times = 1): Promise<boolean> {
    const pid = this.pid;
    if (!pid || process.platform !== 'win32' || times <= 0) return Promise.resolve(false);
    const down = 1 + scan * 65536;
    const up = down + 0xC0000000;
    const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CamKey { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }
"@
$h = (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle
if (-not $h) { exit 1 }
for ($i = 0; $i -lt ${times}; $i++) {
  [CamKey]::PostMessage($h, 0x100, [IntPtr]${vk}, [IntPtr]${down}) | Out-Null
  Start-Sleep -Milliseconds 60
  [CamKey]::PostMessage($h, 0x101, [IntPtr]${vk}, [IntPtr]([int64]${up})) | Out-Null
  Start-Sleep -Milliseconds 150
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', (code) => resolve(code === 0));
      ps.on('error', () => resolve(false));
    });
  }

  stop(): void {
    this.closed = true;
    // 先关游戏，HUD 窗口看到它退出会解开它留下的鼠标限制，再关 HUD
    this.killPid(this.pid);
    this.pid = null;
    this.stopHudSoon();
  }

  private stopHudSoon(): void {
    setTimeout(() => this.stopHud(), 1000);
  }

  private stopHud(): void {
    this.hud?.stop();
    this.hud = null;
    this.hudPage?.stop();
    this.hudPage = null;
    this.hudAssets = null;
  }

  private killPid(pid: number | null): void {
    if (!pid) return;
    // 按 PID 结束（连同子进程），不会误伤别的 java
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(pid); } catch { /* 已经退了 */ }
  }
}
