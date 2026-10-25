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
 * 一直开着的 RCON 连接（跟拍镜头一秒十来条 tp）：每条新开一个连接的话，服务器每次都往日志里写两行「RCON Client 开了 / 关了」，
 * 远程服务器上每条还要多等一次握手。
 * 一次只有一条在路上：写一条、等到同一个编号的回复再写下一条。原版 RCON 一次读只处理一个包，几条命令被合进同一个 TCP 段，
 * 它一条都不执行、直接断开（跟拍换机位要连着发 kill + summon + spectate，合包以后镜头实体再也放不出来）。
 * 5 秒没回音就当连接坏了，断掉重连；排着的命令连上以后接着发
 */
export class RconLink {
  private sock: net.Socket | null = null;
  private ready = false;
  private queue: string[] = [];
  private inFlight: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private seq = 10;
  /** 密码不对：不再重连 */
  private refused = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: RconTarget) {}

  /** 还没回来的条数（发出去没回复的 + 排着的）：跟拍看它决定这一步要不要再发 tp（排着的旧位置没用） */
  get backlog(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  send(command: string): void {
    if (this.refused) return;
    this.queue.push(command);
    if (this.queue.length > 32) this.queue.shift();
    this.pump();
  }

  close(): void {
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    if (this.retry) clearTimeout(this.retry);
    this.inFlight = null;
    this.retry = null;
    this.queue = [];
    this.sock?.destroy();
    this.sock = null;
    this.ready = false;
  }

  private pump(): void {
    if (!this.sock) {
      if (!this.retry) this.open();
      return;
    }
    if (!this.ready || this.inFlight || !this.queue.length) return;
    const sock = this.sock;
    const id = ++this.seq;
    const timer = setTimeout(() => { if (this.inFlight?.id === id) sock.destroy(); }, 5000);
    this.inFlight = { id, timer };
    sock.write(packet(id, 2, this.queue.shift()!));
  }

  private open(): void {
    const sock = net.connect(this.target.port, this.target.host);
    this.sock = sock;
    let data = Buffer.alloc(0);
    // 3 秒还没握完手（服务器卡住、连接没回音）：丢掉重连
    const giveUp = setTimeout(() => { if (!this.ready && this.sock === sock) sock.destroy(); }, 3000);
    sock.on('connect', () => sock.write(packet(1, 3, this.target.password)));
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const id = data.readInt32LE(4);
        data = data.subarray(4 + data.readInt32LE(0));
        if (this.sock !== sock) continue;
        if (!this.ready) {
          clearTimeout(giveUp);
          if (id === -1) { this.refused = true; this.queue = []; sock.destroy(); continue; }
          this.ready = true;
        } else if (this.inFlight?.id === id) {
          clearTimeout(this.inFlight.timer);
          this.inFlight = null;
        }
        this.pump();
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(giveUp);
      if (this.sock !== sock) return;
      if (this.inFlight) clearTimeout(this.inFlight.timer);
      this.inFlight = null;
      this.sock = null;
      this.ready = false;
      // 还有没发的：隔 1 秒重连（服务器重启时不一直猛连）
      if (this.queue.length && !this.refused) {
        this.retry = setTimeout(() => { this.retry = null; this.pump(); }, 1000);
      }
    });
  }
}
