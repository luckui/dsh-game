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

export function rcon(target: RconTarget, command: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(target.port, target.host);
    const packet = (id: number, type: number, body: string) => {
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
          sock.write(packet(2, 2, command));
        } else {
          sock.end();
          resolve(body);
        }
      }
    });
  });
}
