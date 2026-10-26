import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { flyTo } from './flight.js';

const SPRINT_SPEED = 5.6;
const JUMP_TIME = 0.6;
const PARKOUR_TIME = 1.0;
const PLACE_TIME = 0.5;
const GRACE_FACTOR = 2.0;
const BASE_GRACE_S = 10;
// This is only a dead-man fallback. Stagnation is the normal blocked-path
// signal, and real movement refreshes this timer indefinitely.
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const PROGRESS_INTERVAL_MS = 5_000;
const STAGNATION_THRESHOLD = 1.5;
const MAX_STAGNANT_TICKS = 3;
const DISTANCE_IMPROVEMENT_THRESHOLD = 0.75;

export interface PathfindResult {
  ok: boolean;
  reason: 'success' | 'timeout' | 'stagnation' | 'noPath' | 'error' | 'interrupted';
  message: string;
  startPos: { x: number; y: number; z: number };
  endPos: { x: number; y: number; z: number };
  distanceTraveled: number;
  distanceToTarget: number;
  elapsedMs: number;
  estimatedTimeMs: number;
  pathCost: number;
  environment: {
    inWater: boolean;
    oxygen?: number;
    nearbyLiquids: string[];
  };
}

export interface PathfindProgressInfo {
  elapsedMs: number;
  estimatedTimeMs: number;
  distanceTraveled: number;
  distanceToTarget: number;
  currentPos: { x: number; y: number; z: number };
  stagnantTicks: number;
  pathCost: number;
}

interface MoveNode {
  x: number;
  y: number;
  z: number;
  cost: number;
  toBreak: unknown[];
  toPlace: unknown[];
  parkour?: boolean;
}

interface PathUpdateResult {
  status: string;
  cost: number;
  path: MoveNode[];
}

export interface PathfindProgressSnapshot {
  movedSinceLastTick: number;
  previousDistanceToTarget: number;
  distanceToTarget: number;
  isMining: boolean;
  isBuilding: boolean;
}

export function hasMeaningfulPathfindingProgress(snapshot: PathfindProgressSnapshot): boolean {
  const distanceImprovement = snapshot.previousDistanceToTarget - snapshot.distanceToTarget;
  return snapshot.movedSinceLastTick >= STAGNATION_THRESHOLD
    || distanceImprovement >= DISTANCE_IMPROVEMENT_THRESHOLD;
}

export function estimatePathTimeMs(path: MoveNode[]): number {
  let totalTimeS = 0;
  for (const node of path) {
    totalTimeS += node.toBreak.length * 1.5;
    totalTimeS += node.toPlace.length * PLACE_TIME;
    if (node.parkour) totalTimeS += PARKOUR_TIME;
    else if (node.cost >= 2 && node.toBreak.length === 0 && node.toPlace.length === 0) {
      totalTimeS += JUMP_TIME;
    } else {
      totalTimeS += (node.cost >= 1.4 ? Math.SQRT2 : 1) / SPRINT_SPEED;
    }
  }
  return totalTimeS * 1000;
}

export function computeTimeoutFromEta(estimatedMs: number): number {
  return Math.max(
    MIN_TIMEOUT_MS,
    Math.min(MAX_TIMEOUT_MS, estimatedMs * GRACE_FACTOR + BASE_GRACE_S * 1000),
  );
}

function coordinate(value: any): { x: number; y: number; z: number } {
  return {
    x: Math.round(Number(value.x) * 10) / 10,
    y: Math.round(Number(value.y) * 10) / 10,
    z: Math.round(Number(value.z) * 10) / 10,
  };
}

/**
 * 走过去；创造模式下走不到（隔着海、在半空、在房顶上）就飞过去：目标是一个具体的格子时，飞到它上面那格。
 * 种地、挖坑、用桶、放方块……要走到某处的动作都走这里
 */
