/**
 * 摄像机窗口上的 HUD：原版旁观者挂在别人身上时不画那个人的血条、饱食度、快捷栏，服务器也不把她的饱食度和物品栏发给摄像机。
 * 这里按原版的布局自己画一层：红心、鸡腿、盔甲、氧气、经验条、快捷栏（物品图标用游戏 jar 里的贴图）。
 *
 * 画的是一个透明、点不到、不抢焦点的小窗口，贴在摄像机窗口下沿、叠在它正上方，跟着它移动和缩放；
 * 摄像机窗口最小化或关掉，这层也跟着藏起来或退出。数据由游戏层写进一个状态文件（她现在的 HUD + 用到的物品图标），窗口自己读。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MinecraftHudState } from './body/contracts.js';
import { GameJar } from './gameJar.js';

/** 一层贴图：贴图 id（textures/ 下的路径，不带 .png），tint 是染色（RGB 整数，或从色图上取一个点） */
interface IconLayer {
  tex: string;
  tint?: number | { map: string; x: number; y: number };
}
/** 物品图标：平面的（一层层叠），或方块（顶面、左面、右面各自的贴图层） */
type HudIcon = { flat: IconLayer[] } | { top: IconLayer[]; left: IconLayer[]; right: IconLayer[] };

const SPRITES = [
  'gui/sprites/hud/hotbar', 'gui/sprites/hud/hotbar_selection', 'gui/sprites/hud/hotbar_offhand_left',
  'gui/sprites/hud/heart/container', 'gui/sprites/hud/heart/full', 'gui/sprites/hud/heart/half',
  'gui/sprites/hud/food_empty', 'gui/sprites/hud/food_half', 'gui/sprites/hud/food_full',
  'gui/sprites/hud/armor_empty', 'gui/sprites/hud/armor_half', 'gui/sprites/hud/armor_full',
  'gui/sprites/hud/air', 'gui/sprites/hud/air_empty',
  'gui/sprites/hud/experience_bar_background', 'gui/sprites/hud/experience_bar_progress',
  'font/ascii',
];

const strip = (id: string) => id.replace(/^minecraft:/, '');

/** 从游戏 jar 里取 HUD 要用的贴图（解到 dir 下），解析物品模型成图标 */
export class HudAssets {
  private readonly icons = new Map<string, HudIcon | null>();

