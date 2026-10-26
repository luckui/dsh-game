/**
 * 挖掉的方块以服务器为准。
 *
 * mineflayer 挖完先在自己这边把方块记成空气（它的 dig 也是看到这一格变成空气才算挖完），然后等服务器。
 * 1.19 起，服务器驳回挖掘（够不着、冒险模式不让挖……）多半不发包把方块改回来：它只回「已处理到第几号」的回执，
 * 原版客户端自己记着「这一格是我预测的」，收到回执还没等到服务器的方块更新，就改回服务器认的样子。
 * mineflayer 没有这一套：发包不填序号（都算 0，回执对不上是哪一次），驳回以后它那份世界一直是错的
 * （测试：冒险模式下 collect 说「挖了 10 块」、dig 说「那一格已经是空气」，服务器那边泥土都还在）。
 *
 * 这里补上：给每个挖掘包填递增的序号（从 100 万起，避开 mineflayer 用物品时自己数的那套小序号）；
 * 「挖完」那个包发出去时记下这一格原来是什么；之后服务器发来这一格的更新就算服务器确认了；
 * 收到这个序号的回执、再等一会儿还没有服务器的更新，就是服务器没认，把这一格改回原来的方块
 */

import { Vec3 } from 'vec3';

/** 收到回执以后再等这么久看有没有服务器的方块更新（同一刻里服务器先处理挖掘、刻末才把方块变化发出去） */
const SETTLE_MS = 150;

interface Prediction {
  seq: number;
  oldState: number;
  confirmed: boolean;
}

export function trackDigAcks(bot: any): void {
  const client = bot._client;
  if (!client || client.__digAcks) return;
  let seq = 1_000_000;
  let acked = -1;
  const predictions = new Map<string, Prediction>();
  const waiters = new Set<{ seq: number; done: () => void }>();
  const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
  let ownUpdate = false;

  const write = client.write.bind(client);
  client.write = (name: string, params: any) => {
    if (name === 'block_dig' && params) {
      seq += 1;
      params = { ...params, sequence: seq };
      client.__lastDigSeq = seq;
      // 「挖完」：mineflayer 紧接着就会把这一格记成空气，先记下原来是什么
      if (params.status === 2 && params.location) {
        const old = bot.blockAt?.(params.location);
        if (old) {
          predictions.set(key(params.location), { seq, oldState: old.stateId, confirmed: false });
          // mineflayer 紧接着自己把这一格改成空气（同步的）：这一下不算服务器确认
          ownUpdate = true;
          queueMicrotask(() => { ownUpdate = false; });
        }
      }
    }
    return write(name, params);
  };

  // 服务器发来的方块更新：这一格有预测的，就算服务器确认了（不管是改成空气还是别的）
  bot.on?.('blockUpdate', (_old: any, block: any) => {
    if (ownUpdate || !block?.position) return;
    const p = predictions.get(key(block.position));
    if (p) p.confirmed = true;
  });

  client.on('acknowledge_player_digging', (packet: any) => {
    acked = Math.max(acked, Number(packet?.sequenceId ?? -1));
    setTimeout(() => {
      for (const [k, p] of predictions) {
        if (p.seq > acked) continue;
        predictions.delete(k);
        if (p.confirmed) continue;
        // 服务器没认这次挖掘：改回原来的方块
        const [x, y, z] = k.split(',').map(Number);
        bot._updateBlockState?.(new Vec3(x, y, z), p.oldState);
      }
      for (const w of waiters) if (w.seq <= acked) { waiters.delete(w); w.done(); }
    }, SETTLE_MS);
  });

  client.__digAcks = {
    /** 等服务器处理完到 target 号为止（含回滚）：true = 等到了，false = 超时 */
    wait(target: number, ms: number): Promise<boolean> {
      if (acked >= target && ![...predictions.values()].some((p) => p.seq <= target)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { seq: target, done: () => { clearTimeout(timer); resolve(true); } };
        const timer = setTimeout(() => { waiters.delete(w); resolve(false); }, ms);
        waiters.add(w);
      });
    },
  };
}

/**
 * 这一格挖掉了没有，以服务器为准：等最后一个挖掘包处理完（最多 2 秒），再看方块还在不在。
 * 挖掉了返回 null；没挖掉返回原因（离得远就是根本没够着，近的就是挖了但服务器没认）
 */
export async function confirmDug(bot: any, block: any): Promise<string | null> {
  const acks = bot._client?.__digAcks;
  const last = bot._client?.__lastDigSeq;
  if (acks && last) await acks.wait(last, 2000);
  const still = bot.blockAt(block.position);
  if (!still || still.type !== block.type) return null;
  const away = bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5));
  return away > 6 ? `never got within reach (still ${away.toFixed(0)} blocks away)` : 'dug at it but the server did not accept it (the block is still there)';
}
