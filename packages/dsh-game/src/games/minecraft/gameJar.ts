/**
 * 读游戏 jar（就是个 zip）里的单个文件：版本号、贴图、模型。只读中央目录建索引，用到哪个文件才解压哪个。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export class GameJar {
  private readonly buf: Buffer;
  private readonly entries = new Map<string, { method: number; size: number; local: number }>();

  constructor(file: string) {
    this.buf = fs.readFileSync(file);
    const eocd = this.buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`not a zip: ${file}`);
    const count = this.buf.readUInt16LE(eocd + 10);
    let p = this.buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      const nameLen = this.buf.readUInt16LE(p + 28);
      this.entries.set(this.buf.toString('utf8', p + 46, p + 46 + nameLen), {
        method: this.buf.readUInt16LE(p + 10),
        size: this.buf.readUInt32LE(p + 20),
        local: this.buf.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + this.buf.readUInt16LE(p + 30) + this.buf.readUInt16LE(p + 32);
    }
  }

  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + this.buf.readUInt16LE(e.local + 26) + this.buf.readUInt16LE(e.local + 28);
    const raw = this.buf.subarray(start, start + e.size);
    return e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
  }

  json(name: string): any {
    const data = this.read(name);
    if (!data) return null;
    try {
      return JSON.parse(data.toString('utf8'));
    } catch {
      return null;
    }
  }
}
