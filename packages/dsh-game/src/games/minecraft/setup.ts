/**
 * Minecraft 的开局设置：玩法、服务器、她的名字、摄像机客户端。游戏库里选中 Minecraft 时的「开局设置」面板读写它，开局时按它连。
 *   - 存在 DSH 主目录的 dsh-game/minecraft-setup.json，只有这一份。旧版插件设置里的 mc* 只在还没有这个文件时搬过来
 *   - 玩法：solo（她自己玩，主人在旁边看）；duo（主人用自己的客户端进同一个服务器一起玩）是下一阶段，现在选不了
 *   - 游戏模式：survival（生存）/ creative（创造：方块随便用、能飞，盖房子一层层长出来；要 RCON）
 *   - checkSetup()：服务器连不连得上、什么版本，这个版本的客户端装没装、Java 在不在，RCON 密码对不对，名字和端口对不对。
 *     面板逐项显示；有问题时「让大肥鱼玩」不能点，她自己调 game_start 时也先查一遍
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findJava, findMinecraftRoot } from './camera.js';
import { rcon } from './rcon.js';

export type McMode = 'solo' | 'duo';
export type McGameMode = 'survival' | 'creative';

export interface McSetup {
  mode: McMode;
  /** 生存 / 创造（开局时用 RCON 切过去） */
  gameMode: McGameMode;
  /** 双人：主人在游戏里的名字 */
  ownerName: string;
  host: string;
  port: number;
  /** 她在游戏里的名字 */
  username: string;
  /** 摄像机客户端（真的 Minecraft 客户端，旁观挂在她身上） */
  camera: boolean;
  cameraName: string;
  rconPort: number;
  rconPassword: string;
  /** 装好游戏的 .minecraft（空 = 官方启动器的默认位置） */
  clientDir: string;
  /** Java 21（空 = 自动找） */
  java: string;
  /** HUD 网页的端口（0 = 不开） */
  hudPort: number;
}

/** 旧版插件设置（mc*） */
export type LegacyMcSettings = Partial<Omit<McSetup, 'mode' | 'ownerName' | 'gameMode'>>;

export interface McCheckItem {
  ok: boolean;
  /** 界面上显示的状态：「1.21.4 · 1 人在线」「已装（HMCL）」 */
  label: string;
  problem?: string;
}

export interface McSetupCheck {
  setup: McSetup;
  /** 服务器的版本（连上了才有） */
  version: string | null;
  items: { server: McCheckItem; names: McCheckItem; client: McCheckItem; java: McCheckItem; rcon: McCheckItem; hud: McCheckItem };
  /** 开不了局的原因；没问题是 null */
  problem: string | null;
}

const FILE = path.join(process.env.DSH_HOME ?? os.tmpdir(), 'dsh-game', 'minecraft-setup.json');
const NAME = /^[A-Za-z0-9_]{3,16}$/;

const DEFAULTS: McSetup = {
  mode: 'solo', gameMode: 'survival', ownerName: '', host: '127.0.0.1', port: 25565, username: 'DaFeiYu',
  camera: true, cameraName: 'DaFeiYuCam', rconPort: 25575, rconPassword: '', clientDir: '', java: '', hudPort: 7391,
};

function normalize(raw: Partial<McSetup>): McSetup {
  const num = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 65535 ? Number(v) : d);
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v.trim() : d);
  return {
    // 双人模式还没做：存下来的也按单人
    mode: 'solo',
    gameMode: raw.gameMode === 'creative' ? 'creative' : 'survival',
    ownerName: str(raw.ownerName, DEFAULTS.ownerName),
    host: str(raw.host, DEFAULTS.host) || DEFAULTS.host,
    port: num(raw.port, DEFAULTS.port) || DEFAULTS.port,
    username: str(raw.username, DEFAULTS.username) || DEFAULTS.username,
    camera: typeof raw.camera === 'boolean' ? raw.camera : DEFAULTS.camera,
    cameraName: str(raw.cameraName, DEFAULTS.cameraName) || DEFAULTS.cameraName,
    rconPort: num(raw.rconPort, DEFAULTS.rconPort) || DEFAULTS.rconPort,
    rconPassword: str(raw.rconPassword, DEFAULTS.rconPassword),
    clientDir: str(raw.clientDir, DEFAULTS.clientDir),
    java: str(raw.java, DEFAULTS.java),
    hudPort: num(raw.hudPort, DEFAULTS.hudPort),
  };
}

async function rconCheck(setup: McSetup, why: string): Promise<McCheckItem> {
  if (!setup.rconPassword) return { ok: false, label: '没填密码', problem: `${why}：填服务器 server.properties 里的 rcon.password（并开 enable-rcon=true）` };
  const reply = await rcon({ host: setup.host, port: setup.rconPort, password: setup.rconPassword }, 'list', 3000).catch((err: Error) => err);
  return reply instanceof Error
    ? { ok: false, label: '连不上', problem: `RCON（${setup.host}:${setup.rconPort}）：${reply.message}` }
    : { ok: true, label: '密码对' };
}

/** 读设置：有文件读文件，没有就从旧版插件设置搬过来 */
export function loadSetup(legacy: LegacyMcSettings): McSetup {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<McSetup>);
  } catch {
    return normalize(legacy);
  }
}

