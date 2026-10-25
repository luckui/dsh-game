/**
 * 最小的 RCON 客户端（Source RCON 协议）：给自己的服务器发管理命令，比如把旁观的主人挂到她身上。
 * 只在主人填了 RCON 密码时用；去别人的服务器时没有这个。
 */
import net from 'node:net';

export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

function packet(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

export function rcon(target: RconTarget, command: string, timeoutMs = 5000): Promise<string> {
  return rconBatch(target, [command], timeoutMs).then((replies) => replies[0]);
}

/** 一个连接里按顺序发一串命令（一次发几百条时比每条新开连接快得多） */
export function rconBatch(target: RconTarget, commands: string[], timeoutMs = 5000): Promise<string[]> {
  if (!commands.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const sock = net.connect(target.port, target.host);
    let data = Buffer.alloc(0);
    let authed = false;
    const replies: string[] = [];
    // 每条命令单独计时：一串命令总共可以很久，但一条没回音就算断了
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('RCON timeout')); });
    sock.on('error', reject);
    sock.on('connect', () => sock.write(packet(1, 3, target.password)));
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const len = data.readInt32LE(0);
        const id = data.readInt32LE(4);
        const body = data.subarray(12, 4 + len - 2).toString('utf8');
        data = data.subarray(4 + len);
        if (!authed) {
          if (id === -1) { sock.destroy(); reject(new Error('RCON password rejected')); return; }
          authed = true;
          sock.write(packet(2, 2, commands[0]));
        } else {
          replies.push(body);
          if (replies.length === commands.length) {
            sock.end();
            resolve(replies);
          } else {
            sock.write(packet(2 + replies.length, 2, commands[replies.length]));
          }
        }
      }
    });
  });
}

/**
 * 一直开着的 RCON 连接，只管发、不等回音（跟拍镜头一秒十来条 tp）。
 * 每条新开一个连接的话，服务器每次都往日志里写两行「RCON Client 开了 / 关了」，远程服务器上每条还要多等一次握手；
 * 断了就丢掉，下次发的时候重连（连上之前最多攒几条，旧的丢掉：镜头只要最新的位置）
 */
export class RconLink {
  private sock: net.Socket | null = null;
  private ready = false;
  private pending: string[] = [];
  private seq = 10;
  /** 密码不对：不再重连 */
  private refused = false;

  constructor(private readonly target: RconTarget) {}

  send(command: string): void {
    if (this.ready && this.sock) {
      this.sock.write(packet(++this.seq, 2, command));
      return;
    }
    if (this.refused) return;
    this.pending.push(command);
    if (this.pending.length > 8) this.pending.shift();
    if (!this.sock) this.open();
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
    this.ready = false;
    this.pending = [];
  }

  private open(): void {
    const sock = net.connect(this.target.port, this.target.host);
    this.sock = sock;
    let data = Buffer.alloc(0);
    // 3 秒还没握完手（服务器卡住、连接没回音）：丢掉，下次发的时候重连
    const giveUp = setTimeout(() => { if (!this.ready && this.sock === sock) sock.destroy(); }, 3000);
    sock.on('connect', () => sock.write(packet(1, 3, this.target.password)));
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const id = data.readInt32LE(4);
        data = data.subarray(4 + data.readInt32LE(0));
        if (this.ready || this.sock !== sock) continue;
        clearTimeout(giveUp);
        if (id === -1) { this.refused = true; sock.destroy(); continue; }
        this.ready = true;
        for (const command of this.pending.splice(0)) sock.write(packet(++this.seq, 2, command));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(giveUp);
      if (this.sock !== sock) return;
      this.sock = null;
      this.ready = false;
    });
  }
}
