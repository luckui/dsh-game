/**
 * 世界日志：一个服务器上的一个她（地址 + 名字）一本，连着几天玩同一个世界时能接着上次。
 * 存在 DSH 主目录（dsh-game/minecraft-worlds/<地址>__<名字>.json），每次有变化马上写盘。
 *
 *   她写的：长期目标（goal）、图纸（design / template）、地点（mark：家、矿洞、村庄……哪里值得记由她定）
 *   身体自动记的（做完、结果明确的事）：盖过的建筑、种的地、睡过的床、死在哪、这局结束时在哪做什么
 *   背包变化、聊天、每个时刻的状态不记（那些是流水，不是日志）
 *
 * 开了 RCON 时记下世界种子：下次开局种子对不上（服务器换了新世界），旧日志改名留着，开一本新的。
 * 上限：地点、建筑、地各 30 条（开局只给她看最近 10 条，journal 看全部），图纸 20 张（丢最久没用的），死亡留最近 5 次。
 */
import fs from 'node:fs';
import path from 'node:path';

interface Spot {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

interface JournalData {
  version: 1;
  server: string;
  username: string;
  seed?: string;
  /** 在这个世界开过几局 */
  sessions: number;
  goal?: string;
  designs: { name: string; text: string; usedAt: number }[];
  buildings: (Spot & { name: string; done: number; total: number; at: number })[];
  fields: (Spot & { crop: string; size: number; at: number })[];
  places: (Spot & { name: string; at: number })[];
  bed?: Spot & { at: number };
  deaths: (Spot & { at: number })[];
  deathCount: number;
  /** 走过的传送门：两头的位置 */
  portals?: { a: Spot; b: Spot; at: number }[];
  last?: Spot & { at: number; doing?: string; inventory?: string };
}

const MAX_LIST = 30;
const SHOWN = 10;
const MAX_DESIGNS = 20;
const MAX_DEATHS = 5;

const DIMENSIONS: Record<string, string> = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
export const dimensionName = (d: string): string => DIMENSIONS[d.replace('minecraft:', '')] ?? d;
const at = (s: Spot) => `${s.dimension && dimensionName(s.dimension) !== '主世界' ? `${dimensionName(s.dimension)} ` : ''}(${s.x}, ${s.y}, ${s.z})`;

/** 现实时间：「10 月 24 日晚上」 */
export function when(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日${part}`;
}

export function journalFile(dir: string, server: string, username: string): string {
  return path.join(dir, `${server.replace(/[^A-Za-z0-9.-]+/g, '_')}__${username.replace(/[^A-Za-z0-9_]+/g, '_')}.json`);
}

/** 把旧文件改名留着（换了新世界、主人清空时） */
function setAside(file: string, why: string): void {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, file.replace(/\.json$/, `.${why}-${stamp}.json`));
}

export class WorldJournal {
  private constructor(readonly file: string, private data: JournalData) {}

  /** 打开（没有就新开一本）。seed 对不上：旧的改名留着，开新的；note 说明发生了什么 */
  static open(dir: string, server: string, username: string, seed?: string | null): { journal: WorldJournal; note?: string } {
    const file = journalFile(dir, server, username);
    const fresh = (): JournalData => ({ version: 1, server, username, ...(seed ? { seed } : {}), sessions: 0, designs: [], buildings: [], fields: [], places: [], deaths: [], deathCount: 0 });
    let data: JournalData | null = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as JournalData;
    } catch {
      data = null;
    }
    let note: string | undefined;
    if (data && seed && data.seed && data.seed !== seed) {
      setAside(file, 'old-world');
      note = '这个服务器换了一个新世界（种子变了），上一个世界的日志收起来了，这本从头记。';
      data = null;
    }
    const journal = new WorldJournal(file, data ? { ...fresh(), ...data, ...(seed ? { seed } : {}) } : fresh());
    return { journal, note };
  }

  /** 主人在设置里清空：改名留着 */
  static clear(dir: string, server: string, username: string): boolean {
    const file = journalFile(dir, server, username);
    if (!fs.existsSync(file)) return false;
    setAside(file, 'cleared');
    return true;
  }

  /** 设置面板看的：没有这本就是 null */
  static read(dir: string, server: string, username: string): string | null {
    const file = journalFile(dir, server, username);
    if (!fs.existsSync(file)) return null;
    return WorldJournal.open(dir, server, username).journal.full();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get goal(): string | undefined {
    return this.data.goal;
  }

  get designs(): { name: string; text: string }[] {
    return this.data.designs;
  }

  startSession(): void {
    this.data.sessions += 1;
    this.save();
  }

  setGoal(goal: string): void {
    this.data.goal = goal;
    this.save();
  }

  saveDesign(name: string, text: string): void {
    this.data.designs = [{ name, text, usedAt: Date.now() }, ...this.data.designs.filter((d) => d.name !== name)]
      .sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_DESIGNS);
    this.save();
  }

  usedDesign(name: string): void {
    const d = this.data.designs.find((x) => x.name === name);
    if (!d) return;
    d.usedAt = Date.now();
    this.save();
  }

  /** 盖过的这座建筑（最近的在前） */
  buildingsNamed(name: string): { x: number; y: number; z: number; dimension: string }[] {
    return this.data.buildings.filter((b) => b.name === name);
  }

  /** 盖完（或盖了一部分）：同一个名字盖在同一个地方算同一座 */
  addBuilding(name: string, spot: Spot, done: number, total: number): void {
    this.data.buildings = [{ name, ...spot, done, total, at: Date.now() }, ...this.data.buildings.filter((b) => !(b.name === name && b.x === spot.x && b.y === spot.y && b.z === spot.z))].slice(0, MAX_LIST);
    this.save();
  }

  addField(crop: string, spot: Spot, size: number): void {
    this.data.fields = [{ crop, ...spot, size, at: Date.now() }, ...this.data.fields.filter((f) => !(f.x === spot.x && f.y === spot.y && f.z === spot.z))].slice(0, MAX_LIST);
    this.save();
  }

  /** 记一个地点（同名覆盖）；spot 为 null 是删掉。返回给她看的一句话 */
  mark(name: string, spot: Spot | null): string {
    const had = this.data.places.some((p) => p.name === name);
    this.data.places = this.data.places.filter((p) => p.name !== name);
    if (!spot) {
      this.save();
      return had ? `「${name}」从日志里删掉了。` : `日志里本来就没有「${name}」。`;
    }
    this.data.places = [{ name, ...spot, at: Date.now() }, ...this.data.places].slice(0, MAX_LIST);
    this.save();
    return `记下了：「${name}」在 ${at(spot)}${had ? '（原来记的位置换成了这个）' : ''}。`;
  }

  setBed(spot: Spot): void {
    this.data.bed = { ...spot, at: Date.now() };
    this.save();
  }

  addDeath(spot: Spot): void {
    this.data.deaths = [{ ...spot, at: Date.now() }, ...this.data.deaths].slice(0, MAX_DEATHS);
    this.data.deathCount += 1;
    this.save();
  }

  /** 走了一次传送门：两头记下（同一对门只记一次） */
  addPortal(a: Spot, b: Spot): void {
    // 主世界那头写在前面（从哪边走过来都一样）
    if (b.dimension === 'overworld' && a.dimension !== 'overworld') [a, b] = [b, a];
    const near = (p: Spot, q: Spot) => p.dimension === q.dimension && Math.abs(p.x - q.x) <= 3 && Math.abs(p.y - q.y) <= 3 && Math.abs(p.z - q.z) <= 3;
    const same = (x: { a: Spot; b: Spot }) => (near(x.a, a) && near(x.b, b)) || (near(x.a, b) && near(x.b, a));
    this.data.portals = [{ a, b, at: Date.now() }, ...(this.data.portals ?? []).filter((x) => !same(x))].slice(0, MAX_LIST);
    this.save();
  }

  /** 这局玩到哪了（结束时，以及玩的过程中每隔一阵：DSH 被直接关掉也有个大概） */
  setLast(spot: Spot, doing?: string, inventory?: string): void {
    this.data.last = { ...spot, at: Date.now(), ...(doing ? { doing } : {}), ...(inventory ? { inventory } : {}) };
    this.save();
  }

  /** 开局时给她的事实（这一局算进 sessions 之前调用） */
  intro(): string {
    const d = this.data;
    if (!d.sessions) return `【这个世界】你第一次来这个世界（${d.server}）。你写下的目标、存好的图纸、mark 记的地点，还有盖过的房子、种过的地、床和死过的地方，都会记在这个世界的日志里，下次来还在。`;
    const lines = [`【这个世界】你在这里玩过 ${d.sessions} 次${d.last ? `，上次是 ${when(d.last.at)}，结束时在 ${dimensionName(d.last.dimension)} (${d.last.x}, ${d.last.y}, ${d.last.z})${d.last.doing ? `，正在${d.last.doing}` : ''}` : ''}。`];
    lines.push(...this.body(SHOWN));
    lines.push('这些记在这个世界的日志里（journal 看全部）。');
    return lines.join('\n');
  }

  /** 整本（journal 动作、设置面板） */
  full(): string {
    const d = this.data;
    const lines = [`这个世界（${d.server}，你叫 ${d.username}）的日志：玩过 ${d.sessions} 次。`];
    if (d.last) lines.push(`最后记下：${when(d.last.at)}在 ${dimensionName(d.last.dimension)} (${d.last.x}, ${d.last.y}, ${d.last.z})${d.last.doing ? `，正在${d.last.doing}` : ''}${d.last.inventory ? `；身上：${d.last.inventory}` : ''}`);
    const body = this.body(MAX_LIST);
    lines.push(...(body.length ? body : ['还什么都没记。']));
    return lines.join('\n');
  }

  private body(limit: number): string[] {
    const d = this.data;
    const more = (n: number) => (n > limit ? `……还有 ${n - limit} 个` : '');
    const out: string[] = [];
    if (d.goal) out.push(`目标：${d.goal}`);
    if (d.places.length) out.push(`地点：${d.places.slice(0, limit).map((p) => `${p.name} ${at(p)}`).join('、')}${more(d.places.length)}`);
    if (d.bed) out.push(`床（复活点）：${at(d.bed)}`);
    if (d.portals?.length) out.push(`传送门：${d.portals.slice(0, limit).map((x) => `${dimensionName(x.a.dimension)} (${x.a.x}, ${x.a.y}, ${x.a.z}) ↔ ${dimensionName(x.b.dimension)} (${x.b.x}, ${x.b.y}, ${x.b.z})`).join('；')}`);
    if (d.buildings.length) {
      out.push(`盖过：${d.buildings.slice(0, limit).map((b) => `「${b.name}」在 ${at(b)}${b.done >= b.total ? '，盖完了' : `，盖了 ${b.done}/${b.total} 块`}`).join('；')}${more(d.buildings.length)}`);
    }
    if (d.fields.length) out.push(`种过：${d.fields.slice(0, limit).map((f) => `${f.crop} ${f.size}×${f.size} 在 ${at(f)}`).join('；')}${more(d.fields.length)}`);
    if (d.designs.length) out.push(`存着的图纸：${d.designs.map((x) => x.name).join('、')}（可以直接 build）`);
    if (d.deaths.length) out.push(`死过 ${Math.max(d.deathCount, d.deaths.length)} 次，最近一次在 ${at(d.deaths[0])}，${when(d.deaths[0].at)}`);
    return out;
  }
}