export async function patchedGoto(
  bot: Bot | any,
  goal: any,
  options: {
    onProgress?: (info: PathfindProgressInfo) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PathfindResult> {
  const walked = await walkGoto(bot, goal, options);
  if (walked.ok || options.signal?.aborted || bot.game?.gameMode !== 'creative' || ![goal?.x, goal?.y, goal?.z].every(Number.isFinite)) return walked;
  const started = Date.now();
  const flown = await flyTo(bot, { x: goal.x, y: goal.y + 1, z: goal.z }, options.signal).catch((err: Error) => ({ ok: false, message: err.message }));
  if (!flown.ok) return walked;
  const here = bot.entity.position;
  return {
    ...walked,
    ok: true,
    reason: 'success',
    message: flown.message,
    endPos: { x: here.x, y: here.y, z: here.z },
    distanceToTarget: Math.hypot(here.x - goal.x, here.y - goal.y, here.z - goal.z),
    elapsedMs: walked.elapsedMs + Date.now() - started,
  };
}

function walkGoto(
  bot: Bot | any,
  goal: any,
  options: {
    onProgress?: (info: PathfindProgressInfo) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PathfindResult> {
  return new Promise((resolve) => {
    const startPos = bot.entity.position.clone();
    const startTime = Date.now();
    let lastProgressPos = startPos.clone();
    let stagnantTicks = 0;
    let currentEstimatedMs = 0;
    let currentTimeoutMs = MIN_TIMEOUT_MS;
    let currentPathCost = 0;
    let lastDistanceToTarget = getDistanceToTarget();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    function getDistanceToTarget(): number {
      try {
        return typeof goal?.heuristic === 'function'
          ? goal.heuristic(bot.entity.position.floored())
          : 0;
      } catch {
        return 0;
      }
    }

    function buildResult(
      ok: boolean,
      reason: PathfindResult['reason'],
      message: string,
    ): PathfindResult {
      const endPos = bot.entity.position.clone();
      return {
        ok,
        reason,
        message,
        startPos: coordinate(startPos),
        endPos: coordinate(endPos),
        distanceTraveled: startPos.distanceTo(endPos),
        distanceToTarget: getDistanceToTarget(),
        elapsedMs: Date.now() - startTime,
        estimatedTimeMs: currentEstimatedMs,
        pathCost: currentPathCost,
        environment: observeEnvironment(bot),
      };
    }

    function cleanup(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      bot.removeListener('goal_reached', onGoalReached);
      bot.removeListener('path_update', onPathUpdate);
      bot.removeListener('goal_updated', onGoalUpdated);
      bot.removeListener('path_stop', onPathStop);
      options.signal?.removeEventListener('abort', onAbort);
    }

    function settle(result: PathfindResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      setTimeout(resolve, 0, result);
    }

    function resetTimeout(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        settle(buildResult(false, 'timeout', `Navigation timed out after ${Math.round((Date.now() - startTime) / 1000)}s`));
        try { bot.pathfinder.setGoal(null); } catch {}
      }, currentTimeoutMs);
    }

    function onGoalReached(): void {
      settle(buildResult(true, 'success', 'Reached the goal'));
    }

    function onPathUpdate(results: PathUpdateResult): void {
      if (results.path?.length > 0) {
        currentEstimatedMs = estimatePathTimeMs(results.path);
        currentTimeoutMs = computeTimeoutFromEta(currentEstimatedMs);
        currentPathCost = results.cost;
        resetTimeout();
      }
      if (results.path?.length === 0 && (results.status === 'noPath' || results.status === 'timeout')) {
        settle(buildResult(false, 'noPath', 'Pathfinding could not find a path'));
      }
    }

    function onGoalUpdated(nextGoal: any): void {
      if (nextGoal !== goal) settle(buildResult(false, 'interrupted', 'Goal was changed externally'));
    }

    function onPathStop(): void {
      // 我们自己取消的走 onAbort；这里是寻路器自己放弃（补丁：连续卡住重置三次、一步没挪就停）：是卡住了，不是被打断
      if (options.signal?.aborted) return settle(buildResult(false, 'interrupted', 'Navigation was cancelled'));
      settle(buildResult(false, 'stagnation', 'The pathfinder kept getting stuck on the way and gave up'));
    }

    function onAbort(): void {
      settle(buildResult(false, 'interrupted', 'Navigation was cancelled'));
      try { bot.pathfinder.setGoal(null); } catch {}
    }

    function checkProgress(): void {
      if (settled) return;
      const currentPos = bot.entity.position.clone();
      const movedSinceLastTick = currentPos.distanceTo(lastProgressPos);
      const distanceToTarget = getDistanceToTarget();
      const madeProgress = hasMeaningfulPathfindingProgress({
        movedSinceLastTick,
        previousDistanceToTarget: lastDistanceToTarget,
        distanceToTarget,
        isMining: bot.pathfinder.isMining() || bot.targetDigBlock != null,
        isBuilding: bot.pathfinder.isBuilding(),
      });
      stagnantTicks = madeProgress ? 0 : stagnantTicks + 1;
      if (madeProgress) resetTimeout();
      lastProgressPos = currentPos;
      lastDistanceToTarget = distanceToTarget;
      options.onProgress?.({
        elapsedMs: Date.now() - startTime,
        estimatedTimeMs: currentEstimatedMs,
        distanceTraveled: startPos.distanceTo(currentPos),
        distanceToTarget,
        currentPos: coordinate(currentPos),
        stagnantTicks,
        pathCost: currentPathCost,
      });
      if (stagnantTicks >= MAX_STAGNANT_TICKS) {
        settle(buildResult(false, 'stagnation', 'Bot stagnated for 15s without meaningful movement'));
        try { bot.pathfinder.setGoal(null); } catch {}
      }
    }

    bot.on('goal_reached', onGoalReached);
    bot.on('path_update', onPathUpdate);
    bot.on('goal_updated', onGoalUpdated);
    bot.on('path_stop', onPathStop);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    progressTimer = setInterval(checkProgress, PROGRESS_INTERVAL_MS);
    resetTimeout();
    try {
      bot.pathfinder.setGoal(goal);
    } catch (error) {
      settle(buildResult(false, 'error', `Failed to set pathfinding goal: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

function observeEnvironment(bot: any): PathfindResult['environment'] {
  const position = bot.entity?.position;
  if (!position) return { inWater: false, nearbyLiquids: [] };
  const center = typeof position.floored === 'function'
    ? position.floored()
    : new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const offsets = [
    [0, 0, 0], [0, 1, 0], [0, -1, 0],
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
  ];
  const liquids = new Set<string>();
  let inWater = false;
  for (const [x, y, z] of offsets) {
    const block = bot.blockAt?.(center.offset(x, y, z));
    const name = String(block?.name ?? '');
    if (!name.includes('water') && !name.includes('lava')) continue;
    liquids.add(name);
    if (x === 0 && z === 0 && (y === 0 || y === 1)) inWater = name.includes('water');
  }
  const oxygen = Number(bot.oxygenLevel);
  return {
    inWater,
    ...(Number.isFinite(oxygen) ? { oxygen } : {}),
    nearbyLiquids: [...liquids],
  };
}