  constructor(private readonly jar: GameJar, readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const id of SPRITES) this.texture(id);
  }

  /** 把贴图解到 dir 下（同样的相对路径），返回贴图 id；jar 里没有就返回 null */
  private texture(id: string): string | null {
    const file = path.join(this.dir, `${id}.png`);
    if (fs.existsSync(file)) return id;
    const data = this.jar.read(`assets/minecraft/textures/${id}.png`);
    if (!data) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return id;
  }

  icon(name: string): HudIcon | null {
    if (!this.icons.has(name)) this.icons.set(name, this.resolve(name));
    return this.icons.get(name) ?? null;
  }

  /** items/<物品>.json 指向一个模型；顺着 parent 往上合并贴图表，找到第一个带方块几何（elements）的模型 */
  private resolve(name: string): HudIcon | null {
    const found = findModel(this.jar.json(`assets/minecraft/items/${name}.json`)?.model);
    if (!found) return null;
    const tints = (found.tints as any[]).map((t) => this.tint(t));
    let textures: Record<string, string> = {};
    let elements: any[] | null = null;
    let generated = false;
    for (let id: string | undefined = strip(found.model), depth = 0; id && depth < 12; depth++) {
      if (id === 'item/generated' || id === 'builtin/generated') generated = true;
      const model = this.jar.json(`assets/minecraft/models/${id}.json`);
      if (!model) break;
      textures = { ...(model.textures ?? {}), ...textures };
      elements ??= model.elements ?? null;
      id = model.parent ? strip(model.parent) : undefined;
    }
    const ref = (key: string): string | null => {
      let v: string | undefined = key;
      for (let i = 0; i < 10 && v?.startsWith('#'); i++) v = textures[v.slice(1)];
      return v ? this.texture(strip(v)) : null;
    };
    const layer = (key: string, tintIndex?: number): IconLayer | null => {
      const tex = ref(key);
      if (!tex) return null;
      const tint = tintIndex === undefined ? undefined : tints[tintIndex];
      return tint === undefined ? { tex } : { tex, tint };
    };
    if (generated) {
      const flat = [0, 1, 2, 3, 4].map((i) => (textures[`layer${i}`] ? layer(`#layer${i}`, i) : null)).filter((l): l is IconLayer => !!l);
      return flat.length ? { flat } : null;
    }
    // 方块：物品栏里看到的是顶面、北面（左）、东面（右）
    const face = (side: string): IconLayer[] => {
      const layers = (elements ?? [])
        .map((e) => e.faces?.[side])
        .filter(Boolean)
        .map((f) => layer(f.texture, f.tintindex))
        .filter((l): l is IconLayer => !!l);
      if (layers.length) return layers;
      const particle = layer('#particle');
      return particle ? [particle] : [];
    };
    const icon = { top: face('up'), left: face('north'), right: face('east') };
    return icon.top.length || icon.left.length ? icon : null;
  }

  /** 物品定义里的染色：固定颜色（树叶、染色皮甲的默认色等）或草的色图 */
  private tint(t: any): IconLayer['tint'] {
    if (t?.type === 'minecraft:grass') {
      const map = this.texture('colormap/grass');
      const temp = Math.min(1, Math.max(0, Number(t.temperature ?? 0.5)));
      const rain = Math.min(1, Math.max(0, Number(t.downfall ?? 1))) * temp;
      if (map) return { map, x: Math.round((1 - temp) * 255), y: Math.round((1 - rain) * 255) };
    }
    const value = t?.value ?? t?.default;
    return typeof value === 'number' ? value & 0xffffff : undefined;
  }
}

/** 物品定义（可能按条件分支）里第一个能用的模型 */
function findModel(node: any): { model: string; tints: unknown[] } | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'minecraft:model' && typeof node.model === 'string') return { model: node.model, tints: node.tints ?? [] };
  if (node.type === 'minecraft:special' && typeof node.base === 'string') return { model: node.base, tints: [] };
  for (const key of ['fallback', 'on_false', 'on_true', 'model', 'cases', 'entries', 'models']) {
    const child = node[key];
    for (const c of Array.isArray(child) ? child : [child]) {
      const hit = findModel(c);
      if (hit) return hit;
    }
  }
  return null;
}

/** HUD 的状态：她现在的 HUD 加上用到的物品图标（桌面上的 HUD 窗口和 HUD 网页读的是同一份） */
export function hudPayload(assets: HudAssets, hud: MinecraftHudState): string {
  const icons: Record<string, HudIcon> = {};
  for (const item of [...hud.hotbar, hud.offhand]) {
    const icon = item && assets.icon(item.name);
    if (icon) icons[item!.name] = icon;
  }
  return JSON.stringify({ hud, icons });
}

/**
 * 上次的游戏窗口留下的鼠标限制：DSH 被整个结束时，游戏和 HUD 窗口一起被杀，谁都来不及解开（见 C# 里的 ReleaseClip）。
 * HUD 窗口记着游戏画面在屏幕上的位置（clip.txt）；鼠标还正好被锁在那块地方，就解开。别的程序的限制不碰
 */
export function releaseStaleClip(dir: string): void {
  const file = path.join(dir, 'clip.txt');
  if (process.platform !== 'win32' || !fs.existsSync(file)) return;
  const [l, t, r, b] = fs.readFileSync(file, 'utf8').trim().split(',').map(Number);
  if (![l, t, r, b].every(Number.isFinite)) return;
  const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class StaleClip {
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
}
"@
[StaleClip]::SetProcessDPIAware() | Out-Null
$c = New-Object StaleClip+RECT
[StaleClip]::GetClipCursor([ref]$c) | Out-Null
if ([Math]::Abs($c.L - ${l}) -le 2 -and [Math]::Abs($c.T - ${t}) -le 2 -and [Math]::Abs($c.R - ${r}) -le 2 -and [Math]::Abs($c.B - ${b}) -le 2) { [StaleClip]::ClipCursor([IntPtr]::Zero) | Out-Null; exit 3 }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' })
    .on('exit', (code) => { if (code === 3) console.info('[dsh-game] released a mouse clip left by the Minecraft camera'); });
}

