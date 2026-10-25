/**
 * 创造模式里飞过去（go 的身体部分）：能直飞就直飞；不行就先升到起点、终点里高的那个再往上一点，平着飞过去，再落下来；
 * 路上有方块挡着就再升高一截重试。mineflayer 的 creative.flyTo 是一步步直接改位置、不管路上有没有方块，所以每一段先查一遍。
 * 到了就落下（创造模式摔不疼）：下面是房顶就站在房顶上。
 */
import { Vec3 } from 'vec3';

const solidAt = (bot: any, p: Vec3) => bot.blockAt(p.floored())?.boundingBox === 'block';

/** 她的身体：0.6 宽、1.8 高。查路线时四个角和中间、脚和头都要看 */
const BODY: [number, number, number][] = [];
for (const dx of [-0.35, 0, 0.35]) for (const dz of [-0.35, 0, 0.35]) for (const dy of [0.05, 0.9, 1.75]) BODY.push([dx, dy, dz]);

/** 这一段路上（整个身体扫过的地方）有没有方块 */
function clear(bot: any, from: Vec3, to: Vec3): boolean {
  const d = to.minus(from);
  const steps = Math.max(1, Math.ceil(Math.hypot(d.x, d.y, d.z) / 0.3));
  for (let i = 0; i <= steps; i++) {
    const p = from.plus(d.scaled(i / steps));
    if (BODY.some(([dx, dy, dz]) => solidAt(bot, p.offset(dx, dy, dz)))) return false;
  }
  return true;
}

async function flyLeg(bot: any, to: Vec3, signal?: AbortSignal): Promise<void> {
  // 一次飞一小段（flyTo 中途停不下来）；被服务器拉回去、一直没进展就不飞了
  const deadline = Date.now() + (bot.entity.position.distanceTo(to) / 5 + 5) * 1000;
  while (bot.entity.position.distanceTo(to) > 0.5) {
    if (signal?.aborted) throw new Error('cancelled');
    if (Date.now() > deadline) throw new Error(`got pushed back while flying (stuck near ${bot.entity.position.floored()})`);
    const here: Vec3 = bot.entity.position.clone();
    const d = to.minus(here);
    const len = Math.hypot(d.x, d.y, d.z);
    const next = len > 12 ? here.plus(d.scaled(12 / len)) : to;
    await Promise.race([bot.creative.flyTo(next), new Promise((r) => setTimeout(r, 4000))]);
  }
}

export async function flyTo(bot: any, target: { x: number; y: number; z: number }, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  if (bot.game?.gameMode !== 'creative' || !bot.creative?.flyTo) return { ok: false, message: 'can only fly in creative mode' };
  const start: Vec3 = bot.entity.position.clone();
  const end = new Vec3(Math.floor(target.x) + 0.5, Math.floor(target.y), Math.floor(target.z) + 0.5);
  if (BODY.some(([dx, dy, dz]) => solidAt(bot, end.offset(dx, dy, dz)))) return { ok: false, message: `${end.floored()} is inside a block; pick a spot with two empty cells` };
  let legs: Vec3[] | null = clear(bot, start, end) ? [end] : null;
  for (let rise = 3; !legs && rise <= 120; rise += 6) {
    const y = Math.min(318, Math.max(start.y, end.y) + rise);
    const up = new Vec3(start.x, y, start.z);
    const over = new Vec3(end.x, y, end.z);
    if (clear(bot, start, up) && clear(bot, up, over) && clear(bot, over, end)) legs = [up, over, end];
  }
  if (!legs) return { ok: false, message: 'no clear way to fly there (blocked above or along the way)' };
  try {
    for (const leg of legs) await flyLeg(bot, leg, signal);
  } finally {
    bot.creative.stopFlying();
  }
  return { ok: true, message: `flew to ${end.floored()}` };
}

/** 头顶是开阔天空（往上 rise 格都没方块）、脚下站得住的地方：飞不出去时先走到这里再起飞。近的在前 */
export function openSkySpots(bot: any, rise = 24, radius = 24): Vec3[] {
  const me: Vec3 = bot.entity.position.floored();
  const out: { p: Vec3; d: number }[] = [];
  for (let dx = -radius; dx <= radius; dx += 2) for (let dz = -radius; dz <= radius; dz += 2) for (let dy = -3; dy <= 3; dy++) {
    const p = me.offset(dx, dy, dz);
    if (!solidAt(bot, p.offset(0, -1, 0)) || solidAt(bot, p) || solidAt(bot, p.offset(0, 1, 0))) continue;
    let open = true;
    for (let up = 2; up <= rise && open; up++) if (solidAt(bot, p.offset(0, up, 0))) open = false;
    if (open) out.push({ p, d: Math.hypot(dx, dy, dz) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 5).map((o) => o.p);
}
