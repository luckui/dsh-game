/**
 * 跟拍镜头的机位：她身后斜上方，朝向跟她的身体（走路的方向；站着不动时慢慢转向她看的方向），不跟她的头。
 * 原版 F5 跟着头转：她低头挖脚下、扭头看墙，镜头就往天花板、墙里甩，撞上了被拉到贴着后脑勺，整屏是头发。
 *
 *   - 理想机位：身后 4 格、高 20°，看向她身前一点
 *   - 身后被挡、能退的不到 1.8 格：在她周围换个方向（左右每 30° 一档加上八个正方向；高低四档，最高一档是头顶俯拍），
 *     挑够远、离理想方向近的；镜头永远离她 1.8 格以上
 *   - 哪个方向都不够 1.8 格（钻进一格宽的小坑）：连着 0.3 秒都这样才退回她的第一人称；
 *     有方向能退到 2.2 格、连着 0.8 秒都有才出来（距离和时间都分开，免得来回跳）
 *   - 走路：1.2 秒里挪了 0.9 格以上才算在走（干活时原地挪半步不算），朝向跟着走的方向转
 *   - 平滑：每步往目标挪 40%；目标一下子换到另一边（夹角超过 90°）或远了 6 格就直接切过去（慢慢转会穿过墙）；
 *     两次直接切至少隔 2 秒：这期间现在的机位还看得见她就先不动
 *
 * 世界只通过 solid（挡视线的方块）和 clutter（火把、花草：不挡视线，但镜头不能停在那一格里，不然一大块火把怼在镜头上）查，方便单独测。
 * 坐标是方块坐标；返回的朝向是原版 tp 用的 yaw / pitch（度）
 */
export interface FollowInput {
  now: number;
  /** 她的脚底 */
  pos: { x: number; y: number; z: number };
  /** 她看的方向（mineflayer 的 yaw，弧度：0 朝北，逆时针增加） */
  lookYaw: number;
  solid(x: number, y: number, z: number): boolean;
  clutter?(x: number, y: number, z: number): boolean;
}

export type FollowPose =
  | { first: true }
  | { first: false; x: number; y: number; z: number; yaw: number; pitch: number; cut: boolean };

const IDEAL = 4;
const MIN = 1.8;
const RESUME = 2.2;
const PITCH = 20;
/** 镜头离方块至少这么远（近了画面里会切进方块） */
const MARGIN = 0.35;
/** 镜头对准的点：脚底往上（肩膀和头之间） */
const ANCHOR = 1.45;
const OFFSETS = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
const PITCHES = [PITCH, 40, 5, 70];
const ENTER_FIRST_MS = 300;
const LEAVE_FIRST_MS = 800;
const CUT_GAP_MS = 2000;
const MOVE_WINDOW_MS = 1200;
const MOVE_DIST = 0.9;
const RAD = Math.PI / 180;

type V = { x: number; y: number; z: number };

export class FollowCam {
  /** 身体朝向（弧度，方向 = (cos, sin) 在 x、z 上） */
  private heading: number | null = null;
  private history: { t: number; x: number; z: number }[] = [];
  private stillSince = 0;
  private cam: V | null = null;
  private chosen: { angle: number; pitch: number } | null = null;
  private first = false;
  private lastCut = 0;
  private noRoomSince: number | null = null;
  private roomSince: number | null = null;

  /** 下一步当成重新开始（镜头被别的事占了一阵、她被传送） */
  reset(): void {
    this.cam = null;
    this.chosen = null;
    this.history = [];
    this.noRoomSince = null;
    this.roomSince = null;
  }

  step(input: FollowInput): FollowPose {
    const { pos, now } = input;
    const anchor = { x: pos.x, y: pos.y + ANCHOR, z: pos.z };
    this.updateHeading(input);
    const heading = this.heading!;

    const cache = new Map<string, boolean>();
    const solid = (x: number, y: number, z: number) => {
      const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
      let hit = cache.get(key);
      if (hit === undefined) cache.set(key, (hit = input.solid(Math.floor(x), Math.floor(y), Math.floor(z))));
      return hit;
    };
    const clutterCache = new Map<string, boolean>();
    const cluttered = (x: number, y: number, z: number) => {
      if (!input.clutter) return false;
      const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
      let hit = clutterCache.get(key);
      if (hit === undefined) clutterCache.set(key, (hit = input.clutter(Math.floor(x), Math.floor(y), Math.floor(z))));
      return hit;
    };
    const pose = (cam: V, cut: boolean): FollowPose => {
      // 看向她身前半格、肩膀高度
      const look = { x: anchor.x + Math.cos(heading) * 0.5, y: anchor.y - 0.1, z: anchor.z + Math.sin(heading) * 0.5 };
      const d = sub(look, cam);
      return { first: false, x: cam.x, y: cam.y, z: cam.z, yaw: Math.atan2(-d.x, d.z) / RAD, pitch: -Math.atan2(d.y, Math.hypot(d.x, d.z)) / RAD, cut };
    };
    // 现在的机位还能用：离她 1.6 ~ 6.5 格，中间没挡着
    const keepable = !!this.cam && sees(anchor, this.cam, solid);

    let best: { score: number; dir: V; dist: number; angle: number; pitch: number } | null = null;
    // 候选方向：理想方向左右每 30° 一档，再加上东南西北和四个斜角（矿道、走廊都是顺着这几个方向的，一格宽，偏一点就撞墙）
    const back = heading + Math.PI;
    const angles = [...OFFSETS.map((o) => back + o * RAD), ...Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4)];
    for (const pitch of PITCHES) {
      for (const angle of angles) {
        const offset = Math.abs(angleDiff(angle, back)) / RAD;
        const dir = { x: Math.cos(angle) * Math.cos(pitch * RAD), y: Math.sin(pitch * RAD), z: Math.sin(angle) * Math.cos(pitch * RAD) };
        let dist = Math.min(clearance(anchor, dir, IDEAL + MARGIN, solid) - MARGIN, IDEAL);
        while (dist >= MIN && cluttered(anchor.x + dir.x * dist, anchor.y + dir.y * dist, anchor.z + dir.z * dist)) dist -= 0.25;
        if (offset === 0 && pitch === PITCH && dist >= IDEAL - 0.05) {
          best = { score: Infinity, dir, dist, angle, pitch };
          break;
        }
        if (dist < MIN) continue;
        const sticky = this.chosen && Math.abs(angleDiff(angle, this.chosen.angle)) < 35 * RAD && this.chosen.pitch === pitch ? 0.2 : 0;
        const score = dist / IDEAL - (offset / 180) * 0.6 - (pitch === PITCH ? 0 : pitch === 70 ? 0.25 : 0.08) + sticky;
        if (!best || score > best.score) best = { score, dir, dist, angle, pitch };
      }
      if (best?.score === Infinity) break;
    }