export class HudOverlay {
  private readonly stateFile: string;
  private pid: number | null = null;
  private last = '';

  constructor(private readonly dir: string, private readonly log?: (text: string) => void) {
    this.stateFile = path.join(dir, 'state.json');
  }

  /** 游戏窗口现在的标题（HUD 窗口看着游戏窗口，标题变了就写下来）；还不知道是空的 */
  get windowTitle(): string {
    try {
      return fs.readFileSync(path.join(this.dir, 'window.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** 开 HUD 窗口，贴着这个进程的游戏窗口 */
  start(gamePid: number): void {
    if (this.pid || process.platform !== 'win32') return;
    const source = path.join(this.dir, 'overlay.cs');
    fs.writeFileSync(source, OVERLAY_CS);
    for (const file of [this.stateFile, path.join(this.dir, 'window.txt')]) {
      try { fs.rmSync(file, { force: true }); } catch { /* 没有就算了 */ }
    }
    this.last = '';
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      // 不然编译时的进度条会以 CLIXML 的形式写进 stderr
      `$ProgressPreference = 'SilentlyContinue'`,
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(source)})) -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions`,
      `[DshHud]::Run(${gamePid}, ${q(this.dir)}, ${q(this.stateFile)})`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.pid = ps.pid ?? null;
    ps.stderr?.on('data', (d) => this.log?.(`[hud] ${String(d).trim()}`));
    ps.on('exit', (code) => {
      this.log?.(`[hud] overlay exited (${code})`);
      this.pid = null;
    });
  }

  /** 写 HUD 的状态（和上次一样就不写） */
  write(text: string): void {
    if (!this.pid || text === this.last) return;
    this.last = text;
    try {
      fs.writeFileSync(this.stateFile, text);
    } catch {
      this.last = '';
    }
  }

  stop(): void {
    if (this.pid) spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true });
    this.pid = null;
  }
}

/**
 * HUD 窗口（C#，PowerShell 现场编译）：每 50 毫秒对一下游戏窗口的位置和层级，状态文件变了就重画。
 * 布局照原版（GUI 坐标，界面缩放和摄像机一样是 2，窗口太小时原版会自动缩小，这里同样算法）。
 */
const OVERLAY_CS = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class DshHud : Form {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int W, H; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLEND { public byte Op, Flags, Alpha, Format; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pos, ref SIZE size, IntPtr src, ref POINT srcPos, int key, ref BLEND blend, int flags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] static extern bool ClipCursor(IntPtr r);

  const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10;
  /** HUD 占屏幕最下面这么高（GUI 单位） */
  const int STRIP = 60;

  readonly Process game;
  readonly string dir, stateFile;
  IntPtr gameWindow = IntPtr.Zero;
  DateTime stateTime = DateTime.MinValue;
  Dictionary<string, object> hud;
  Dictionary<string, object> icons = new Dictionary<string, object>();
  readonly Dictionary<string, Bitmap> images = new Dictionary<string, Bitmap>();
  readonly int[] glyphWidth = new int[256];
  bool dirty;
  int lastW, lastH, scale;
  string lastTitle;
  /** 游戏窗口的画面在屏幕上的位置（物理像素） */
  RECT gameArea;

  public static void Run(int pid, string dir, string stateFile) {
    SetProcessDPIAware();
    Application.Run(new DshHud(Process.GetProcessById(pid), dir, stateFile));
  }

  DshHud(Process game, string dir, string stateFile) {
    this.game = game; this.dir = dir; this.stateFile = stateFile;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    Bounds = new Rectangle(-32000, -32000, 1, 1);
    MeasureFont();
    var timer = new Timer { Interval = 50 };
    timer.Tick += (s, e) => Tick();
    timer.Start();
  }

  /** 鼠标正被锁在游戏窗口的画面里（差一两个像素也算）：解开 */
  void ReleaseClip() {
    if (gameArea.R == 0 && gameArea.B == 0) return;
    RECT c;
    if (!GetClipCursor(out c)) return;
    if (Math.Abs(c.L - gameArea.L) <= 2 && Math.Abs(c.T - gameArea.T) <= 2 && Math.Abs(c.R - gameArea.R) <= 2 && Math.Abs(c.B - gameArea.B) <= 2)
      ClipCursor(IntPtr.Zero);
  }

  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      // 分层（半透明）、鼠标穿透、不抢焦点、不进 Alt+Tab
      cp.ExStyle |= 0x80000 | 0x20 | 0x8000000 | 0x80;
      return cp;
    }
  }

  void Tick() {
    game.Refresh();
    if (game.HasExited) { ReleaseClip(); Close(); return; }
    if (gameWindow == IntPtr.Zero) gameWindow = game.MainWindowHandle;
    if (gameWindow == IntPtr.Zero) return;
    // 鼠标限制：游戏进了世界、拿到焦点时会把鼠标锁在自己窗口里（ClipCursor），失去焦点才放开；
    // 它没放开（被强行结束、焦点被别处拿走）时鼠标就出不了这块地方。不在用游戏窗口时，锁在它里面的限制都解开
    RECT client; GetClientRect(gameWindow, out client);
    var corner = new POINT(); ClientToScreen(gameWindow, ref corner);
    var area = new RECT { L = corner.X, T = corner.Y, R = corner.X + client.R, B = corner.Y + client.B };
    if (area.L != gameArea.L || area.T != gameArea.T || area.R != gameArea.R || area.B != gameArea.B) {
      gameArea = area;
      try { File.WriteAllText(Path.Combine(dir, "clip.txt"), area.L + "," + area.T + "," + area.R + "," + area.B); } catch { }
    }
    if (GetForegroundWindow() != gameWindow) ReleaseClip();
    // 游戏窗口的标题（直播时 OBS 按它找窗口）：变了就写下来
    string title = game.MainWindowTitle;
    if (title != lastTitle) {
      try { File.WriteAllText(Path.Combine(dir, "window.txt"), title); lastTitle = title; } catch { }
    }
    ReadState();
    if (hud == null || !IsWindowVisible(gameWindow) || IsIconic(gameWindow)) { if (Visible) Hide(); return; }
    RECT r; GetClientRect(gameWindow, out r);
    var origin = new POINT(); ClientToScreen(gameWindow, ref origin);
    int cw = r.R - r.L, ch = r.B - r.T;
    if (cw < 64 || ch < 64) { if (Visible) Hide(); return; }
    int s = 2;
    while (s > 1 && (cw / s < 320 || ch / s < 240)) s--;
    int guiH = (ch + s - 1) / s;
    if (!Visible) Show();
    if (dirty || cw != lastW || ch != lastH || s != scale) {
      lastW = cw; lastH = ch; scale = s; dirty = false;
      Render(cw, guiH, s, origin.X, origin.Y + (guiH - STRIP) * s);
    } else if (Left != origin.X || Top != origin.Y + (guiH - STRIP) * s) {
      SetWindowPos(Handle, IntPtr.Zero, origin.X, origin.Y + (guiH - STRIP) * s, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | 4);
    }
    // 层级：紧贴在游戏窗口上面（它前面那个窗口的下面）；别的窗口盖住游戏时也盖住这层
    // 游戏窗口在最前面那一层（置顶）时这层也置顶；放到置顶窗口后面会跟着置顶，放到普通窗口后面会取消置顶
    IntPtr above = GetWindow(gameWindow, 3);
    if (above != Handle) {
      bool gameTopmost = (GetWindowLong(gameWindow, -20) & 8) != 0;
      bool aboveTopmost = above != IntPtr.Zero && (GetWindowLong(above, -20) & 8) != 0;
      IntPtr after = above == IntPtr.Zero ? new IntPtr(gameTopmost ? -1 : -2) : !gameTopmost && aboveTopmost ? new IntPtr(-2) : above;
      SetWindowPos(Handle, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
  }

  void ReadState() {
    try {
      var t = File.GetLastWriteTimeUtc(stateFile);
      if (!File.Exists(stateFile) || t == stateTime) return;
      var root = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(stateFile));
      hud = (Dictionary<string, object>)root["hud"];
      icons = (Dictionary<string, object>)root["icons"];
      stateTime = t;
      dirty = true;
    } catch {
      // 正在写：下一轮再读
    }
  }

  // ---------- 画 ----------

  Bitmap Img(string id) {
    Bitmap b;
    if (images.TryGetValue(id, out b)) return b;
    string file = Path.Combine(dir, id.Replace('/', Path.DirectorySeparatorChar) + ".png");
    b = File.Exists(file) ? new Bitmap(file) : null;
    images[id] = b;
    return b;
  }

  static double Num(object o) { return o == null ? 0 : Convert.ToDouble(o); }

  void Render(int cw, int guiH, int s, int x, int y) {
    int h = STRIP * s;
    using (var bmp = new Bitmap(cw, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.ScaleTransform(s, s);
        g.TranslateTransform(0, -(guiH - STRIP));
        DrawHud(g, (cw + s - 1) / s, guiH);
      }
      Present(bmp, x, y);
    }
  }

  void Present(Bitmap bmp, int x, int y) {
    IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen);
    IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0)), old = SelectObject(mem, hbmp);
    var size = new SIZE { W = bmp.Width, H = bmp.Height };
    var pos = new POINT { X = x, Y = y };
    var src = new POINT();
    var blend = new BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
    UpdateLayeredWindow(Handle, screen, ref pos, ref size, mem, ref src, 0, ref blend, 2);
    SelectObject(mem, old); DeleteObject(hbmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
  }

  void Blit(Graphics g, string sprite, float x, float y) {
    var img = Img("gui/sprites/hud/" + sprite);
    if (img != null) g.DrawImage(img, new RectangleF(x, y, img.Width, img.Height), new RectangleF(0, 0, img.Width, img.Height), GraphicsUnit.Pixel);
  }

  void DrawHud(Graphics g, int W, int H) {
    int cx = W / 2;
    int left = cx - 91, right = cx + 91;

    // 快捷栏
    Blit(g, "hotbar", left, H - 22);
    int sel = (int)Num(hud["selected"]);
    Blit(g, "hotbar_selection", left - 1 + sel * 20, H - 23);
    var hotbar = hud["hotbar"] as object[];
    if (hotbar != null)
      for (int i = 0; i < hotbar.Length && i < 9; i++) DrawItem(g, hotbar[i] as Dictionary<string, object>, cx - 90 + i * 20 + 2, H - 19);
    var off = hud.ContainsKey("offhand") ? hud["offhand"] as Dictionary<string, object> : null;
    if (off != null) {
      Blit(g, "hotbar_offhand_left", left - 29, H - 23);
      DrawItem(g, off, left - 26, H - 19);
    }

    // 经验条和等级
    Blit(g, "experience_bar_background", left, H - 29);
    var progress = Img("gui/sprites/hud/experience_bar_progress");
    int filled = (int)(Num(hud["progress"]) * 183);
    if (progress != null && filled > 0)
      g.DrawImage(progress, new RectangleF(left, H - 29, Math.Min(filled, 182), 5), new RectangleF(0, 0, Math.Min(filled, 182), 5), GraphicsUnit.Pixel);
    int level = (int)Num(hud["level"]);
    if (level > 0) {
      string t = level.ToString();
      int tx = (W - TextWidth(t)) / 2, ty = H - 35;
      foreach (var d in new[] { new Point(1, 0), new Point(-1, 0), new Point(0, 1), new Point(0, -1) }) DrawText(g, t, tx + d.X, ty + d.Y, Color.Black, false);
      DrawText(g, t, tx, ty, Color.FromArgb(0x80, 0xFF, 0x20), false);
    }

    // 红心（左下）和盔甲（红心上面一行）
    int health = (int)Math.Ceiling(Num(hud["health"]));
    for (int i = 0; i < 10; i++) {
      int x = left + i * 8;
      Blit(g, "heart/container", x, H - 39);
      if (i * 2 + 1 < health) Blit(g, "heart/full", x, H - 39);
      else if (i * 2 + 1 == health) Blit(g, "heart/half", x, H - 39);
    }
    int armor = (int)Num(hud["armor"]);
    if (armor > 0)
      for (int i = 0; i < 10; i++) {
        int x = left + i * 8;
        Blit(g, i * 2 + 1 < armor ? "armor_full" : i * 2 + 1 == armor ? "armor_half" : "armor_empty", x, H - 49);
      }

    // 饱食度（右下，从右往左）和氧气（饱食度上面一行，在水里才有）
    int food = (int)Num(hud["food"]);
    for (int i = 0; i < 10; i++) {
      int x = right - i * 8 - 9;
      Blit(g, "food_empty", x, H - 39);
      if (i * 2 + 1 < food) Blit(g, "food_full", x, H - 39);
      else if (i * 2 + 1 == food) Blit(g, "food_half", x, H - 39);
    }
    int air = (int)Num(hud["oxygen"]);
    if (air < 20) {
      int bubbles = (air + 1) / 2;
      for (int i = 0; i < 10; i++) Blit(g, i < bubbles ? "air" : "air_empty", right - i * 8 - 9, H - 49);
    }
  }

  // ---------- 物品 ----------

  void DrawItem(Graphics g, Dictionary<string, object> item, int x, int y) {
    if (item == null) return;
    string name = (string)item["name"];
    object icon;
    if (icons.TryGetValue(name, out icon)) {
      var def = (Dictionary<string, object>)icon;
      if (def.ContainsKey("flat")) {
        foreach (var l in (object[])def["flat"]) Face(g, (Dictionary<string, object>)l, 1f, new PointF(x, y), new PointF(x + 16, y), new PointF(x, y + 16));
      } else {
        // 原版物品栏里方块的样子：斜 45 度、俯视 30 度，缩到 0.625；顶面最亮，左面次之，右面最暗
        foreach (var l in (object[])def["top"]) Face(g, (Dictionary<string, object>)l, 1f, P(x, y, 0.93f, 3.68f), P(x, y, 8f, 0.14f), P(x, y, 8f, 7.22f));
        foreach (var l in (object[])def["left"]) Face(g, (Dictionary<string, object>)l, 0.8f, P(x, y, 0.93f, 3.68f), P(x, y, 8f, 7.22f), P(x, y, 0.93f, 12.34f));
        foreach (var l in (object[])def["right"]) Face(g, (Dictionary<string, object>)l, 0.6f, P(x, y, 8f, 7.22f), P(x, y, 15.07f, 3.68f), P(x, y, 8f, 15.88f));
      }
    } else {
      // 没有图标（模组物品之类）：写个名字的头一个字母
      DrawText(g, name.Substring(0, 1).ToUpper(), x + 5, y + 4, Color.White, true);
    }
    // 耐久条
    if (item.ContainsKey("maxDamage")) {
      double max = Num(item["maxDamage"]), dmg = Num(item["damage"]);
      if (dmg > 0 && max > 0) {
        double f = Math.Max(0, (max - dmg) / max);
        int w = (int)Math.Round(13 - dmg * 13 / max);
        g.FillRectangle(Brushes.Black, x + 2, y + 13, 13, 2);
        g.FillRectangle(new SolidBrush(Hsv(f / 3.0)), x + 2, y + 13, Math.Max(0, w), 1);
      }
    }
    int count = (int)Num(item["count"]);
    if (count > 1) {
      string t = count.ToString();
      DrawText(g, t, x + 19 - 2 - TextWidth(t), y + 9, Color.White, true);
    }
  }

  static PointF P(int x, int y, float dx, float dy) { return new PointF(x + dx, y + dy); }

  static Color Hsv(double hue) {
    double h = hue * 6, c = 1, xx = 1 - Math.Abs(h % 2 - 1);
    double r = 0, g = 0, b = 0;
    if (h < 1) { r = c; g = xx; } else if (h < 2) { r = xx; g = c; } else { g = c; b = xx; }
    return Color.FromArgb((int)(r * 255), (int)(g * 255), (int)(b * 255));
  }

  /** 画一层贴图到平行四边形里（左上、右上、左下三个角），乘上亮度和染色；动画贴图只取第一帧 */
  void Face(Graphics g, Dictionary<string, object> layer, float light, PointF ul, PointF ur, PointF ll) {
    var img = Img((string)layer["tex"]);
    if (img == null) return;
    float r = light, gg = light, b = light;
    object tint;
    if (layer.TryGetValue("tint", out tint) && tint != null) {
      Color c;
      var map = tint as Dictionary<string, object>;
      if (map != null) {
        var cm = Img((string)map["map"]);
        c = cm == null ? Color.White : cm.GetPixel((int)Num(map["x"]), (int)Num(map["y"]));
      } else {
        int v = (int)Num(tint);
        c = Color.FromArgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
      }
      r *= c.R / 255f; gg *= c.G / 255f; b *= c.B / 255f;
    }
    using (var attrs = new ImageAttributes()) {
      attrs.SetColorMatrix(new ColorMatrix(new[] {
        new float[] { r, 0, 0, 0, 0 }, new float[] { 0, gg, 0, 0, 0 }, new float[] { 0, 0, b, 0, 0 },
        new float[] { 0, 0, 0, 1, 0 }, new float[] { 0, 0, 0, 0, 1 } }));
      g.DrawImage(img, new[] { ul, ur, ll }, new RectangleF(0, 0, img.Width, img.Width), GraphicsUnit.Pixel, attrs);
    }
  }

  // ---------- 字（游戏自带的像素字体 ascii.png，8x8 一格） ----------

  void MeasureFont() {
    var font = Img("font/ascii");
    if (font == null) return;
    for (int c = 0; c < 256; c++) {
      int w = 0;
      for (int col = 7; col >= 0 && w == 0; col--)
        for (int row = 0; row < 8; row++)
          if (font.GetPixel((c % 16) * 8 + col, (c / 16) * 8 + row).A > 0) { w = col + 1; break; }
      glyphWidth[c] = c == 32 ? 3 : w;
    }
  }

  int TextWidth(string t) {
    int w = 0;
    foreach (char ch in t) w += (ch < 256 ? glyphWidth[ch] : 5) + 1;
    return Math.Max(0, w - 1);
  }

  void DrawText(Graphics g, string t, int x, int y, Color color, bool shadow) {
    if (shadow) DrawText(g, t, x + 1, y + 1, Color.FromArgb(color.R / 4, color.G / 4, color.B / 4), false);
    var font = Img("font/ascii");
    if (font == null) return;
    using (var attrs = new ImageAttributes()) {
      attrs.SetColorMatrix(new ColorMatrix(new[] {
        new float[] { color.R / 255f, 0, 0, 0, 0 }, new float[] { 0, color.G / 255f, 0, 0, 0 }, new float[] { 0, 0, color.B / 255f, 0, 0 },
        new float[] { 0, 0, 0, 1, 0 }, new float[] { 0, 0, 0, 0, 1 } }));
      foreach (char ch in t) {
        int c = ch < 256 ? ch : '?';
        g.DrawImage(font, new Rectangle(x, y, 8, 8), (c % 16) * 8, (c / 16) * 8, 8, 8, GraphicsUnit.Pixel, attrs);
        x += glyphWidth[c] + 1;
      }
    }
  }
}
`;
