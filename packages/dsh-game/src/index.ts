/**
 * dsh-game 根插件（宿主端）：插件配置，以及舞台用的路由。
 *   GET  /api/dsh-game/events        舞台订阅的事件流（SSE）：她说的话（带语音）、表情、游戏时刻；?frames=1 时带游戏画面
 *   GET  /api/dsh-game/library       游戏库：每个游戏装没装、有没有插件存档
 *   GET  /api/dsh-game/art?game=&kind=  游戏封面 / 横幅 / Logo（Steam 图床，本地缓存）
 *   GET  /api/dsh-game/clips?name=   大肥鱼状态片段（透明 WebM）
 *   POST /api/dsh-game/said?id=      舞台回执：这句念完了
 * 给 agent 用的工具在 agent 子插件（./agent.ts）里，插在 agent 预设下面才对模型可见。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { GAMES, mcSetup, minecraftCameraDir, minecraftJournalDir, assetsDir, audio, bindSettings, clipsDir, STEAM_ART, games, hooks, listeners, settings, speeches, watchFrames, wolfSetup, type ArtKind, type GameId, type LiveBody, type Settings, type StageEvent } from './runtime.js';
import type { WolfSetup } from './games/werewolf/setup.js';
import type { McSetup } from './games/minecraft/setup.js';
import { WorldJournal } from './games/minecraft/journal.js';
import { DEFAULT_VOICE } from './tts.js';
import { deleteCharacter, findDdlcDir } from './games/ddlc/profile.js';
import { WerewolfSession, devOptions } from './games/werewolf/session.js';
import { releaseStaleClip } from './games/minecraft/hudOverlay.js';

export const name = 'dsh-game';

const ASSET_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** 插件包 assets/ 下的一个文件（路径已检查过） */
async function serveAsset(rel: string): Promise<Response> {
  try {
    const data = await readFile(join(dirname(assetsDir()), 'assets', ...rel.split('/')));
    return new Response(data, { headers: { 'content-type': ASSET_TYPES[rel.split('.').pop() ?? ''] ?? 'application/octet-stream', 'cache-control': 'max-age=86400' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

/** 游戏美术的本地缓存 */
const ART_DIR = join(process.env.DSH_HOME ?? tmpdir(), 'dsh-game', 'art');
export const inject = ['connection'];

// volatile：侧栏「插件」→ dsh-game 的设置页能改，改了不用重启（每次用时现读）。豆包密钥不在这里，走 DSH 凭据
export const Config = z.object({
  voice: z.string().default(DEFAULT_VOICE).description('大肥鱼的豆包音色 ID：1.0、2.0（…_uranus_bigtts）或复刻音色（S_ 开头）').volatile(),
  censor: z.boolean().default(true).description('给游戏里的死亡、自残、血腥画面打码（直播和视频建议开启）').volatile(),
  director: z.boolean().default(true).description('导演模式：日常段落快进（交给 agent 一段摘要），关键段落一场一场地看').volatile(),
  summaryModel: z.string().default('deepseek-official/deepseek-flash').description('快进摘要用的模型（provider/model）').volatile(),
  ddlcDir: z.string().description('《心跳文学部》的游戏目录（有 DDLC.exe 的那一层）；不填就在 Steam 库里找').volatile(),
  // 旧版的狼人杀座位设置：现在在游戏库「狼人杀」的开局设置里，这两项只在第一次打开开局设置时搬过去
  wolfModel: z.string().default('deepseek-official/deepseek-flash').description('（旧）狼人杀默认模型，已移到游戏库的开局设置').volatile(),
  wolfSeats: z.string().description('（旧）狼人杀座位配置，已移到游戏库的开局设置').volatile(),
  mcHost: z.string().default('127.0.0.1').description('（旧）Minecraft 服务器地址（Java 版）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcPort: z.natural().default(25565).description('（旧）Minecraft 服务器端口。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcUsername: z.string().default('DaFeiYu').description('（旧）大肥鱼在 Minecraft 里的名字（英文、数字、下划线，3~16 个字）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcRconPort: z.natural().default(25575).description('（旧）自己服务器的 RCON 端口。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcCamera: z.boolean().default(true).description('（旧）开摄像机客户端：一个真的 Minecraft 客户端（离线账户、旁观模式）自动挂在她身上，画面就是她的视角；直播时 OBS 抓这个窗口（需要填 RCON 密码）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcClientDir: z.string().description('（旧）装好游戏的 .minecraft 目录（HMCL 或官方启动器装的；不填就用官方启动器的默认位置）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcJava: z.string().description('（旧）Java 21 的路径（不填就自动找 HMCL / 官方启动器带的）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcCameraName: z.string().default('DaFeiYuCam').description('（旧）摄像机在服务器里的名字。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcHudPort: z.natural().default(7391).description('（旧）摄像机 HUD 网页的端口（血量、饱食度、快捷栏；直播时作为 OBS 浏览器源叠在游戏窗口上，0 = 不开）。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
  mcRconPassword: z.string().role('secret').description('（旧）自己服务器的 RCON 密码（server.properties 里的 rcon.password）；填了的话，旁观模式的玩家会自动挂到她身上。已移到游戏库 Minecraft 的开局设置，这里只在第一次打开开局设置时搬过去').volatile(),
});

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

type Cell<T> = { get(): T };
type LiveConfig = { [K in keyof Settings]?: Cell<Settings[K] | undefined> };

export function apply(ctx: HostContext, config: LiveConfig = {}): void {
  bindSettings(() => ({
    voice: config.voice?.get(),
    censor: config.censor?.get(),
    director: config.director?.get(),
    summaryModel: config.summaryModel?.get(),
    ddlcDir: config.ddlcDir?.get(),
    wolfModel: config.wolfModel?.get(),
    wolfSeats: config.wolfSeats?.get(),
    mcHost: config.mcHost?.get(),
    mcPort: config.mcPort?.get(),
    mcUsername: config.mcUsername?.get(),
    mcRconPort: config.mcRconPort?.get(),
    mcRconPassword: config.mcRconPassword?.get(),
    mcCamera: config.mcCamera?.get(),
    mcClientDir: config.mcClientDir?.get(),
    mcJava: config.mcJava?.get(),
    mcCameraName: config.mcCameraName?.get(),
    mcHudPort: config.mcHudPort?.get(),
  }));
  // 直播插件（dsh-livestream）在的话，它提供直播身体：在播时她的话由它念，游戏画面由它放上舞台
  hooks.live = () => ctx.get?.('liveBody');
  ctx.effect(() => () => { hooks.live = undefined; }, 'dsh-game live body');
  // 在播时把这局游戏的画面交给直播插件（开局、画面准备好、下播、这局结束时都会变）
  let shown = 'null';
  ctx.effect(() => {
    const timer = setInterval(() => {
      const live = hooks.live?.();
      if (!live) return;
      const source = live.onAir ? (games.session?.liveSource?.() ?? null) : null;
      const key = JSON.stringify(source);
      if (key === shown) return;
      shown = key;
      live.showGame(source);
    }, 1000);
    return () => clearInterval(timer);
  }, 'dsh-game live screen');
  // 上次 DSH 被整个结束时，Minecraft 摄像机可能把鼠标锁在它窗口那块地方没放开：先解开
  releaseStaleClip(join(minecraftCameraDir(), 'hud'));
  // 插件卸载（DSH 关闭、重载）时关掉游戏连接、卸载 mod
  ctx.effect(() => () => { void games.stop(); }, 'dsh-game session');

  const route = (path: string, methods: string[], fetch: (request: Request) => Response | Promise<Response>, label: string) =>
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), label);

  // 舞台的唯一一条连接：她说的话（带语音）、游戏时刻；?frames=1 时还带游戏画面（每帧一个 frame 事件，JPEG base64）。
  // 浏览器对同一地址最多 6 个连接，DSH 自己也要用：所以画面、语音都走这一条，不另开
  route('/api/dsh-game/events', ['GET'], (request) => {
    const params = new URL(request.url).searchParams;
    const withFrames = params.get('frames') === '1';
    // 页面 id：同一时间只有一个页面出声（runtime 的 audio）
    const page = params.get('page') ?? `anon-${Math.random().toString(36).slice(2)}`;
    let listen: ((event: StageEvent) => void) | null = null;
    let stopFrames: (() => void) | null = null;
    let ping: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { /* 已关闭 */ } };
        listen = (event) => {
          // 不是出声的页面：只要文字，不带声音，也不回执
          const shaped = (event.type === 'say' || event.type === 'voice') && audio.owner !== page ? { ...event, audio: null, mute: true } : event;
          send(`data: ${JSON.stringify(shaped)}\n\n`);
        };
        listeners.add(listen);
        audio.connect(page);
        send(`data: ${JSON.stringify({ type: 'audio-owner', owner: audio.owner, at: Date.now() })}\n\n`);
        // 连上就交一次游戏状态（DSH 重启后页面重连，就知道已经没有游戏了）
        send(`data: ${JSON.stringify({ type: 'game-state', state: games.state(), at: Date.now() })}\n\n`);
        if (withFrames) {
          stopFrames = watchFrames((jpeg) => {
            // 浏览器还没收完前面的就丢掉这一帧（台词事件照常排队，不丢）
            if ((controller.desiredSize ?? 1) <= 0) return;
            send(`event: frame\ndata: ${jpeg.toString('base64')}\n\n`);
          });
        }
        ping = setInterval(() => send(': ping\n\n'), 15_000);
        send(': connected\n\n');
      },
      cancel() {
        if (listen) listeners.delete(listen);
        audio.disconnect(page);
        stopFrames?.();
        if (ping) clearInterval(ping);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }, 'dsh-game events');

  route('/api/dsh-game/library', ['GET'], () => {
    const entries = Object.values(GAMES).map((game) => game.library());
    return new Response(JSON.stringify(entries), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }, 'dsh-game library');

  // 游戏美术：第一次从 Steam 图床取，存到本地，之后直接读本地（离线也能显示）
  route('/api/dsh-game/art', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams;
    const game = GAMES[params.get('game') as GameId];
    const kind = params.get('kind') as ArtKind;
    if (!game || !(kind in STEAM_ART)) return new Response('bad request', { status: 400 });
    const { steamAppId, localArt } = game.library();
    // 插件自带的游戏：美术在插件包里
    if (localArt) {
      const local = localArt[kind];
      return local ? serveAsset(local) : new Response('not found', { status: 404 });
    }
    const file = join(ART_DIR, `${steamAppId}-${STEAM_ART[kind]}`);
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    try {
      return new Response(await readFile(file), { headers: { 'content-type': type, 'cache-control': 'max-age=86400' } });
    } catch {
      // 本地还没有
    }
    try {
      const res = await fetch(`https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/${STEAM_ART[kind]}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return new Response('not found', { status: 404 });
      const data = Buffer.from(await res.arrayBuffer());
      await mkdir(ART_DIR, { recursive: true });
      await writeFile(file, data);
      return new Response(data, { headers: { 'content-type': type, 'cache-control': 'max-age=86400' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }, 'dsh-game art');


  // 插件包 assets/ 里的图（狼人杀的立绘、身份牌）
  route('/api/dsh-game/asset', ['GET'], (request) => {
    const file = new URL(request.url).searchParams.get('path') ?? '';
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\.(png|jpg|webp)$/.test(file)) return new Response('bad path', { status: 400 });
    return serveAsset(file);
  }, 'dsh-game asset');

  // 狼人杀的开局设置要列出 DSH 里配好的模型：宿主的 llm 服务（每个供应商问一次它有哪些模型）
  hooks.listModels = async () => {
    const llm = ctx.get?.('llm');
    if (!llm?.listProviders || !llm.listModels) return null;
    const providers = llm.listProviders() as { id: string; name: string }[];
    const lists = await Promise.all(providers.map(async (p) => {
      try {
        const models = await llm.listModels(p.id) as { id: string; name?: string }[];
        return models.map((m) => ({ id: `${p.id}/${m.id}`, provider: p.id, providerName: p.name || p.id, name: m.name || m.id }));
      } catch {
        return [];
      }
    }));
    return lists.flat();
  };
  ctx.effect(() => () => { hooks.listModels = undefined; }, 'dsh-game model list');

  // Minecraft 的开局设置：GET 读设置和检查结果；PUT 存了再检查一遍
  route('/api/dsh-game/mc-setup', ['GET', 'PUT'], async (request) => {
    if (request.method === 'PUT') {
      try {
        mcSetup.save(await request.json() as Partial<McSetup>);
      } catch (err) {
        return new Response(JSON.stringify({ error: `没存上：${(err as Error).message}` }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify(await mcSetup.check()), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }, 'dsh-game minecraft setup');

  // Minecraft 的世界日志（开局设置里的服务器 + 她的名字那一本）：GET 读；DELETE 清空（旧的改名留着）。这局正开着时不能清
  route('/api/dsh-game/mc-journal', ['GET', 'DELETE'], async (request) => {
    const setup = mcSetup.load();
    const server = `${setup.host}:${setup.port}`;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (request.method === 'DELETE') {
      const state = games.state();
      if (state.game === 'minecraft' && state.status !== 'none' && state.status !== 'finished') return json({ error: '这局 Minecraft 还开着，结束了再清空' }, 409);
      WorldJournal.clear(minecraftJournalDir(), server, setup.username);
    }
    return json({ server, username: setup.username, text: WorldJournal.read(minecraftJournalDir(), server, setup.username) });
  }, 'dsh-game minecraft journal');

  // 狼人杀的开局设置：GET 读设置和检查结果；PUT 存了再检查一遍
  route('/api/dsh-game/wolf-setup', ['GET', 'PUT'], async (request) => {
    if (request.method === 'PUT') {
      try {
        wolfSetup.save(await request.json() as Partial<WolfSetup>);
      } catch (err) {
        return new Response(JSON.stringify({ error: `没存上：${(err as Error).message}` }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }
    const [check, voiced] = await Promise.all([wolfSetup.check(), hooks.tableVoiced?.().catch(() => true) ?? Promise.resolve(true)]);
    return new Response(JSON.stringify({ ...check, voiced }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }, 'dsh-game wolf setup');

  // 狼人杀：当前局面和最近的记录（界面打开、刷新时补上）
  // 狼人杀的观看视角：god 上帝视角 / fish 大肥鱼视角（下一拍起生效）
  route('/api/dsh-game/wolf-view', ['POST'], (request) => {
    const view = new URL(request.url).searchParams.get('view');
    const session = games.session;
    if (!(session instanceof WerewolfSession) || (view !== 'god' && view !== 'fish')) return new Response('bad request', { status: 400 });
    session.setView(view);
    return new Response('ok');
  }, 'dsh-game wolf view');

  // 狼人杀：上桌的主人在行动面板里做一件事（和她的 game_act 同一套动作和检查）
  route('/api/dsh-game/wolf-act', ['POST'], async (request) => {
    const session = games.session;
    if (!(session instanceof WerewolfSession)) return new Response(JSON.stringify({ error: '现在没有狼人杀' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const body = (await request.json().catch(() => ({}))) as { action?: string; index?: number; text?: string };
    const refusal = session.ownerAct({ action: String(body.action ?? ''), index: body.index, text: body.text });
    return new Response(JSON.stringify(refusal ? { error: refusal } : { ok: true }), { status: refusal ? 400 : 200, headers: { 'content-type': 'application/json' } });
  }, 'dsh-game wolf act');

  route('/api/dsh-game/wolf', ['GET'], () => {
    const session = games.session;
    const body = session instanceof WerewolfSession ? { state: session.state, history: session.history } : { state: null, history: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }, 'dsh-game wolf');

  route('/api/dsh-game/clips', ['GET'], async (request) => {
    const file = new URL(request.url).searchParams.get('name') ?? '';
    if (!/^[a-z-]+$/.test(file)) return new Response('bad name', { status: 400 });
    try {
      const data = await readFile(join(clipsDir(), `${file}.webm`));
      return new Response(data, { headers: { 'content-type': 'video/webm', 'cache-control': 'max-age=3600' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }, 'dsh-game clips');


  // 主人在这个页面里点过、按过键：以后由它出声
  route('/api/dsh-game/claim', ['POST'], (request) => {
    audio.claim(new URL(request.url).searchParams.get('page') ?? '');
    return new Response('ok');
  }, 'dsh-game claim');

  // 主人按了停止：游戏停在下一句话之前
  route('/api/dsh-game/pause', ['POST'], () => {
    games.pause();
    return new Response('ok');
  }, 'dsh-game pause');

  // 主人按了「结束这局」
  route('/api/dsh-game/close', ['POST'], async () => {
    await games.close('owner');
    return new Response('ok');
  }, 'dsh-game close');

  // 这局游戏现在的状态（页面打开时要一次，之后跟着 game-state 事件）
  // 她这局看过的图（Minecraft 图纸的渲染图、地形图）：列表、单张
  route('/api/dsh-game/gallery', ['GET'], () => new Response(JSON.stringify(games.session?.gallery?.() ?? []), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), 'dsh-game gallery');
  route('/api/dsh-game/gallery-image', ['GET'], (request) => {
    const id = Number(new URL(request.url).searchParams.get('id'));
    const image = games.session?.galleryImage?.(id);
    if (!image) return new Response('not found', { status: 404 });
    return new Response(Buffer.from(image.data), { headers: { 'content-type': image.mediaType, 'cache-control': 'private, max-age=3600' } });
  }, 'dsh-game gallery image');

  route('/api/dsh-game/state', ['GET'], () => new Response(JSON.stringify(games.state()), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), 'dsh-game state');

  // 切换游戏客户端的视角（Minecraft 摄像机：follow 跟拍 / first / back / front）
  route('/api/dsh-game/view', ['POST'], async (request) => {
    const mode = new URL(request.url).searchParams.get('mode') ?? '';
    const result = (await games.session?.setClientView?.(mode)) ?? '没有能切视角的游戏';
    return new Response(result, { status: result === 'ok' ? 200 : 409 });
  }, 'dsh-game view');

  route('/api/dsh-game/nudge', ['POST'], () => {
    games.session?.nudge?.();
    return new Response('ok');
  }, 'dsh-game nudge');

  // 开发测试：跳到某个段落 / 显示某张图（分段测试用；只在启动环境里有 DSH_GAME_DEV=1 时才有这个路由）
  if (process.env.DSH_GAME_DEV === '1') {
    let devLive: (LiveBody & { onAir: boolean; shown: unknown; calls: Set<() => void> }) | null = null;
    route('/api/dsh-game/dev', ['POST'], async (request) => {
      const params = new URL(request.url).searchParams;
      // 假装在直播（没装直播插件时测约定）：live=on / off 开播下播，live=call 直播间来消息；返回放上舞台的画面
      if (params.has('live')) {
        const op = params.get('live');
        if (op === 'on' || op === 'off') {
          const stub = devLive ?? (devLive = {
            onAir: false,
            shown: null as unknown,
            calls: new Set<() => void>(),
            attention(signal: AbortSignal) {
              return new Promise<void>((resolve, reject) => {
                const call = () => { this.calls.delete(call); resolve(); };
                this.calls.add(call);
                signal.addEventListener('abort', () => { this.calls.delete(call); reject(new Error('aborted')); }, { once: true });
              });
            },
            showGame(source: unknown) { this.shown = source; console.info(`[dsh-game/dev] showGame ${JSON.stringify(source)}`); },
          });
          stub.onAir = op === 'on';
          hooks.live = () => ctx.get?.('liveBody') ?? devLive ?? undefined;
        }
        if (op === 'call') for (const call of [...(devLive?.calls ?? [])]) call();
        return new Response(JSON.stringify({ onAir: devLive?.onAir ?? false, shown: devLive?.shown ?? null }));
      }
      // 狼人杀：下一局主人拿什么身份（wolf / seer / witch / hunter / villager，空是随机）
      if (params.has('ownerRole')) {
        const role = params.get('ownerRole') ?? '';
        devOptions.ownerRole = (['wolf', 'seer', 'witch', 'hunter', 'villager'].includes(role) ? role : null) as typeof devOptions.ownerRole;
        return new Response(`下一局主人的身份：${devOptions.ownerRole ?? '随机'}`);
      }
      // 删角色文件（测资源管理器的演出）：不用开游戏
      const del = params.get('delete');
      if (del) {
        const dir = findDdlcDir(settings.ddlcDir);
        return new Response(dir ? await deleteCharacter(dir, del, (t) => console.info(`[dsh-game/dev] ${t}`)) : 'no game dir');
      }
      const ok = games.session?.dev?.({ jump: params.get('jump') ?? undefined, show: params.get('show') ?? undefined }) ?? false;
      return new Response(ok ? 'ok' : 'no game', { status: ok ? 200 : 409 });
    }, 'dsh-game dev');
  }

  route('/api/dsh-game/said', ['POST'], (request) => {
    speeches.get(new URL(request.url).searchParams.get('id') ?? '')?.done();
    return new Response('ok');
  }, 'dsh-game said');
}