    if (!best) {
      this.roomSince = null;
      this.noRoomSince ??= now;
      if (this.first) return { first: true };
      if (keepable && now - this.noRoomSince < ENTER_FIRST_MS) return pose(this.cam!, false);
      this.first = true;
      this.cam = null;
      this.chosen = null;
      return { first: true };
    }
    this.noRoomSince = null;
    if (this.first) {
      if (best.dist < RESUME) {
        this.roomSince = null;
        return { first: true };
      }
      this.roomSince ??= now;
      if (now - this.roomSince < LEAVE_FIRST_MS) return { first: true };
    }
    const wasFirst = this.first;
    this.first = false;
    const goal = { x: anchor.x + best.dir.x * best.dist, y: anchor.y + best.dir.y * best.dist, z: anchor.z + best.dir.z * best.dist };

    let cut = wasFirst || !this.cam;
    if (!cut && this.cam) {
      const far = dist3(goal, this.cam) > 6;
      const turned = angleBetween(sub(this.cam, anchor), sub(goal, anchor)) > 90 * RAD;
      if (far || turned) {
        if (keepable && now - this.lastCut < CUT_GAP_MS) return pose(this.cam, false);
        cut = true;
      }
    }
    this.chosen = { angle: best.angle, pitch: best.pitch };
    if (cut || !this.cam) {
      this.cam = goal;
      this.lastCut = now;
    } else {
      const next = { x: this.cam.x + (goal.x - this.cam.x) * 0.4, y: this.cam.y + (goal.y - this.cam.y) * 0.4, z: this.cam.z + (goal.z - this.cam.z) * 0.4 };
      // 挪到半路被方块挡住（她身后突然多了墙）：直接到目标
      this.cam = sees(anchor, next, solid) && !cluttered(next.x, next.y, next.z) ? next : goal;
    }
    return pose(this.cam, cut);
  }

  /** 走着（1.2 秒里挪了 0.9 格以上）：朝走的方向；站着超过 1.5 秒：慢慢转向她看的方向 */
  private updateHeading({ now, pos, lookYaw }: FollowInput): void {
    const look = Math.atan2(-Math.cos(lookYaw), -Math.sin(lookYaw));
    if (this.heading === null) this.heading = look;
    this.history.push({ t: now, x: pos.x, z: pos.z });
    while (this.history.length > 2 && now - this.history[0].t > MOVE_WINDOW_MS) this.history.shift();
    const old = this.history[0];
    const dx = pos.x - old.x;
    const dz = pos.z - old.z;
    let want: number | null = null;
    let rate: number;
    if (Math.hypot(dx, dz) > MOVE_DIST) {
      want = Math.atan2(dz, dx);
      rate = 0.25;
      this.stillSince = now;
    } else {
      if (!this.stillSince) this.stillSince = now;
      if (now - this.stillSince > 1500) want = look;
      rate = 0.04;
    }
    if (want !== null) this.heading += angleDiff(want, this.heading) * rate;
  }
}

/** 从 anchor 看得到 cam：离 1.6 ~ 6.5 格，中间没有方块 */
function sees(anchor: V, cam: V, solid: (x: number, y: number, z: number) => boolean): boolean {
  const to = sub(cam, anchor);
  const len = Math.hypot(to.x, to.y, to.z);
  if (len < MIN - 0.2 || len > IDEAL + 2.5) return false;
  return clearance(anchor, scale(to, 1 / len), len + MARGIN, solid) - MARGIN >= len - 0.05;
}

/** 从 from 沿 dir（单位向量）走多远碰到方块（最多 max）：中间一条加上下左右偏 0.2 的四条，取最近的 */
function clearance(from: V, dir: V, max: number, solid: (x: number, y: number, z: number) => boolean): number {
  const side = Math.hypot(dir.x, dir.z) > 0.01 ? { x: -dir.z / Math.hypot(dir.x, dir.z), y: 0, z: dir.x / Math.hypot(dir.x, dir.z) } : { x: 1, y: 0, z: 0 };
  const up = cross(side, dir);
  let best = max;
  for (const [a, b] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
    const o = { x: from.x + side.x * a + up.x * b, y: from.y + side.y * a + up.y * b, z: from.z + side.z * a + up.z * b };
    for (let t = 0; t < best; t += 0.1) {
      if (solid(o.x + dir.x * t, o.y + dir.y * t, o.z + dir.z * t)) {
        best = t;
        break;
      }
    }
  }
  return best;
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function sub(a: V, b: V): V {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(a: V, s: number): V {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function cross(a: V, b: V): V {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dist3(a: V, b: V): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function angleBetween(a: V, b: V): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la < 1e-6 || lb < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
}
