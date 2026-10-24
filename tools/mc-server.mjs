// 本地 Minecraft 服务器（开发用，.mc-server/，不提交）。
//   node tools/mc-server.mjs start          后台启动（Java 21：$MC_JAVA，或 HMCL 自带的 Mojang 运行时）
//   node tools/mc-server.mjs stop           通过 RCON 存档并关服
//   node tools/mc-server.mjs status         在不在线、谁在线
//   node tools/mc-server.mjs cmd <命令...>   通过 RCON 执行一条服务器命令（不带斜杠）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const DIR = path.join(ROOT, '.mc-server');
const props = Object.fromEntries(
  fs.readFileSync(path.join(DIR, 'server.properties'), 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

function findJava() {
  if (process.env.MC_JAVA) return process.env.MC_JAVA;
  const hmcl = path.join(os.homedir(), 'AppData', 'Roaming', '.hmcl', 'java', 'windows-x86_64', 'mojang-java-runtime-delta', 'bin', 'java.exe');
  if (fs.existsSync(hmcl)) return hmcl;
  return 'java';
}

/** 最小 RCON 客户端（Source RCON 协议：登录 type 3，命令 type 2） */
function rcon(command) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(props['rcon.port'] || 25575), '127.0.0.1');
    const packet = (id, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const buf = Buffer.alloc(14 + b.length);
      buf.writeInt32LE(10 + b.length, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      b.copy(buf, 12);
      return buf;
    };
    let data = Buffer.alloc(0);
    let authed = false;
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('RCON 超时')); });
    sock.on('error', reject);
    sock.on('connect', () => sock.write(packet(1, 3, props['rcon.password'])));
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const len = data.readInt32LE(0);
        const id = data.readInt32LE(4);
        const body = data.subarray(12, 4 + len - 2).toString('utf8');
        data = data.subarray(4 + len);
        if (!authed) {
          if (id === -1) { sock.destroy(); reject(new Error('RCON 密码不对')); return; }
          authed = true;
          sock.write(packet(2, 2, command));
        } else {
          sock.end();
          resolve(body);
        }
      }
    });
  });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'start') {
  try {
    console.log('已经在运行：', await rcon('list'));
    process.exit(0);
  } catch { /* 没在运行 */ }
  const log = fs.openSync(path.join(DIR, 'console.log'), 'a');
  const child = spawn(findJava(), ['-Xms1G', '-Xmx3G', '-jar', 'server.jar', 'nogui'], {
    cwd: DIR, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync(path.join(DIR, 'server.pid'), String(child.pid));
  process.stdout.write(`启动中（pid ${child.pid}）`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await rcon('list');
      console.log('\n服务器就绪：127.0.0.1:' + (props['server-port'] || 25565));
      process.exit(0);
    } catch { process.stdout.write('.'); }
  }
  console.log('\n3 分钟还没就绪，看 .mc-server/console.log');
  process.exit(1);
} else if (cmd === 'stop') {
  console.log(await rcon('stop').catch((e) => `没在运行（${e.message}）`));
} else if (cmd === 'status') {
  console.log(await rcon('list').catch(() => '没在运行'));
} else if (cmd === 'cmd') {
  console.log(await rcon(rest.join(' ')));
} else {
  console.log('用法：node tools/mc-server.mjs start | stop | status | cmd <命令>');
}