export function saveSetup(setup: Partial<McSetup>, legacy: LegacyMcSettings): McSetup {
  const clean = normalize({ ...loadSetup(legacy), ...setup });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

/** Minecraft 的服务器列表查询（Server List Ping）：连得上就返回版本和在线人数 */
export function pingServer(host: string, port: number, timeoutMs = 4000): Promise<{ version: string; protocol: number; online: number; max: number }> {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const packet = (...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([varint(body.length), body]);
  };
  const hostBytes = Buffer.from(host, 'utf8');
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let data = Buffer.alloc(0);
    const done = (err: Error | null, value?: any) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('连接超时')), timeoutMs);
    sock.on('error', (err) => done(err));
    sock.on('connect', () => {
      // 握手（协议号 -1 = 只是查询）+ 状态请求
      sock.write(packet(varint(0), varint(0xffffffff), varint(hostBytes.length), hostBytes, portBytes, varint(1)));
      sock.write(packet(varint(0)));
    });
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const read = (buf: Buffer, at: number): [number, number] => {
        let value = 0;
        let shift = 0;
        for (let i = at; i < buf.length && i < at + 5; i++) {
          value |= (buf[i] & 0x7f) << shift;
          shift += 7;
          if (!(buf[i] & 0x80)) return [value, i + 1];
        }
        return [-1, at];
      };
      const [length, afterLength] = read(data, 0);
      if (length < 0 || data.length < afterLength + length) return;
      const [, afterId] = read(data, afterLength);
      const [jsonLength, afterJsonLength] = read(data, afterId);
      try {
        const json = JSON.parse(data.toString('utf8', afterJsonLength, afterJsonLength + jsonLength));
        done(null, { version: String(json.version?.name ?? ''), protocol: Number(json.version?.protocol ?? 0), online: Number(json.players?.online ?? 0), max: Number(json.players?.max ?? 0) });
      } catch (err) {
        done(err as Error);
      }
    });
  });
}

/** 端口能不能用（没被别的程序占着） */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * 检查这份设置开不开得了局。
 * hudInUse：这局 Minecraft 正开着（HUD 网页就是我们自己占着那个端口，不算被占）
 */
export async function checkSetup(setup: McSetup, hudInUse = false): Promise<McSetupCheck> {
  const ping = await pingServer(setup.host, setup.port).catch((err: Error) => err);
  const version = ping instanceof Error ? null : ping.version.replace(/^[^\d]*/, '').split(/\s/)[0] || null;
  const server: McCheckItem = ping instanceof Error
    ? { ok: false, label: '连不上', problem: `连不上 ${setup.host}:${setup.port}（${ping.message}）：先把服务器开起来` }
    : { ok: true, label: `${ping.version} · ${ping.online}/${ping.max} 人在线` };

  const badNames = [
    !NAME.test(setup.username) && `她的名字「${setup.username}」`,
    setup.camera && !NAME.test(setup.cameraName) && `摄像机的名字「${setup.cameraName}」`,
    setup.camera && setup.cameraName === setup.username && '摄像机的名字和她的一样',
  ].filter(Boolean);
  const names: McCheckItem = badNames.length
    ? { ok: false, label: '名字不对', problem: `${badNames.join('、')}：Minecraft 的名字是 3~16 个英文字母、数字或下划线` }
    : { ok: true, label: setup.camera ? `${setup.username}，摄像机 ${setup.cameraName}` : setup.username };

  let client: McCheckItem = { ok: true, label: '不开摄像机' };
  let java: McCheckItem = { ok: true, label: '不开摄像机' };
  let rconItem: McCheckItem = setup.gameMode === 'creative'
    ? await rconCheck(setup, '创造模式要用 RCON 切游戏模式、一层层放方块')
    : { ok: true, label: '不开摄像机' };
  let hud: McCheckItem = { ok: true, label: '不开摄像机' };
  if (setup.camera) {
    const root = version ? findMinecraftRoot(setup.clientDir, version) : null;
    client = !version
      ? { ok: false, label: '要先连上服务器', problem: '连上服务器才知道要哪个版本的客户端' }
      : root
        ? { ok: true, label: `${version} · ${root}` }
        : { ok: false, label: `没装 ${version}`, problem: `没找到装好的 Minecraft ${version}：用 HMCL 或官方启动器装好这个版本；装在别处的话填 .minecraft 目录` };
    const javaPath = findJava(setup.java, root ?? '');
    java = javaPath !== 'javaw' && fs.existsSync(javaPath)
      ? { ok: true, label: javaPath }
      : { ok: false, label: '没找到', problem: '没找到 Java 21：HMCL 或官方启动器启动过一次这个版本就会带上；或者填 Java 的路径' };
    if (setup.gameMode !== 'creative') rconItem = await rconCheck(setup, '摄像机要用 RCON 切成旁观模式');
    hud = !setup.hudPort
      ? { ok: true, label: '不开 HUD 网页' }
      : hudInUse || (await portFree(setup.hudPort))
        ? { ok: true, label: `http://127.0.0.1:${setup.hudPort}/` }
        : { ok: false, label: '端口被占', problem: `HUD 网页的端口 ${setup.hudPort} 被别的程序占着：换一个，或者填 0 不开` };
  }

  const items = { server, names, client, java, rcon: rconItem, hud };
  const problems = Object.values(items).filter((i) => !i.ok).map((i) => i.problem);
  return { setup, version, items, problem: problems.length ? problems.join('；') : null };
}
