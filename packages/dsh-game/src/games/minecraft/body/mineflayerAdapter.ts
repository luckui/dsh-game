import { createBot, latestSupportedVersion, type Bot } from 'mineflayer';
import { loader as autoEatPlugin } from 'mineflayer-auto-eat';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { goals, pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import {
  planCraft,
  recipesSourceFor,
  smeltInputFor,
  smeltOutputFor,
  SMELT_FUEL_ITEM,
  SMELT_ITEMS_PER_FUEL,
  type CraftPlan,
  type CraftPlanStep,
} from './craftPlanner.js';
import { gatherWood } from './gatherWood.js';
import { fleeFromHostiles, hideUnderground, sleepInBed, swimToShore } from './survival.js';
import { buildStructure } from './build.js';
import { breedAnimals, farmPlot, harvestCrops, shearSheep } from './farming.js';
import { digAt as digOne, useBucket, useOnBlock } from './useItems.js';
import { flyTo, openSkySpots } from './flight.js';
import { scanTerrain } from './terrain.js';
import { FollowCam } from './followCam.js';
import { trackDigAcks, confirmDug } from './digAck.js';
import { placeBlockAt as airiPlaceBlockAt, breakBlockAt, isInteractive, isReplaceableForPlacement, type PlaceFace } from './placeBlock.js';
import { Vec3 } from 'vec3';
import { runAdaptiveCollection } from './collectionStrategy.js';
import type {
  CollectionRequest,
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftEntitySnapshot,
  MinecraftPolicyHandlers,
  MinecraftSafetyRecovery,
} from './actions/types.js';
import type {
  MinecraftActionErrorCode,
  MinecraftActionResult,
  MinecraftObservedEntity,
  MinecraftRawObservation,
  MinecraftRuntimeEvent,
  MinecraftStatus,
} from './protocol.js';
import { buildMinecraftSnapshot } from './perception.js';
import { protectMovementsFromFalls, protectMovementsFromFluid } from './fluidSafety.js';
import { runAbortableOperation } from './abortableOperation.js';
import { patchedGoto, type PathfindResult } from './patchedGoto.js';
import { measurePlayerGaze, PlayerGazeTracker } from './playerGaze.js';
import { hasFollowRecoveryMovement } from './followRecovery.js';

const HOSTILE_MOBS = new Set([
  'blaze',
  'cave_spider',
  'creeper',
  'drowned',
  'elder_guardian',
  'enderman',
  'endermite',
  'evoker',
  'ghast',
  'guardian',
  'husk',
  'magma_cube',
  'phantom',
  'pillager',
  'ravager',
  'shulker',
  'silverfish',
  'skeleton',
  'slime',
  'spider',
  'stray',
  'vex',
  'vindicator',
  'witch',
  'wither',
  'wither_skeleton',
  'zombie',
  'zombie_villager',
]);

const LOG_BLOCK_NAMES = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'crimson_stem',
  'warped_stem',
  'log',
  'log2',
  'wood',
];

interface CraftExecutionError extends Error {
  craftCode: MinecraftActionErrorCode;
}

function createCraftError(code: MinecraftActionErrorCode, message: string): CraftExecutionError {
  const error = new Error(message) as CraftExecutionError;
  error.craftCode = code;
  return error;
}

function craftErrorCode(error: unknown): MinecraftActionErrorCode | undefined {
  return error instanceof Error && 'craftCode' in error
    ? (error as CraftExecutionError).craftCode
    : undefined;
}

const GENERIC_TREE_NAMES = new Set([
  'tree',
  'trees',
  'log',
  'logs',
  'wood',
  'woods',
  'trunk',
  'trunks',
  '树',
  '树木',
  '木头',
  '原木',
]);

const AIR_BLOCK_NAMES = new Set(['air', 'cave_air', 'void_air']);
// 可被放置替换的方块判定统一走 placeBlock.isReplaceableForPlacement（按碰撞盒判断）
const MAX_SCAN_BLOCK_POSITIONS = 1536;
const MAX_TARGET_ITEM_SWEEPS = 12;
const MAX_COLLECTION_SEARCH_RADIUS = 128;
const COMBAT_CHASE_RADIUS = 64;
const OXYGEN_EMERGENCY_LEVEL = 10;
const OXYGEN_RECOVERED_LEVEL = 18;
const SURFACE_ATTEMPT_MS = 3_000;
const LAST_AIR_ROUTE_TIMEOUT_MS = 5_000;
const FOLLOW_RECOVERY_RETRY_MS = 8_000;
const FOLLOW_WORLD_CHANGE_DEBOUNCE_MS = 300;
const FOLLOW_WORLD_CHANGE_RADIUS = 16;
const FOLLOW_USER_ASSISTANCE_DISTANCE = 8;
const GAZE_POLL_INTERVAL_MS = 200;
const GAZE_HOLD_MS = 4_000;
const GAZE_REARM_MS = 1_000;
const GAZE_MAX_DISTANCE = 8;
const KNOWN_BLOCK_DROPS: Record<string, string> = {
  tallgrass: 'wheat_seeds',
  grass: 'wheat_seeds',
  fern: 'wheat_seeds',
  double_plant: 'wheat_seeds',
  reeds: 'sugar_cane',
  sugar_cane: 'sugar_cane',
};

export interface MineflayerAdapterDependencies {
  createBot: typeof createBot | ((options: any) => any);
  plugins: Array<(bot: any) => void>;
  createFollowGoal(entity: any, range: number): any;
  gatherWood?: typeof gatherWood;
  confirmEntityDeath?: typeof confirmEntityDeath;
  collectDrops?: typeof collectNearbyDrops;
  approachTimeoutMs?: number;
}

const defaultDependencies: MineflayerAdapterDependencies = {
  createBot,
  plugins: [pathfinder, toolPlugin, collectBlockPlugin, autoEatPlugin, pvpPlugin],
  createFollowGoal: (entity, range) => new goals.GoalFollow(entity, range),
  gatherWood,
  confirmEntityDeath,
  collectDrops: collectNearbyDrops,
};

export function createMineflayerAdapter(
  emit: (event: MinecraftRuntimeEvent) => void,
  dependencies: MineflayerAdapterDependencies = defaultDependencies,
): MinecraftBotAdapter {
  let bot: Bot | any;
  let owner: string | undefined;
  let connection: MinecraftConnectionOptions | undefined;
  let policyHandlers: MinecraftPolicyHandlers = {
    onFoodState: () => undefined,
    onOxygenEmergency: () => undefined,
    onDeath: () => undefined,
    onFollowBlocked: () => undefined,
    shouldDefendAgainst: (entity) => entity.kind === 'hostile',
  };
  let lastHealth = 20;
  let intentionalDisconnect = false;
  let everSpawned = false;
  let knownCraftingTable: Vec3 | undefined;
  let lastBreathablePosition: { x: number; y: number; z: number } | undefined;
  let oxygenEmergencyActive = false;
  /** 跟拍镜头的机位（摄像机客户端挂在一个展示实体上，游戏层每 0.1 秒来问一次） */
  const followCam = new FollowCam();
  let followWatchdog: ReturnType<typeof setInterval> | undefined;
  let gazePoller: ReturnType<typeof setInterval> | undefined;
  const gazeTracker = new PlayerGazeTracker({
    holdMs: GAZE_HOLD_MS,
    rearmMs: GAZE_REARM_MS,
  });
  let followWatchdogGeneration = 0;
  let followSession: {
    bot: any;
    player: string;
    blocked: boolean;
    retryInProgress: boolean;
    blockedNotified: boolean;
    pathStuckResets: number;
    blockedPosition?: { x: number; y: number; z: number };
    retryTimer?: ReturnType<typeof setTimeout>;
    retryAt?: number;
  } | undefined;

  function clearFollowRetry(): void {
    if (followSession?.retryTimer) clearTimeout(followSession.retryTimer);
    if (followSession) {
      followSession.retryTimer = undefined;
      followSession.retryAt = undefined;
    }
  }

  function stopFollowSession(): void {
    clearFollowRetry();
    followSession = undefined;
    stopFollowWatchdog();
  }

  let creeperPoller: ReturnType<typeof setInterval> | undefined;
  let lastCreeperAlert = 0;
  function stopCreeperWatch(): void {
    if (creeperPoller) clearInterval(creeperPoller);
    creeperPoller = undefined;
  }
  /** 苦力怕反射：贴近 4.5 格就报给 worker（它停下手上的事、躲开） */
  function startCreeperWatch(current: any): void {
    stopCreeperWatch();
    creeperPoller = setInterval(() => {
      if (bot !== current || !current.entity || current.health <= 0) return;
      const me = current.entity.position;
      const creeper = current.nearestEntity?.((e: any) => e?.name === 'creeper' && e.position?.distanceTo(me) <= 4.5);
      if (!creeper || Date.now() - lastCreeperAlert < 4000) return;
      lastCreeperAlert = Date.now();
      Promise.resolve(policyHandlers.onCreeperClose?.({ distance: creeper.position.distanceTo(me), position: vector(creeper.position) }))
        .catch((error) => emit({ kind: 'log', level: 'error', message: `[survival] creeper handler failed: ${error instanceof Error ? error.message : String(error)}` }));
    }, 250);
  }

  function stopGazeTracking(): void {
    if (gazePoller) clearInterval(gazePoller);
    gazePoller = undefined;
    gazeTracker.reset();
  }

  function startGazeTracking(current: any): void {
    stopGazeTracking();
    gazePoller = setInterval(() => {
      if (bot !== current || !owner || !current.entity) {
        gazeTracker.update(null, Date.now());
        return;
      }
      const playerEntry = Object.entries(current.players ?? {}).find(
        ([name]) => name.toLocaleLowerCase() === owner!.toLocaleLowerCase(),
      )?.[1] as any;
      const playerEntity = playerEntry?.entity;
      const distance = playerEntity
        ? measurePlayerGaze(playerEntity, current.entity, current.world, GAZE_MAX_DISTANCE)
        : null;
      const trigger = gazeTracker.update(
        distance === null ? null : { player: playerEntry.username ?? owner, distance },
        Date.now(),
      );
      if (!trigger) return;
      emit({
        kind: 'log',
        level: 'info',
        message: `[gaze] triggered player=${trigger.player} duration=${trigger.durationMs}ms distance=${trigger.distance.toFixed(1)}`,
      });
      emit({ kind: 'player-gaze', ...trigger });
    }, GAZE_POLL_INTERVAL_MS);
    gazePoller.unref?.();
  }

  function scheduleFollowRetry(delayMs: number, reason: string): void {
    const session = followSession;
    if (!session?.blocked || bot !== session.bot) return;
    const retryAt = Date.now() + delayMs;
    if (session.retryTimer && session.retryAt !== undefined && session.retryAt <= retryAt) return;
    clearFollowRetry();
    session.retryTimer = setTimeout(() => retryBlockedFollow(session, reason), delayMs);
    session.retryAt = retryAt;
    session.retryTimer.unref?.();
    emit({
      kind: 'log',
      level: 'info',
      message: `[follow-recovery] waiting target=${session.player} reason=${reason} retryIn=${delayMs}ms`,
    });
  }

  function retryBlockedFollow(
    session: NonNullable<typeof followSession>,
    reason: string,
  ): void {
    if (followSession !== session || bot !== session.bot || !session.blocked) return;
    session.retryTimer = undefined;
    session.retryAt = undefined;
    const target = session.bot.players[session.player]?.entity;
    if (!target) {
      scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, 'target-not-visible');
      return;
    }
    const goal = dependencies.createFollowGoal(target, 2);
    emit({
      kind: 'log',
      level: 'info',
      message: `[follow-recovery] retry target=${session.player} reason=${reason} distance=${distanceToBot(session.bot, target.position).toFixed(1)}`,
    });
    session.blocked = false;
    session.retryInProgress = true;
    session.pathStuckResets = 0;
    session.bot.pathfinder.setGoal(goal, true);
    startFollowWatchdog(session.bot, session.player);
  }

  function markFollowBlocked(current: any, reason: string): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked || !current.entity?.position) return;
    const target = current.players[session.player]?.entity;
    if (!target) return;
    const position = vector(current.entity.position);
    const distance = distanceToBot(current, target.position);
    if (distance <= 2.5) {
      session.pathStuckResets = 0;
      return;
    }
    session.blocked = true;
    session.retryInProgress = false;
    session.blockedPosition = position;
    stopFollowWatchdog();
    clearPathfinderGoal(current);
    emit({
      kind: 'log',
      level: 'warn',
      message: `[follow-runtime] blocked target=${session.player} reason=${reason} distance=${distance.toFixed(1)} position=${formatPosition(position)}`,
    });
    const needsUserAssistance = distance > FOLLOW_USER_ASSISTANCE_DISTANCE;
    if (!needsUserAssistance) {
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] nearby path interruption kept internal target=${session.player} distance=${distance.toFixed(1)}`,
      });
    } else if (!session.blockedNotified) {
      session.blockedNotified = true;
      Promise.resolve(policyHandlers.onFollowBlocked?.({ player: session.player, position, distance })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[follow-runtime] blocked handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
    scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, reason);
  }

  function observeFollowPathReset(current: any, reason: string): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked) return;
    session.pathStuckResets = reason === 'stuck' ? session.pathStuckResets + 1 : 0;
  }

  function observeFollowPathStop(current: any): void {
    const session = followSession;
    if (!session || session.bot !== current || session.blocked) return;
    // mineflayer-pathfinder emits two stuck resets, then path_stop when its
    // third no-progress check gives up. Other path stops are interruptions.
    if (session.pathStuckResets >= 2) markFollowBlocked(current, 'pathfinder-stuck');
  }

  function observeFollowPathUpdate(current: any, result: any): void {
    if (!result?.status) return;
    const noUsablePath = !Array.isArray(result.path) || result.path.length === 0;
    if (noUsablePath && result.status === 'noPath') {
      markFollowBlocked(current, 'pathfinder-noPath');
    }
  }

  function recoverFollowAfterWorldChange(current: any, position: any): void {
    const session = followSession;
    if (!session?.blocked || session.retryInProgress || session.bot !== current || !position) return;
    const changed = vector(position);
    const nearBot = current.entity?.position
      ? distanceBetween(vector(current.entity.position), changed) <= FOLLOW_WORLD_CHANGE_RADIUS
      : false;
    const nearBlockedPosition = session.blockedPosition
      ? distanceBetween(session.blockedPosition, changed) <= FOLLOW_WORLD_CHANGE_RADIUS
      : false;
    if (!nearBot && !nearBlockedPosition) return;
    scheduleFollowRetry(FOLLOW_WORLD_CHANGE_DEBOUNCE_MS, 'nearby-block-update');
  }

  function recoverFollowAfterEntitySpawn(current: any, entity: any): void {
    const session = followSession;
    if (!session?.blocked || session.retryInProgress || session.bot !== current) return;
    if (String(entity?.username ?? '').toLocaleLowerCase() !== session.player.toLocaleLowerCase()) return;
    scheduleFollowRetry(FOLLOW_WORLD_CHANGE_DEBOUNCE_MS, 'owner-entity-spawned');
  }

  function stopFollowWatchdog(): void {
    followWatchdogGeneration += 1;
    if (followWatchdog) clearInterval(followWatchdog);
    followWatchdog = undefined;
  }

  function startFollowWatchdog(current: any, player: string): void {
    stopFollowWatchdog();
    const generation = followWatchdogGeneration;
    let previousPosition = vector(current.entity?.position);
    const initialTarget = current.players[player]?.entity;
    let previousDistance = initialTarget
      ? distanceToBot(current, initialTarget.position)
      : Number.POSITIVE_INFINITY;
    followWatchdog = setInterval(() => {
      if (bot !== current || generation !== followWatchdogGeneration) return;
      const target = current.players[player]?.entity;
      if (!target || !current.entity?.position) {
        return;
      }
      const position = vector(current.entity.position);
      const distance = distanceToBot(current, target.position);
      const moved = distanceBetween(previousPosition, position);
      const improved = previousDistance - distance;
      const madeProgress = hasFollowRecoveryMovement({
        previousBotPosition: previousPosition,
        currentBotPosition: position,
        minimumBotMovement: 1.5,
      });
      const session = followSession;
      const ownsSession = session !== undefined && session.bot === current && session.player === player;
      if (madeProgress && ownsSession) {
        session.pathStuckResets = 0;
      }
      if (ownsSession && (session.blocked || session.retryInProgress) && madeProgress) {
        const recovered = session;
        recovered.blocked = false;
        recovered.retryInProgress = false;
        recovered.blockedNotified = false;
        recovered.blockedPosition = undefined;
        clearFollowRetry();
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-recovery] resumed target=${player} distance=${distance.toFixed(1)}`,
        });
        Promise.resolve(policyHandlers.onFollowRecovered?.({ player, position, distance })).catch((error) => emit({
          kind: 'log',
          level: 'error',
          message: `[follow-recovery] recovered handler failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-watchdog] target=${player} position=${formatPosition(position)} distance=${distance.toFixed(1)} moved=${moved.toFixed(1)} improved=${improved.toFixed(1)} moving=${Boolean(current.pathfinder?.isMoving?.())} pathStuckResets=${followSession?.pathStuckResets ?? 0}`,
      });
      previousPosition = position;
      previousDistance = distance;
    }, 5_000);
    followWatchdog.unref?.();
  }

  async function connectOnce(options: MinecraftConnectionOptions, version?: string): Promise<void> {
    const current = dependencies.createBot({
      host: options.host,
      port: options.port,
      username: options.username,
      auth: 'offline',
      ...(version ? { version } : {}),
    });
    bot = current;
    current.once('login', () => fixPickaxeSpeeds(current.registry));
    trackDigAcks(current);
    // pvp 插件在 spawn 前才装好：装好以后接管它举盾的时机
    current.once('spawn', () => tunePvpShield(current));
    guardOwnOxygen(current);
    stopFollowSession();
    lastBreathablePosition = undefined;
    oxygenEmergencyActive = false;
    for (const plugin of dependencies.plugins) current.loadPlugin(plugin);
    if (current.pathfinder?.movements) {
      protectMovementsFromFalls(current, protectMovementsFromFluid(current, current.pathfinder.movements));
    }
    if (current.collectBlock?.movements) {
      protectMovementsFromFalls(current, protectMovementsFromFluid(current, current.collectBlock.movements));
    }
    if (current.pathfinder) {
      current.pathfinder.searchRadius = 64;
      current.pathfinder.thinkTimeout = Math.min(current.pathfinder.thinkTimeout ?? 5_000, 5_000);
      current.pathfinder.tickTimeout = Math.min(current.pathfinder.tickTimeout ?? 20, 20);
    }

    // ---- move-debug: 捕获 "Invalid move player packet received" 踢出前的移动现场 ----
    const sentMoves: Array<{ t: number; x: number; y: number; z: number; onGround: boolean; delta: number }> = [];
    const MAX_MOVE_HISTORY = 120;
    let moveDumpSent = false;
    const dumpMoveDebug = (reason: string): void => {
      if (moveDumpSent) return;
      moveDumpSent = true;
      const pos = current?.entity?.position;
      const latest = sentMoves[sentMoves.length - 1];
      const maxDelta = sentMoves.reduce((max, m) => Math.max(max, m.delta), 0);
      emit({
        kind: 'log',
        level: 'warn',
        message: `[move-debug] connection ${reason}; entity=${pos ? formatPosition(pos) : 'none'}; move packets=${sentMoves.length}; max single-packet delta=${maxDelta.toFixed(1)}; latest=${latest
          ? `(${latest.x.toFixed(1)}, ${latest.y.toFixed(1)}, ${latest.z.toFixed(1)}) onGround=${latest.onGround} delta=${latest.delta.toFixed(1)}`
          : 'none'}`,
      });
      for (const m of sentMoves.slice(-12)) {
        emit({
          kind: 'log',
          level: 'info',
          message: `[move-debug] sent ${new Date(m.t).toISOString().slice(11, 19)} (${m.x.toFixed(1)}, ${m.y.toFixed(1)}, ${m.z.toFixed(1)}) delta=${m.delta.toFixed(2)} onGround=${m.onGround}`,
        });
      }
    };
    if (current._client?.write) {
      const origWrite = current._client.write.bind(current._client);
      current._client.write = (name: string, params: any) => {
        if (name === 'position' || name === 'position_look') {
          const x = Number(params?.x);
          const y = Number(params?.y);
          const z = Number(params?.z);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            const last = sentMoves[sentMoves.length - 1];
            const delta = last ? Math.sqrt((x - last.x) ** 2 + (y - last.y) ** 2 + (z - last.z) ** 2) : 0;
            sentMoves.push({ t: Date.now(), x, y, z, onGround: Boolean(params?.onGround), delta });
            if (sentMoves.length > MAX_MOVE_HISTORY) sentMoves.shift();
            if (delta > 8) {
              emit({
                kind: 'log',
                level: 'warn',
                message: `[move-debug] large move packet delta=${delta.toFixed(1)} -> (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) onGround=${Boolean(params?.onGround)}`,
              });
            }
          }
        }
        if (name === 'window_click') {
          const window = current.currentWindow;
          if (window && String(window.type ?? '').includes('furnace')) {
            emit({
              kind: 'log',
              level: 'info',
              message: `[window-debug] click window=${params?.windowId} slot=${params?.slot} button=${params?.mouseButton} mode=${params?.mode} item=${JSON.stringify(params?.item)}`,
            });
          }
        }
        return origWrite(name, params);
      };
      current._client.on('transaction', (packet: any) => {
        const window = current.currentWindow;
        if (window && String(window.type ?? '').includes('furnace')) {
          emit({
            kind: 'log',
            level: packet?.accepted ? 'info' : 'warn',
            message: `[window-debug] transaction window=${packet?.windowId} action=${packet?.action} accepted=${packet?.accepted}`,
          });
        }
      });
    }

    // NaN 自愈：受击（击退 velocity）或坠落可能把客户端物理位置算成 NaN，
    // 服务器校验到非法坐标会直接踢人。physicsTick 在位置更新后、发送移动包前触发，
    // 发现 NaN 就回滚到最近有效位置并清零速度，避免 NaN 包发出去。
    let lastValidPosition: { x: number; y: number; z: number } | undefined;
    current.on('physicsTick', () => {
      const pos = current.entity?.position;
      if (!pos) return;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        const fallback = lastValidPosition ?? sentMoves[sentMoves.length - 1];
        if (fallback) {
          pos.set(fallback.x, fallback.y, fallback.z);
        }
        current.entity?.velocity?.set?.(0, 0, 0);
        emit({
          kind: 'log',
          level: 'warn',
          message: `[move-debug] NaN position detected; restored to ${
            fallback
              ? `${fallback.x.toFixed(1)}, ${fallback.y.toFixed(1)}, ${fallback.z.toFixed(1)}`
              : 'spawn'
          }`,
        });
      } else {
        lastValidPosition = { x: pos.x, y: pos.y, z: pos.z };
        if (isBreathingSafely(current)) lastBreathablePosition = vector(pos);
      }
    });

    current.on('chat', (username: string, message: string) => {
      if (username !== current.username) {
        emit({ kind: 'chat', player: username, message });
      }
    });
    current.on('playerJoined', () => notifyPlayers(current, emit, policyHandlers));
    current.on('playerLeft', () => notifyPlayers(current, emit, policyHandlers));
    current.on('entitySpawn', (entity: any) => recoverFollowAfterEntitySpawn(current, entity));
    current.on('blockUpdate', (oldBlock: any, newBlock: any) => {
      if (!oldBlock || !newBlock) return;
      recoverFollowAfterWorldChange(current, newBlock.position ?? oldBlock.position);
    });
    let lastFollowPathLogAt = 0;
    let lastFollowPathSignature = '';
    current.on('goal_reached', (goal: any) => {
      emit({
        kind: 'log',
        level: 'info',
        message: `[pathfinder] goal_reached goal=${goal?.constructor?.name ?? 'unknown'} position=${formatPosition(current?.entity?.position)}`,
      });
    });
    current.on('goal_updated', (goal: any, dynamic: boolean) => {
      emit({
        kind: 'log',
        level: 'info',
        message: `[pathfinder] goal_updated goal=${goal?.constructor?.name ?? 'none'} dynamic=${Boolean(dynamic)}`,
      });
    });
    current.on('path_reset', (reason: string) => {
      observeFollowPathReset(current, reason);
      const controlState = current?.controlState ?? {};
      emit({
        kind: 'log',
        level: 'warn',
        message: `[pathfinder] path_reset reason=${reason || 'unknown'} position=${formatPrecisePosition(current?.entity?.position)} controls=forward:${Boolean(controlState.forward)},jump:${Boolean(controlState.jump)},sprint:${Boolean(controlState.sprint)} moving=${Boolean(current?.pathfinder?.isMoving?.())}`,
      });
    });
    current.on('path_stop', () => {
      observeFollowPathStop(current);
      emit({ kind: 'log', level: 'info', message: '[pathfinder] path_stop' });
    });
    current.on('path_update', (result: any) => {
      observeFollowPathUpdate(current, result);
      if (!result?.status) return;
      const session = followSession;
      if (session?.bot === current && Array.isArray(result.path) && result.path.length > 0) {
        const first = result.path[0];
        const signature = `${result.status}:${result.path.length}:${formatPrecisePosition(first)}:${first?.toBreak?.length ?? 0}:${first?.toPlace?.length ?? 0}`;
        const now = Date.now();
        if (result.status !== 'success'
          || (signature !== lastFollowPathSignature && now - lastFollowPathLogAt >= 1_000)
          || now - lastFollowPathLogAt >= 5_000) {
          lastFollowPathSignature = signature;
          lastFollowPathLogAt = now;
          emit({
            kind: 'log',
            level: result.status === 'success' ? 'info' : 'warn',
            message: `[pathfinder] follow_path status=${result.status} length=${result.path.length} first=${formatPrecisePosition(first)} delta=${formatPositionDelta(current?.entity?.position, first)} break=${first?.toBreak?.length ?? 0} place=${first?.toPlace?.length ?? 0}`,
          });
        }
      }
      if (result.status === 'success') return;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[pathfinder] path_update status=${result.status} visited=${result.visitedNodes ?? 'unknown'} cost=${result.cost ?? 'unknown'}`,
      });
    });
    current.on('health', () => {
      if (current.health !== lastHealth) {
        const pos = current?.entity?.position;
        emit({
          kind: 'log',
          level: current.health < lastHealth ? 'warn' : 'info',
          message: `[move-debug] health ${lastHealth} -> ${current.health} at ${pos ? formatPosition(pos) : 'unknown'}`,
        });
      }
      notifyFoodState(current, policyHandlers);
      if (current.health < lastHealth) defendFromNearbyHostile(current, policyHandlers, emit);
      lastHealth = current.health;
    });
    current.on('death', () => {
      const position = current.entity?.position ? vector(current.entity.position) : undefined;
      emit({
        kind: 'log',
        level: 'error',
        message: `[survival] died position=${position ? formatPosition(position) : 'unknown'}`,
      });
      Promise.resolve(policyHandlers.onDeath({ position })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[survival] death handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    });
    current.on('breath', () => {
      const oxygen = Number(current.oxygenLevel ?? 20);
      const position = current.entity?.position;
      if (oxygen >= OXYGEN_RECOVERED_LEVEL && isBreathingSafely(current)) {
        if (position) lastBreathablePosition = vector(position);
        if (oxygenEmergencyActive) {
          emit({
            kind: 'log',
            level: 'info',
            message: `[survival] oxygen recovered=${oxygen} position=${position ? formatPosition(position) : 'unknown'}`,
          });
        }
        oxygenEmergencyActive = false;
        return;
      }
      if (
        oxygen > OXYGEN_EMERGENCY_LEVEL
        || oxygenEmergencyActive
        || !position
      ) return;
      oxygenEmergencyActive = true;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[survival] oxygen emergency=${oxygen} position=${formatPosition(position)}`,
      });
      Promise.resolve(policyHandlers.onOxygenEmergency({
        oxygen,
        position: vector(position),
      })).catch((error) => emit({
        kind: 'log',
        level: 'error',
        message: `[survival] oxygen emergency handler failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
    });
    current.on('end', (reason: string) => {
      if (bot !== current) return;
      stopGazeTracking();
      stopCreeperWatch();
      emit({
        kind: 'log',
        level: intentionalDisconnect ? 'info' : 'warn',
        message: `Connection ended: ${reason || 'Minecraft connection ended'}`,
      });
      dumpMoveDebug(reason || 'end');
      if (!intentionalDisconnect && everSpawned) {
        emit({ kind: 'disconnected', reason: reason || 'Minecraft connection ended' });
      }
      intentionalDisconnect = false;
      bot = undefined;
    });
    current.on('kicked', (reason: unknown) => {
      dumpMoveDebug('kicked');
      emit({ kind: 'log', level: 'error', message: `Kicked: ${String(reason)}` });
    });
    current.on('error', (error: Error) => {
      if (bot !== current) return;
      emit({ kind: 'log', level: 'error', message: error.message });
    });

    await waitForSpawn(current);
    everSpawned = true;
    lastHealth = current.health;
    if (current.entity?.position) lastBreathablePosition = vector(current.entity.position);
    // 吃完不换回原来拿的东西：自动吃是吃完以后才去换回的（不等它换完），会撞上别的点格子的动作（合成）；干活前身体会自己换工具
    current.autoEat?.setOpts?.({ minHunger: 16, strictErrors: false, returnToLastItem: false });
    current.autoEat?.enableAuto?.();
    notifyFoodState(current, policyHandlers);
    notifyPlayers(current, emit, policyHandlers);
    startGazeTracking(current);
    startCreeperWatch(current);
  }

  async function collectBlocks(request: CollectionRequest): Promise<{
    total: number;
    byName: Record<string, number>;
    skipped?: number;
    missingTool?: number;
    /** 没采到的那几块：位置和原因（给她看） */
    failures?: string[];
    /** 挖到的那几块在哪（结束时看旁边还剩几块同样的） */
    mined?: Vec3[];
  }> {
    const current = requireBot(bot);
    const ids = new Map<string, number>();
    for (const name of request.blocks) {
      const block = current.registry.blocksByName?.[name];
      if (block?.id !== undefined) ids.set(name, block.id);
    }
    if (ids.size === 0) throw new Error(`Unknown Minecraft block: ${request.blocks.join(', ')}`);
    if (request.signal.aborted) throw abortError();

    const sugarCaneName = request.blocks.find((name) => name === 'sugar_cane' || name === 'reeds');
    if (sugarCaneName) {
      const collected = await collectSugarCane(current, request, ids.get(sugarCaneName)!);
      return { total: collected, byName: { [sugarCaneName]: collected } };
    }

    if (typeof current.collectBlock?.collect !== 'function') {
      throw new Error('collect_block plugin is not loaded; cannot collect blocks');
    }

    const idSet = new Set(ids.values());
    const nameById = new Map<number, string>();
    for (const [name, id] of ids) nameById.set(id, name);
    const positions: any[] = [];
    for (const blockId of idSet) {
      positions.push(...(current.findBlocks({
        matching: blockId,
        maxDistance: request.radius,
        count: Math.min(64, Math.max(16, request.quantity * 4)),
      }) ?? []));
    }
    // 近的先挖；比她头顶高出两格以上的往后排（要垫方块爬上去，直播里挑过头顶 9 格的一块站了一分多钟）
    const reachCost = (block: any) => {
      const above = block.position.y - current.entity.position.y - 2;
      return distanceToBot(current, block.position) + (above > 0 ? above * 4 : 0);
    };
    const blocks = positions
      .map((position: any) => current.blockAt(position))
      .filter((block: any) => block && idSet.has(block.type) && !request.exclude?.has(`${block.position.x},${block.position.y},${block.position.z}`))
      .sort((left: any, right: any) => reachCost(left) - reachCost(right))
      .slice(0, request.quantity);
    if (blocks.length === 0) return { total: 0, byName: {} };

    // 复用 mineflayer-collectblock 的 collect()：自带寻路、清障（打穿挡路的方块）
    // 与掉落拾取；逐块调用，单块不可达/无法收获时跳过，不拖垮整批。
    let total = 0;
    let skipped = 0;
    let missingTool = 0;
    const failures: string[] = [];
    const mined: Vec3[] = [];
    const byName: Record<string, number> = {};
    for (const candidate of blocks) {
      if (request.signal.aborted) throw abortError();
      if (!canHarvestWithInventory(current, candidate)) {
        missingTool += 1;
        emit({
          kind: 'log',
          level: 'warn',
          message: `[collect] skipped ${candidate.name} at ${candidate.position.x},${candidate.position.y},${candidate.position.z}: no harvestable tool in inventory (missing_tool)`,
        });
        continue;
      }
      const blockStart = Date.now();
      emit({
        kind: 'log',
        level: 'info',
        message: `[collect] mining ${candidate.name} at ${candidate.position.x},${candidate.position.y},${candidate.position.z}`,
      });
      try {
        await collectSingleBlock(current, candidate, request.signal);
        // 挖完以服务器为准：mineflayer 挖完先在自己这边把方块记成空气（它的 dig 也是看到这个才算挖完），
        // 服务器不认（够不着、不让挖）要过一会儿才发包改回来。等服务器对这次挖掘的回执，再看方块还在不在
        const verdict = await confirmDug(current, candidate);
        if (verdict) throw new Error(verdict);
        total += 1;
        mined.push(candidate.position.clone());
        const name = nameById.get(candidate.type) ?? candidate.name;
        byName[name] = (byName[name] ?? 0) + 1;
        emit({
          kind: 'log',
          level: 'info',
          message: `[collect] mined ${candidate.name} in ${Date.now() - blockStart}ms`,
        });
      } catch (error) {
        if (request.signal.aborted) throw abortError();
        skipped += 1;
        const where = `${candidate.position.x},${candidate.position.y},${candidate.position.z}`;
        request.exclude?.add(where);
        failures.push(`${candidate.name} at ${where.replace(/,/g, ' ')}: ${error instanceof Error ? error.message : String(error)}`);
        emit({
          kind: 'log',
          level: 'warn',
          message: `[collect] skipped ${candidate.name} after ${Date.now() - blockStart}ms: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { total, byName, skipped, missingTool, failures, mined };
  }

  /** 走到够得着的地方，换上合适的工具，挖掉这一格；盖房子时草、雪这类能直接放东西的不挖（skipReplaceable） */
  async function digAt(current: any, target: Vec3, signal?: AbortSignal, skipReplaceable = false): Promise<void> {
    if (current.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4) {
      const r = await patchedGoto(current, new goals.GoalNear(target.x, target.y, target.z, 3), { signal });
      if (!r.ok) throw new Error(r.message);
    }
    const b = current.blockAt(target);
    if (!b || b.name === 'air' || (skipReplaceable && isReplaceableForPlacement(b))) return;
    await current.tool?.equipForBlock?.(b, {}).catch?.(() => {});
    await current.dig(b, true);
  }

  function farmHelpers(current: any, signal: AbortSignal) {
    return {
      dig: (target: Vec3) => digAt(current, target, signal),
      pickup: async (radius: number) => { await collectItemDrops(radius, signal); },
      log: (text: string) => emit({ kind: 'log', level: 'warn', message: text }),
    };
  }

  async function collectItemDrops(
    radius: number,
    signal?: AbortSignal,
  ): Promise<{ found: number; picked: number; inventoryDelta: Record<string, number> }> {
    return walkPickupDrops(requireBot(bot), radius, signal);
  }

  async function runCollectItem(options: {
    actionId: string;
    block?: string;
    item?: string;
    radius: number;
    maxCount: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const requestedBlock = options.block ? normalizeMinecraftLookupName(options.block) : undefined;
    const requestedItem = options.item ? normalizeMinecraftLookupName(options.item) : undefined;
    const woodName = (requestedItem && (GENERIC_TREE_NAMES.has(requestedItem) || isLogLikeName(requestedItem)))
      ? requestedItem
      : (requestedBlock && (GENERIC_TREE_NAMES.has(requestedBlock) || isLogLikeName(requestedBlock)))
        ? requestedBlock
        : undefined;

    if (woodName) {
      const started = Date.now();
      const before = inventoryCounts(current);
      const result = await (dependencies.gatherWood ?? gatherWood)(
        current,
        options.maxCount,
        options.radius,
        options.signal,
        (progress) => emit({
          kind: 'log',
          level: progress.level ?? 'info',
          message: `[${options.actionId}] gather_wood ${progress.phase}: ${progress.message}`,
        }),
      );
      return {
        actionId: '',
        outcome: result.collected >= options.maxCount ? 'succeeded' : 'partial',
        summary: `collected ${result.collected} logs (requested at least ${options.maxCount})`,
        durationMs: Date.now() - started,
        // 背包里真实多了什么（顺手捡到的树苗、木棍、苹果也算），砍了哪些方块在 worldChanges 里
        inventoryDelta: inventoryDifference(before, inventoryCounts(current)),
        worldChanges: Object.entries(result.broken).map(([name, count]) => ({
          kind: 'block_broken' as const,
          name,
          count,
        })),
        observations: result.navigationFailures.map((failure, index) => ({
          id: `gather-wood.navigation.${index}`,
          at: Date.now(),
          severity: 'warning' as const,
          kind: 'navigation.failure',
          text: `${failure.reason}: ${failure.message}`,
          data: { ...failure },
        })),
      };
    }

    // 名字在这个版本里既不是物品也不是方块（改过名、写错、太笼统）：直接说，附上相近的名字
    const lookup = requestedItem ?? requestedBlock;
    if (lookup && !current.registry?.itemsByName?.[lookup] && !current.registry?.blocksByName?.[lookup]) {
      return actionFailure('', unknownNameText(current, lookup), 'unknown_item');
    }
    const targetItem = requestedItem
      ?? (requestedBlock ? deriveDropItemForBlock(current, requestedBlock) : undefined);
    if (!targetItem) throw new Error('Missing Minecraft parameter: block or item');
    let sourceBlocks: string[];
    if (requestedBlock) {
      const resolved = resolveCollectBlock(current, requestedBlock, options.radius);
      if (!resolved) throw new Error(`Unknown Minecraft block: ${options.block}`);
      sourceBlocks = [resolved];
    } else {
      sourceBlocks = sourceBlocksForItem(current, targetItem);
      if (sourceBlocks.length === 0) {
        return actionFailure('', `cannot resolve source blocks for item ${targetItem}`, 'adapter_error');
      }
    }

    // 背包满了：挖下来的东西捡不起来（collectblock 会去找箱子放，报「没有箱子」）；直接说，列出占地方最多的几样
    const fullText = inventoryFullText(current, targetItem);
    if (fullText) return actionFailure('', fullText, 'inventory_full');

    const started = Date.now();
    const before = inventoryCounts(current);

    let brokenTotal = 0;
    let filledUp = false;
    const brokenByName: Record<string, number> = {};
    let skippedTotal = 0;
    const exclude = new Set<string>();
    const failures: string[] = [];
    const minedAt: Vec3[] = [];
    let missingToolTotal = 0;
    let observedTargetCount = before[targetItem] ?? 0;
    let sweepNumber = 0;
    // 按概率掉的（砍草出种子约 1/8、沙砾出燧石 1/10）：一轮多挖几块，不然轮数用完也挖不了几块
    const chancy = chanceDropSources(current, targetItem).length > 0;
    const collection = await runAdaptiveCollection({
      targetCount: options.maxCount,
      initialRadius: options.radius,
      maxRadius: MAX_COLLECTION_SEARCH_RADIUS,
      maxSweeps: MAX_TARGET_ITEM_SWEEPS,
      collect: async ({ radius, quantity }) => {
        throwIfAborted(options.signal);
        sweepNumber += 1;
        const swept = await collectBlocks({
          blocks: sourceBlocks,
          quantity: chancy ? quantity * 8 : quantity,
          radius,
          signal: options.signal,
          exclude,
        });
        brokenTotal += swept.total;
        skippedTotal += swept.skipped ?? 0;
        failures.push(...(swept.failures ?? []));
        minedAt.push(...(swept.mined ?? []));
        missingToolTotal += swept.missingTool ?? 0;
        for (const [name, count] of Object.entries(swept.byName)) {
          brokenByName[name] = (brokenByName[name] ?? 0) + count;
        }
        await collectItemDrops(radius, options.signal);
        const afterSweep = inventoryCounts(current);
        const currentTargetCount = afterSweep[targetItem] ?? 0;
        const gainedThisSweep = Math.max(0, currentTargetCount - observedTargetCount);
        observedTargetCount = currentTargetCount;
        const gainedTotal = Math.max(0, currentTargetCount - (before[targetItem] ?? 0));
        emit({
          kind: 'log',
          level: 'info',
          message: `[${options.actionId}] collect_item sweep=${sweepNumber} radius=${radius} requested=${quantity} broken=${brokenTotal} ${targetItem}=${gainedTotal}/${options.maxCount}`,
        });
        // 挖着挖着背包满了：停下，后面说清楚
        filledUp = !!inventoryFullText(current, targetItem);
        return {
          collectedBlocks: swept.total,
          gainedItems: gainedThisSweep,
          stop: (swept.missingTool ?? 0) > 0 || filledUp,
        };
      },
    });
    const reached = collection.reached;

    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[targetItem] ?? 0) - (before[targetItem] ?? 0));
    const sourceText = sourceBlocks.join(', ');
    // 实际挖了哪些（「挖了 12 块 gravel」），没挖到时写可能的来源
    const brokenText = Object.entries(brokenByName).map(([name, count]) => `${count} ${name}`).join(', ') || `0 blocks (sources: ${sourceText})`;
    const worldChanges: MinecraftActionResult['worldChanges'] = Object.entries(brokenByName).map(([name, count]) => ({
      kind: 'block_broken',
      name,
      count,
    }));
    // 一窝矿：挖过的每一块周围 3 格内还有同样的，告诉她在哪（挖够了数就停，旁边剩的她自己决定挖不挖）
    const leftNearby = veinLeftovers(current, minedAt, sourceBlocks);
    const veinText = leftNearby.length
      ? `; ${leftNearby.length} more ${sourceBlocks.length === 1 ? sourceBlocks[0] : 'of them'} right next to where you mined: ${leftNearby.slice(0, 8).join(', ')}${leftNearby.length > 8 ? ', …' : ''}`
      : '';
    const skippedText = skippedTotal > 0
      ? `; could not mine ${skippedTotal} of them: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? '; …' : ''}`
      : '';
    const missingToolText = missingToolTotal > 0
      ? `；另有 ${missingToolTotal} 块因缺少可开采工具无法采集，请先用 craft_item 制作所需工具（如 stone_pickaxe）再重试`
      : '';
    const observations: MinecraftActionResult['observations'] = reached ? [] : [{
      id: `collect.exhausted:${started}`,
      at: Date.now(),
      severity: 'warning',
      kind: 'collect.exhausted',
      text: `No more ${sourceText} within ${collection.finalRadius} blocks${skippedText}${missingToolText}.`,
      data: { sourceBlocks, radius: collection.finalRadius, skipped: skippedTotal, missingTool: missingToolTotal },
    }];
    if (missingToolTotal > 0) {
      observations.push({
        id: `collect.missing-tool:${started}`,
        at: Date.now(),
        severity: 'warning',
        kind: 'collect.missing-tool',
        text: `缺少可开采工具：${missingToolTotal} 块因无合适工具未采集，请先用 craft_item 制作所需工具（如 stone_pickaxe）再重试。`,
        data: { missingTool: missingToolTotal },
      });
    }
    if (!reached && filledUp) {
      return {
        actionId: '',
        outcome: 'partial',
        summary: `collected ${gained}/${options.maxCount} ${targetItem}, then ${inventoryFullText(current, targetItem)}`,
        durationMs: Date.now() - started,
        inventoryDelta: inventoryDifference(before, after),
        worldChanges,
        observations,
        error: { code: 'inventory_full', recoverable: true, details: {} },
      };
    }
    return {
      actionId: '',
      outcome: reached ? 'succeeded' : 'partial',
      summary: reached
        ? `collected ${gained} ${targetItem} by breaking ${brokenText}${veinText}`
        : `collected ${gained}/${options.maxCount} ${targetItem} by breaking ${brokenText}${missingToolText}${skippedText}${
          collection.stoppedBy === 'sweeps'
            ? `; stopped after ${collection.sweeps} rounds (there may be more ${sourceText} around${chancy ? `; ${targetItem} only drops sometimes` : ''})`
            : missingToolTotal === 0 && skippedTotal === 0 ? `; no more ${sourceText} within ${collection.finalRadius} blocks, consider searching another area` : ''}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges,
      observations,
    };
  }

  async function runCraftItem(options: {
    actionId: string;
    item: string;
    quantity?: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const quantity = Math.max(1, Math.trunc(options.quantity ?? 1));
    const started = Date.now();
    const before = inventoryCounts(current);
    let plan = planCraft(current, options.item, quantity);
    if (!plan.recipeAvailable) {
      const name = normalizeMinecraftLookupName(options.item);
      return {
        actionId: '',
        outcome: 'failed',
        summary: current.registry?.itemsByName?.[name]
          ? `${name} has no crafting recipe (it is collected, smelted or dropped by mobs, not crafted)`
          : unknownNameText(current, name),
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: [],
        error: { code: 'unknown_item', recoverable: false, details: { item: options.item } },
      };
    }
    if (!plan.canCraftNow) {
      let missing = plan.missing;
      let sources = plan.sources;
      let furnaceChecked = false;
      if (furnaceCanHelp(plan)) {
        try {
          const furnaceState = await readNearbyFurnaceState(current, options.signal);
          const adjusted = deductMissingFromFurnace(plan, furnaceState);
          if (Object.keys(adjusted.offsetByFurnace).length > 0) {
            const offsetText = Object.entries(adjusted.offsetByFurnace)
              .map(([name, count]) => `${count}x ${name}`)
              .join('、');
            emit({
              kind: 'log',
              level: 'info',
              message: `[craft] ${plan.targetItem}: 附近熔炉抵扣 ${offsetText}，继续按计划执行`,
            });
          }
          missing = adjusted.missing;
          sources = adjusted.sources;
          furnaceChecked = furnaceState !== undefined;
        } catch (error) {
          if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            return craftFailure('cancelled', 'craft cancelled', started);
          }
        }
      }
      if (Object.keys(missing).length > 0) {
        const missingText = Object.entries(missing)
          .map(([name, count]) => `${count}x ${name}${sources[name] ? `（${sources[name]}）` : ''}`)
          .join('，');
        return {
          actionId: '',
          outcome: 'failed',
          summary: `cannot craft ${plan.targetItem}: missing ${missingText}`,
          durationMs: Date.now() - started,
          inventoryDelta: {},
          worldChanges: [],
          observations: [{
            id: `craft.missing:${started}`,
            at: Date.now(),
            severity: 'warning',
            kind: 'craft.missing',
            text: `缺少材料：${missingText}。${furnaceChecked ? '已检查附近熔炉，仍不足以补齐缺口，' : ''}请先收集后再重试 craft_item。`,
            data: { missing, sources },
          }],
          error: { code: 'missing_item', recoverable: true, details: { missing, sources } },
        };
      }
    }

    let placedTable = false;
    try {
      if (plan.requiresCraftingTable) {
        const ensured = await ensureCraftingTableFor(current, options.signal);
        placedTable ||= ensured.placed;
        plan = planCraft(current, options.item, quantity);
        if (!plan.canCraftNow) {
          const missingText = Object.entries(plan.missing)
            .map(([name, count]) => `${count}x ${name}`)
            .join(', ');
          throw createCraftError(
            'missing_item',
            `cannot craft ${plan.targetItem} after preparing a crafting table: missing ${missingText || 'materials'}`,
          );
        }
      }
      await executeCraftPlanSteps(current, plan, options.signal, plan.targetItem, (placed) => {
        if (placed) placedTable = true;
      });
    } catch (error) {
      const cancelled = options.signal.aborted
        || (error instanceof Error && error.name === 'AbortError');
      const code = error instanceof Error && error.name === 'InventoryFullError'
        ? 'inventory_full'
        : cancelled
          ? 'cancelled'
          : craftErrorCode(error) ?? 'adapter_error';
      return craftFailure(
        code,
        cancelled ? 'craft cancelled' : `craft failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }

    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[plan.targetItem] ?? 0) - (before[plan.targetItem] ?? 0));
    const reached = gained >= quantity;
    return {
      actionId: '',
      outcome: reached ? 'succeeded' : 'partial',
      summary: reached
        ? `crafted ${gained} ${plan.targetItem}`
        : `crafted ${gained}/${quantity} ${plan.targetItem}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges: placedTable ? [{ kind: 'block_placed', name: 'crafting_table', count: 1 }] : [],
      observations: [],
    };
  }

  async function executeCraftPlanSteps(
    current: any,
    plan: CraftPlan,
    signal?: AbortSignal,
    targetItem?: string,
    onPlaced?: (placed: boolean) => void,
  ): Promise<void> {
    // 合成是一串点格子：自动吃东西同时去换手上的东西会把格子点乱，鼠标上剩的东西就被扔到地上。
    // 合成期间先停掉自动吃（正在吃就等吃完），合成完（成没成都一样）把鼠标上剩的东西放回背包
    const autoEat = current.autoEat;
    const eatWasOn = !!autoEat?.enabled;
    if (eatWasOn) autoEat.disableAuto();
    for (let waited = 0; autoEat?.isEating && waited < 5000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    try {
      await runCraftPlanSteps(current, plan, signal, targetItem, onPlaced);
    } finally {
      await tidyCrafting(current).catch(() => {});
      if (eatWasOn) autoEat.enableAuto();
    }
  }

  /**
   * 合成中途出错时，鼠标上和合成格里可能还剩着东西（合成格里的东西不算在背包里，看着就像没了）：都放回背包，背包满了才会扔。
   * 合成格：背包界面是 1~4（2x2），工作台界面是 1~9
   */
  async function tidyCrafting(current: any): Promise<void> {
    const window = current.currentWindow ?? current.inventory;
    if (!window) return;
    if (window.selectedItem) {
      emit({ kind: 'log', level: 'warn', message: `[craft] ${window.selectedItem.name} x${window.selectedItem.count} left on the cursor; putting it back` });
      await current.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null);
    }
    const gridEnd = window === current.inventory ? 4 : window.type === 'minecraft:crafting' || window.type === 'minecraft:crafting_table' ? 9 : 0;
    for (let slot = 1; slot <= gridEnd; slot++) {
      const item = window.slots[slot];
      if (!item) continue;
      emit({ kind: 'log', level: 'warn', message: `[craft] ${item.name} x${item.count} left in crafting slot ${slot}; putting it back` });
      await current.putAway(slot);
    }
  }

  async function runCraftPlanSteps(
    current: any,
    plan: CraftPlan,
    signal?: AbortSignal,
    targetItem?: string,
    onPlaced?: (placed: boolean) => void,
  ): Promise<void> {
    for (const step of plan.steps) {
      throwIfAborted(signal);
      const have = inventoryCounts(current)[step.item] ?? 0;
      const need = step.item === targetItem
        ? step.amount
        : Math.max(0, step.amount - have);
      if (need <= 0) continue;
      if ((current.inventory?.emptySlotCount?.() ?? 1) === 0) {
        const error = new Error(`inventory is full; cannot craft ${step.item}`);
        error.name = 'InventoryFullError';
        throw error;
      }
      if (step.kind === 'smelt') {
        const smeltInput = Object.keys(step.ingredients).find((name) => name !== SMELT_FUEL_ITEM);
        if (!smeltInput) throw new Error(`cannot smelt ${step.item}: unknown input`);
        const smeltCount = step.craftCount ?? Math.ceil(need / step.outputPerCraft);
        const expectedOutput = smeltCount * step.outputPerCraft;
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] step ${step.item} x${expectedOutput} (smelt ${smeltCount}x ${smeltInput} + ${step.ingredients[SMELT_FUEL_ITEM] ?? 0}x ${SMELT_FUEL_ITEM})`,
        });
        await smeltItems(current, smeltInput, step.item, smeltCount, signal);
        const produced = Math.max(0, (inventoryCounts(current)[step.item] ?? 0) - have);
        if (produced < expectedOutput) {
          throw new Error(`smelt output mismatch for ${step.item}: expected ${expectedOutput}, got ${produced}`);
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] verified ${step.item} +${produced} (needed ${step.amount})`,
        });
        continue;
      }
      const craftCount = step.craftCount ?? Math.ceil(need / step.outputPerCraft);
      let table: any;
      if (step.requiresCraftingTable) {
        const ensured = await ensureCraftingTableFor(current, signal);
        table = ensured.table;
        onPlaced?.(ensured.placed);
        await moveNearBlock(current, table.position, signal);
      }
      const firstRecipe = pickCraftRecipe(current, step, table, 1);
      if (!firstRecipe) {
        const missingText = Object.entries(step.ingredients)
          .filter(([name, count]) => availableIngredientCount(current, name) < count)
          .map(([name, count]) => `${count}x ${name}`)
          .join('，');
          throw createCraftError(
            'recipe_unavailable',
            `cannot craft ${step.item}: missing ${missingText || 'materials'}`,
          );
      }
      emit({
        kind: 'log',
        level: 'info',
        message: `[craft] step ${step.item} x${craftCount}${table ? ' (crafting table)' : ''}`,
      });
      for (let index = 0; index < craftCount; index += 1) {
        throwIfAborted(signal);
        const recipe = index === 0
          ? firstRecipe
          : pickCraftRecipe(current, step, table, 1);
        if (!recipe) {
          throw createCraftError(
            'recipe_unavailable',
            `cannot craft ${step.item}: materials changed during crafting`,
          );
        }
        const beforeRecipe = inventoryCounts(current);
        const beforeOutput = beforeRecipe[step.item] ?? 0;
        const expectedRecipeOutput = Math.max(
          1,
          Number(recipe.result?.count ?? step.outputPerCraft),
        );
        try {
          await current.craft(recipe, 1, table ?? null);
        } catch (error) {
          throw createCraftError(
            'craft_rejected',
            `craft rejected for ${step.item}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const optimisticOutput = inventoryCounts(current)[step.item] ?? 0;
        await waitForServerInventoryBarrier(current, signal);
        const confirmedOutput = inventoryCounts(current)[step.item] ?? 0;
        const confirmedGain = confirmedOutput - beforeOutput;
        if (confirmedGain < expectedRecipeOutput) {
          const optimisticGain = optimisticOutput - beforeOutput;
          const rolledBack = optimisticGain >= expectedRecipeOutput;
          throw createCraftError(
            rolledBack ? 'inventory_desync' : 'craft_rejected',
            rolledBack
              ? `craft inventory rolled back for ${step.item}: expected +${expectedRecipeOutput}, got +${Math.max(0, confirmedGain)}`
              : `craft server confirmation did not produce ${step.item}: expected +${expectedRecipeOutput}, got +${Math.max(0, confirmedGain)}`,
          );
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[craft] server confirmed ${step.item} recipe ${index + 1}/${craftCount} (+${confirmedGain})`,
        });
      }
      const confirmed = inventoryCounts(current);
      const gained = Math.max(0, (confirmed[step.item] ?? 0) - have);
      emit({
        kind: 'log',
        level: 'info',
        message: `[craft] verified ${step.item} +${gained} (needed ${step.amount})`,
      });
    }
  }

  async function ensureCraftingTableFor(
    current: any,
    signal?: AbortSignal,
  ): Promise<{ table: any; placed: boolean }> {
    if (knownCraftingTable) {
      const cached = current.blockAt(knownCraftingTable);
      if (
        cached?.name === 'crafting_table'
        && await canReachWorkstation(current, cached, 'crafting_table', signal)
      ) {
        return { table: cached, placed: false };
      }
      knownCraftingTable = undefined;
    }
    const found = findCraftingTable(current, 32);
    if (found && await canReachWorkstation(current, found, 'crafting_table', signal)) {
      knownCraftingTable = found.position;
      return { table: found, placed: false };
    }
    // 背包里已有工作台：直接复用放置，不再重复合成
    const carried = current.inventory?.items?.().find((item: any) => item.name === 'crafting_table');
    if (carried) {
      const placed = await placeBlockAt(current, carried, undefined, 'auto', signal);
      knownCraftingTable = placed.position;
      emit({ kind: 'log', level: 'info', message: '[craft] placed a carried crafting table for crafting' });
      return { table: placed, placed: true };
    }

    const tablePlan = planCraft(current, 'crafting_table', 1);
    if (!tablePlan.recipeAvailable || !tablePlan.canCraftNow) {
      const missingText = Object.entries(tablePlan.missing)
        .map(([name, count]) => `${count}x ${name}`)
        .join('，');
      throw new Error(`cannot craft crafting table: missing ${missingText}`);
    }
    await executeCraftPlanSteps(current, tablePlan, signal, 'crafting_table');
    const tableItem = current.inventory?.items?.().find((item: any) => item.name === 'crafting_table');
    if (!tableItem) throw new Error('crafted crafting table but it is not in inventory');
    const placed = await placeBlockAt(current, tableItem, undefined, 'auto', signal);
    knownCraftingTable = placed.position;
    emit({ kind: 'log', level: 'info', message: '[craft] placed a crafting table for crafting' });
    return { table: placed, placed: true };
  }

  async function ensureFurnaceFor(
    current: any,
    signal?: AbortSignal,
  ): Promise<{ furnace: any; placed: boolean }> {
    const found = findFurnaceBlock(current, 32);
    if (found && await canReachWorkstation(current, found, 'furnace', signal)) {
      return { furnace: found, placed: false };
    }
    // 背包里已有熔炉：直接复用放置，不再重复合成
    const carried = current.inventory?.items?.().find((item: any) => item.name === 'furnace');
    if (carried) {
      const placed = await placeBlockAt(current, carried, undefined, 'auto', signal);
      emit({ kind: 'log', level: 'info', message: '[smelt] placed a carried furnace for smelting' });
      return { furnace: placed, placed: true };
    }
    const furnacePlan = planCraft(current, 'furnace', 1);
    if (!furnacePlan.recipeAvailable || !furnacePlan.canCraftNow) {
      const missingText = Object.entries(furnacePlan.missing)
        .map(([name, count]) => `${count}x ${name}`)
        .join('，');
      throw new Error(`cannot craft furnace: missing ${missingText}`);
    }
    await executeCraftPlanSteps(current, furnacePlan, signal, 'furnace');
    const furnaceItem = current.inventory?.items?.().find((item: any) => item.name === 'furnace');
    if (!furnaceItem) throw new Error('crafted furnace but it is not in inventory');
    const placed = await placeBlockAt(current, furnaceItem, undefined, 'auto', signal);
    emit({ kind: 'log', level: 'info', message: '[smelt] placed a furnace for smelting' });
    return { furnace: placed, placed: true };
  }

  async function canReachWorkstation(
    current: any,
    block: any,
    workstation: 'crafting_table' | 'furnace',
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await moveNearBlock(current, block.position, signal);
      return true;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[craft] ignoring unreachable ${workstation} at ${formatPosition(block.position)}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  interface NearbyFurnaceState {
    input?: { name: string; count: number };
    fuel?: { name: string; count: number };
    output?: { name: string; count: number };
  }

  // 计划期抵扣：只有缺口与熔炼相关时才值得去读附近熔炉（避免为无关缺口白跑一趟）
  function furnaceCanHelp(plan: CraftPlan): boolean {
    const smeltSteps = plan.steps.filter((step) => step.kind === 'smelt');
    if (smeltSteps.length === 0) return false;
    const related = new Set<string>([SMELT_FUEL_ITEM]);
    for (const step of smeltSteps) {
      related.add(step.item);
      for (const ingredient of Object.keys(step.ingredients)) related.add(ingredient);
    }
    return Object.keys(plan.missing).some((name) => related.has(name));
  }

  // 读取附近熔炉（32 格，与附近工作台/熔炉的判定一致）的输入、燃料、输出槽状态；只读不改。
  async function readNearbyFurnaceState(
    current: any,
    signal?: AbortSignal,
  ): Promise<NearbyFurnaceState | undefined> {
    const furnace = findFurnaceBlock(current, 32);
    if (!furnace) return undefined;
    try {
      await moveNearBlock(current, furnace.position, signal);
      const window = await current.openFurnace(furnace);
      try {
        const nameById = new Map<number, string>();
        for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
          if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
        }
        const readSlot = (item: any): { name: string; count: number } | undefined => {
          if (!item) return undefined;
          const name = typeof item.name === 'string'
            ? item.name
            : typeof item.type === 'number'
              ? nameById.get(item.type)
              : undefined;
          if (!name) return undefined;
          return { name, count: item.count ?? 0 };
        };
        return {
          input: readSlot(window.inputItem?.()),
          fuel: readSlot(window.fuelItem?.()),
          output: readSlot(window.outputItem?.()),
        };
      } finally {
        window.close?.();
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[smelt] could not read nearby furnace state: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  // 用熔炉槽位抵扣计划缺口：
  // - 熔炼步骤的输入缺口由「输入槽已有原料 + 已烧好的成品数」覆盖（成品说明原料已被消耗）；
  // - 燃料缺口由「燃料槽已有燃料 + 成品对应的燃料份额」覆盖；
  // - 缺口本身是熔炼成品名时，直接由输出槽覆盖（兜底）。
  function deductMissingFromFurnace(
    plan: CraftPlan,
    state: NearbyFurnaceState | undefined,
  ): { missing: Record<string, number>; sources: Record<string, string>; offsetByFurnace: Record<string, number> } {
    const missing: Record<string, number> = { ...plan.missing };
    const offsetByFurnace: Record<string, number> = {};
    if (state) {
      const offset = (name: string, amount: number) => {
        const need = missing[name] ?? 0;
        if (amount <= 0 || need <= 0) return;
        const used = Math.min(need, amount);
        missing[name] = need - used;
        offsetByFurnace[name] = (offsetByFurnace[name] ?? 0) + used;
        if (missing[name] <= 0) delete missing[name];
      };
      for (const step of plan.steps) {
        if (step.kind !== 'smelt') continue;
        const stepInput = Object.keys(step.ingredients).find((name) => name !== SMELT_FUEL_ITEM);
        if (!stepInput) continue;
        const finished = state.output?.name === step.item ? Math.min(state.output.count, step.amount) : 0;
        const inputInSlot = state.input?.name === stepInput ? state.input.count : 0;
        const fuelInSlot = state.fuel?.name === SMELT_FUEL_ITEM ? state.fuel.count : 0;
        offset(stepInput, inputInSlot + finished);
        offset(SMELT_FUEL_ITEM, fuelInSlot + Math.ceil(finished / SMELT_ITEMS_PER_FUEL));
      }
      if (state.output) offset(state.output.name, state.output.count);
    }
    const sources: Record<string, string> = {};
    for (const name of Object.keys(missing)) {
      if (plan.sources[name]) sources[name] = plan.sources[name];
    }
    return { missing, sources, offsetByFurnace };
  }

  async function smeltItems(
    current: any,
    inputName: string,
    outputName: string,
    quantity: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const inputId = current.registry?.itemsByName?.[inputName]?.id;
    const outputId = current.registry?.itemsByName?.[outputName]?.id;
    if (inputId === undefined || outputId === undefined) {
      throw new Error(`unknown smelt items: ${inputName} -> ${outputName}`);
    }
    const { furnace } = await ensureFurnaceFor(current, signal);
    await moveNearBlock(current, furnace.position, signal);
    const window = await current.openFurnace(furnace);
    try {
      let gained = 0;
      while (gained < quantity) {
        throwIfAborted(signal);
        const batch = Math.min(64, quantity - gained);
        const fuelItemId = current.registry?.itemsByName?.[SMELT_FUEL_ITEM]?.id;
        // 先读熔炉槽位，只补差额（上一次失败可能已把料放进炉子）
        const currentInput = window.inputItem?.();
        const currentFuel = window.fuelItem?.();
        const currentOutput = window.outputItem?.();
        const inputPresent = currentInput && currentInput.type === inputId ? currentInput.count : 0;
        const fuelPresent = currentFuel && currentFuel.type === fuelItemId ? currentFuel.count : 0;
        const outputPresent = currentOutput && currentOutput.type === outputId ? currentOutput.count : 0;
        const inputShortfall = Math.max(0, batch - inputPresent - outputPresent);
        const fuelNeededCoal = Math.ceil(Math.max(0, batch - outputPresent) / SMELT_ITEMS_PER_FUEL);
        const fuelShortfall = Math.max(0, fuelNeededCoal - fuelPresent);
        const haveInput = inventoryCounts(current)[inputName] ?? 0;
        const haveFuel = inventoryCounts(current)[SMELT_FUEL_ITEM] ?? 0;
        if (haveInput < inputShortfall) {
          throw new Error(`cannot smelt ${outputName}: missing ${inputShortfall}x ${inputName}`);
        }
        if (haveFuel < fuelShortfall) {
          throw new Error(`cannot smelt ${outputName}: missing ${fuelShortfall}x ${SMELT_FUEL_ITEM}`);
        }
        emit({
          kind: 'log',
          level: 'info',
          message: `[smelt] batch ${batch}x ${inputName} -> ${outputName} (fuel ${fuelNeededCoal}x ${SMELT_FUEL_ITEM})`,
        });
        const inputItem = current.inventory?.items?.().find((item: any) => item.name === inputName);
        const fuelItem = current.inventory?.items?.().find((item: any) => item.name === SMELT_FUEL_ITEM);
        if (inputShortfall > 0 && inputItem) {
          await reconcileFurnaceSlot(
            () => window.putInput(inputItem.type, inputItem.metadata, inputShortfall),
            () => window.inputItem?.(),
            inputId,
            inputItem.metadata,
            batch,
            signal,
          );
        }
        if (fuelShortfall > 0 && fuelItem) {
          await delay(400, signal);
          await reconcileFurnaceSlot(
            () => window.putFuel(fuelItem.type, fuelItem.metadata, fuelShortfall),
            () => window.fuelItem?.(),
            fuelItem.type,
            fuelItem.metadata,
            fuelNeededCoal,
            signal,
          );
        }
        await waitForSmeltBatch(window, batch, signal);
        const output = window.outputItem();
        if (output) await window.takeOutput();
        gained += batch;
        emit({
          kind: 'log',
          level: 'info',
          message: `[smelt] verified ${outputName} +${gained}/${quantity}`,
        });
      }
    } finally {
      window.close?.();
    }
  }

  // 对账式放料：报错后重读熔炉槽位，若点击实际已生效（1.11.2 窗口失步误报）则视为成功；
  // 否则重试一次差额，仍失败才抛出。绝不盲目重试（避免重复放入）也不取回（避免抽走正在烧的料）。
  async function reconcileFurnaceSlot(
    operation: () => Promise<void>,
    readSlot: () => any,
    itemType: number,
    metadata: number,
    targetCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const slotHasEnough = () => {
      const slot = readSlot();
      return slot && slot.type === itemType && slot.metadata === metadata && slot.count >= targetCount;
    };
    if (slotHasEnough()) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      throwIfAborted(signal);
      try {
        await operation();
      } catch (error) {
        lastError = error;
        emit({
          kind: 'log',
          level: 'warn',
          message: `[smelt] window click reported error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (slotHasEnough()) return; // 点击实际生效（被误报），对账通过
      await delay(400 * attempt, signal);
    }
    throw lastError ?? new Error('furnace slot reconciliation failed');
  }

  async function waitForSmeltBatch(
    window: any,
    batch: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    const timeoutMs = batch * 12_000 + 15_000;
    while (Date.now() - started < timeoutMs) {
      throwIfAborted(signal);
      const output = window.outputItem?.();
      if (output && (output.count ?? 0) >= batch) return;
      await delay(500, signal);
    }
    throw new Error(`smelting timed out after ${Math.round((Date.now() - started) / 1000)}s`);
  }

  async function runSmeltItem(options: {
    actionId: string;
    item?: string;
    block?: string;
    quantity: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const before = inventoryCounts(current);
    const quantity = Math.max(1, Math.min(64, Math.trunc(options.quantity ?? 1)));
    const nameById = new Map<number, string>();
    for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
      if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
    }
    let inputName: string | undefined;
    let outputName: string | undefined;
    if (options.item) {
      outputName = normalizeMinecraftLookupName(options.item);
      const outputId = current.registry?.itemsByName?.[outputName]?.id;
      const availableItems = new Map<string, number>();
      for (const inventoryItem of current.inventory?.items?.() ?? []) {
        availableItems.set(
          inventoryItem.name,
          (availableItems.get(inventoryItem.name) ?? 0) + Math.max(0, Number(inventoryItem.count ?? 1)),
        );
      }
      const inputId = outputId !== undefined
        ? smeltInputFor(current.registry, outputId, recipesSourceFor(current), availableItems, quantity)
        : undefined;
      if (inputId === undefined) {
        return craftFailure('unknown_item', `cannot smelt ${options.item}: not a furnace product`, started);
      }
      inputName = nameById.get(inputId);
    } else if (options.block) {
      inputName = normalizeMinecraftLookupName(options.block);
      const inputId = current.registry?.itemsByName?.[inputName]?.id;
      const outputId = inputId !== undefined
        ? smeltOutputFor(current.registry, inputId, recipesSourceFor(current))
        : undefined;
      if (outputId === undefined) {
        return craftFailure('unknown_item', `cannot smelt ${options.block}: not a smeltable input`, started);
      }
      outputName = nameById.get(outputId);
    } else {
      return craftFailure('adapter_error', 'Missing Minecraft parameter: block or item', started);
    }
    if (!inputName || !outputName) {
      return craftFailure('unknown_item', 'cannot resolve smelt items', started);
    }
    try {
      await smeltItems(current, inputName, outputName, quantity, options.signal);
    } catch (error) {
      const cancelled = options.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return craftFailure(
        cancelled ? 'cancelled' : 'adapter_error',
        cancelled ? 'smelt cancelled' : `smelt failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
    const after = inventoryCounts(current);
    const gained = Math.max(0, (after[outputName] ?? 0) - (before[outputName] ?? 0));
    return {
      actionId: '',
      outcome: gained >= quantity ? 'succeeded' : 'partial',
      summary: gained >= quantity
        ? `smelted ${gained} ${outputName}`
        : `smelted ${gained}/${quantity} ${outputName}`,
      durationMs: Date.now() - started,
      inventoryDelta: inventoryDifference(before, after),
      worldChanges: [],
      observations: [],
    };
  }

  async function placeBlockAt(
    current: any,
    item: any,
    explicitTarget: Vec3 | undefined,
    face: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const normalizedFace = face || 'auto';
    let target: Vec3;
    let placeOn: PlaceFace;
    let preferredDir: Vec3 | undefined;
    if (explicitTarget) {
      target = explicitTarget;
      const spec = resolveExplicitPlacement(current, target, normalizedFace);
      if (!spec) throw new Error(`cannot place ${item.name} at ${target.toString()} with face ${normalizedFace}`);
      preferredDir = spec.faceVector;
      placeOn = placementFaceFor(spec.faceVector);
    } else {
      let auto = findAutoPlacement(current);
      if (!auto) {
        // 没有现成空间：自动清障创造放置空间（挖掉身边可挖方块）
        const cleared = await clearSpaceForPlacement(current, signal);
        auto = cleared.ok ? findAutoPlacement(current) : undefined;
        if (!auto) {
          emit({
            kind: 'log',
            level: 'warn',
            message: `[place-debug] no free space for ${item.name} and auto clearance failed: ${cleared.details}`,
          });
          throw new Error(
            `no free space to place ${item.name}${cleared.clearedCount > 0 ? ` after clearing ${cleared.clearedCount} block(s)` : ''}; consider moving to an open area`,
          );
        }
      }
      target = auto.target;
      preferredDir = auto.spec.faceVector;
      placeOn = placementFaceFor(auto.spec.faceVector);
    }

    // 清空占用、过近躲避、走近、装备、放置、状态处理：全部交给 AIRI 移植的 placeBlockAt
    const referenceBlock = preferredDir ? current.blockAt(target.minus(preferredDir)) : undefined;
    emit({
      kind: 'log',
      level: 'info',
      message: `[place-debug] select ${item.name} target=${target.toString()} face=(${preferredDir?.x ?? 0},${preferredDir?.y ?? 0},${preferredDir?.z ?? 0}) ref=${referenceBlock?.name ?? 'none'} bot=${current.entity?.position ? formatPosition(current.entity.position) : 'none'} dist=${distanceToBot(current, target).toFixed(1)}`,
    });
    let placementError: unknown;
    try {
      await airiPlaceBlockAt(current, item, target, placeOn, { preferredDir, signal });
    } catch (error) {
      placementError = error;
      emit({
        kind: 'log',
        level: 'warn',
        message: `[place-debug] placeBlock error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // 放置结果以世界实况为准：在期望点周边找实际落下的方块，找不到才视为真实失败
    let placed: any;
    for (let attempt = 0; attempt < 8 && !placed; attempt += 1) {
      placed = locatePlacedBlock(current, target, item.name);
      if (!placed) await delay(250, signal);
    }
    if (!placed) {
      emit({
        kind: 'log',
        level: 'warn',
        message: `[place-debug] not placed around ${target.toString()} after 8 polls; error=${placementError instanceof Error ? placementError.message : String(placementError)}; bot now=${current.entity?.position ? formatPosition(current.entity.position) : 'none'}`,
      });
      if (placementError) throw placementError;
      throw new Error(`${item.name} placement failed`);
    }
    if (placementError) {
      emit({ kind: 'log', level: 'warn', message: `[place] placeBlock reported an error but the ${item.name} was placed` });
    }
    return placed;
  }

  function placementFaceFor(faceVector: Vec3): PlaceFace {
    if (faceVector.y > 0) return 'bottom'; // 放地面：参考在下方、面向上
    if (faceVector.y < 0) return 'top'; // 贴天花板
    return 'side'; // 贴墙
  }

  function faceVectorFor(face: string): Vec3 {
    switch (face) {
      case 'bottom': return new Vec3(0, -1, 0);
      case 'north': return new Vec3(0, 0, -1);
      case 'south': return new Vec3(0, 0, 1);
      case 'west': return new Vec3(-1, 0, 0);
      case 'east': return new Vec3(1, 0, 0);
      case 'top':
      default: return new Vec3(0, 1, 0);
    }
  }

  function resolvePlacementSpec(
    current: any,
    target: Vec3,
    face: string,
  ): { reference: any; faceVector: Vec3 } | null {
    const faceVector = faceVectorFor(face);
    const reference = current.blockAt(target.minus(faceVector));
    if (!reference || isReplaceableForPlacement(reference)) {
      return null;
    }
    const spot = current.blockAt(target);
    if (!spot || !isReplaceableForPlacement(spot)) return null;
    return { reference, faceVector };
  }

  function resolveAutoPlacementSpec(
    current: any,
    target: Vec3,
  ): { reference: any; faceVector: Vec3 } | null {
    for (const face of ['top', 'north', 'south', 'east', 'west', 'bottom']) {
      const spec = resolvePlacementSpec(current, target, face);
      if (spec) return spec;
    }
    return null;
  }

  function resolveExplicitPlacement(
    current: any,
    target: Vec3,
    face: string,
  ): { reference: any; faceVector: Vec3 } | null {
    const faces = face === 'auto' ? ['top', 'north', 'south', 'east', 'west', 'bottom'] : [face];
    for (const candidate of faces) {
      const faceVector = faceVectorFor(candidate);
      const reference = current.blockAt(target.minus(faceVector));
      if (!reference || isReplaceableForPlacement(reference)) {
        continue;
      }
      return { reference, faceVector };
    }
    return null;
  }

  function findAutoPlacement(current: any): { target: Vec3; spec: { reference: any; faceVector: Vec3 } } | undefined {
    // 不放在熔炉、箱子、工作台这类能右键打开的方块上：对着它们放会打开它们的界面
    const ground = findFreePlacePosition(current, 6);
    if (ground) {
      const spec = resolvePlacementSpec(current, ground, 'top');
      if (spec && !isInteractive(spec.reference)) return { target: ground, spec };
    }
    // 墙面兜底（对齐 AIRI findPlacementSpot）：找"落点可放置且至少一侧有实心参考"的最近点
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') return undefined;
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Array<{ target: Vec3; spec: { reference: any; faceVector: Vec3 }; distance: number }> = [];
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 1) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          const target = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
          const spec = resolveAutoPlacementSpec(current, target);
          if (!spec || isInteractive(spec.reference)) continue;
          candidates.push({ target, spec, distance: distanceToBot(current, target) });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0];
  }

  interface ClearSpaceResult {
    ok: boolean;
    clearedCount: number;
    details: string;
  }

  const UNBREAKABLE_BLOCK_NAMES = new Set([
    'bedrock', 'barrier', 'command_block', 'end_portal', 'end_portal_frame',
    'nether_portal', 'obsidian',
  ]);
  const HAZARD_FLUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
  const FALLING_BLOCK_NAMES = new Set(['sand', 'red_sand', 'gravel', 'anvil', 'dragon_egg']);

  function isHazardousNeighbor(current: any, target: Vec3): boolean {
    const neighbors: Array<[number, number, number]> = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of neighbors) {
      const neighbor = current.blockAt(target.offset(dx, dy, dz));
      if (neighbor && HAZARD_FLUID_NAMES.has(neighbor.name)) return true;
    }
    return false;
  }

  // 挖掉目标后，上方易下落的方块（沙子/沙砾/铁砧）会掉下来重新占位，跳过
  function willCollapseInto(current: any, target: Vec3): boolean {
    const above = current.blockAt(target.offset(0, 1, 0));
    return Boolean(above && FALLING_BLOCK_NAMES.has(above.name));
  }

  // 没有现成放置点时：在 bot 身边找可挖方块，挖掉 1 块创造放置平台（AIRI clearBlockSpace 扩展）。
  // 挖完立刻重查放置点；所有候选都失败才返回失败详情，方便调试。
  async function clearSpaceForPlacement(current: any, signal?: AbortSignal): Promise<ClearSpaceResult> {
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') {
      return { ok: false, clearedCount: 0, details: 'bot position or blockAt unavailable' };
    }
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Array<{ target: Vec3; name: string; distance: number }> = [];
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 1) continue;
        for (let dy = 0; dy <= 2; dy += 1) {
          const target = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
          const below = current.blockAt(target.offset(0, -1, 0));
          if (!below || isReplaceableForPlacement(below)) continue; // 下方必须实心
          const block = current.blockAt(target);
          if (!block || isReplaceableForPlacement(block)) continue; // 目标位必须可挖（非空气/植物）
          if (UNBREAKABLE_BLOCK_NAMES.has(block.name)) continue;
          if (isHazardousNeighbor(current, target) || willCollapseInto(current, target)) continue;
          candidates.push({ target, name: block.name, distance: distanceToBot(current, target) });
        }
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    const failures: string[] = [];
    let clearedCount = 0;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const block = current.blockAt(candidate.target);
      if (!block || isReplaceableForPlacement(block)) continue; // 已被其他动作清掉
      try {
        try {
          await current.tool?.equipForBlock?.(block);
        } catch {
          // 没有合适工具也允许继续（手挖更慢但不阻塞清障）
        }
        await breakBlockAt(current, candidate.target, signal);
        clearedCount += 1;
        // 等待方块更新后重查放置点
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await delay(250, signal);
          if (findAutoPlacement(current)) return { ok: true, clearedCount, details: 'ok' };
        }
        failures.push(`${candidate.target.toString()} (${candidate.name}): cleared but no placement spot formed`);
      } catch (error) {
        failures.push(`${candidate.target.toString()} (${candidate.name}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      ok: false,
      clearedCount,
      details: failures.length > 0 ? failures.join('; ') : 'no clearable candidates nearby',
    };
  }

  function locatePlacedBlock(current: any, around: Vec3, blockName: string): any | undefined {
    if (typeof current.blockAt !== 'function') return undefined;
    let best: any;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const block = current.blockAt(around.offset(dx, dy, dz));
          if (block?.name !== blockName) continue;
          const distance = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = block;
          }
        }
      }
    }
    return best;
  }

  async function runPlaceBlock(options: {
    actionId: string;
    block: string;
    position?: { x: number; y: number; z: number };
    face?: string;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const blockName = normalizeMinecraftLookupName(options.block);
    const item = current.inventory?.items?.().find((entry: any) => entry.name === blockName);
    if (!item) {
      return craftFailure('missing_item', `no ${blockName} in inventory to place`, started);
    }
    try {
      const target = options.position
        ? new Vec3(Math.floor(options.position.x), Math.floor(options.position.y), Math.floor(options.position.z))
        : undefined;
      await placeBlockAt(current, item, target, options.face ?? 'auto', options.signal);
      return {
        actionId: '',
        outcome: 'succeeded',
        summary: `placed ${blockName}`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [{ kind: 'block_placed', name: blockName, count: 1 }],
        observations: [],
      };
    } catch (error) {
      const cancelled = options.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return craftFailure(
        cancelled ? 'cancelled' : 'blocked',
        cancelled ? 'place cancelled' : `place failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  function pickCraftRecipe(
    current: any,
    step: CraftPlanStep,
    table: any,
    requestedCraftCount = step.craftCount ?? Math.ceil(step.amount / step.outputPerCraft),
  ): any | null {
    const id = current.registry?.itemsByName?.[step.item]?.id;
    if (id === undefined) return null;

    const craftCount = Math.max(1, requestedCraftCount);
    const expectedOutput = craftCount * step.outputPerCraft;
    const plannedIngredients = ingredientsForCraftCount(step, craftCount);
    const available = current.recipesFor?.(id, null, expectedOutput, table ?? null) ?? [];
    const selected = available.find((recipe: any) => (
      recipeMatchesPlan(current, recipe, craftCount, plannedIngredients)
    ));
    if (selected) {
      return relaxInterchangeableMetadata(current, selected);
    }

    // Registry tag expansion can expose only concrete variants even when the
    // vanilla recipe accepts a material family such as any planks.
    const all = current.recipesAll?.(id, null, table ?? null) ?? [];
    const legacy = all.find((recipe: any) => (
      recipeMatchesPlan(current, recipe, craftCount, plannedIngredients)
      && hasNamedIngredients(current, plannedIngredients)
    ));
    if (!legacy) return null;
    return relaxInterchangeableMetadata(current, legacy);
  }

  function recipeMatchesPlan(
    current: any,
    recipe: any,
    craftCount: number,
    plannedIngredients: Record<string, number>,
  ): boolean {
    const nameById = new Map<number, string>();
    for (const [name, item] of Object.entries(current.registry?.itemsByName ?? {})) {
      if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
    }

    const entries = Array.isArray(recipe.inShape)
      ? recipe.inShape.flat()
      : (recipe.ingredients ?? []);
    const actual: Record<string, number> = {};
    for (const entry of entries) {
      const id = typeof entry === 'number' ? entry : entry?.id;
      if (id === undefined || id === null || id === -1) continue;
      const name = nameById.get(id);
      if (!name) continue;
      const perCraft = Math.max(1, Math.abs(Number(entry?.count ?? 1)));
      actual[name] = (actual[name] ?? 0) + perCraft * craftCount;
    }

    return ingredientSignature(actual) === ingredientSignature(plannedIngredients);
  }

  function ingredientSignature(ingredients: Record<string, number>): string {
    return Object.entries(ingredients)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}=${count}`)
      .join('|');
  }

  function hasNamedIngredients(current: any, ingredients: Record<string, number>): boolean {
    return Object.entries(ingredients)
      .every(([name, count]) => availableIngredientCount(current, name) >= count);
  }

  function ingredientsForCraftCount(
    step: CraftPlanStep,
    requestedCraftCount: number,
  ): Record<string, number> {
    const totalCraftCount = Math.max(1, step.craftCount ?? Math.ceil(step.amount / step.outputPerCraft));
    return Object.fromEntries(Object.entries(step.ingredients).map(([name, count]) => [
      name,
      Math.round((count / totalCraftCount) * requestedCraftCount),
    ]));
  }

  function availableIngredientCount(current: any, ingredientName: string): number {
    return (current.inventory?.items?.() ?? []).reduce((total: number, item: any) => {
      const name = String(item?.name ?? '');
      return name === ingredientName ? total + Math.max(0, Number(item?.count ?? 1)) : total;
    }, 0);
  }

  function relaxInterchangeableMetadata(current: any, recipe: any): any {
    // 1.12 老服数据里 plank/log 配方只给了单个 metadata 变体；
    // 这些物品在游戏里可互换，放宽为任意 metadata 后交给 bot.craft 匹配。
    const interchangeableIds = new Set<number>();
    for (const name of ['planks', 'log', 'log2']) {
      const id = current.registry?.itemsByName?.[name]?.id;
      if (typeof id === 'number') interchangeableIds.add(id);
    }
    const clone = JSON.parse(JSON.stringify(recipe));
    for (const row of clone.inShape ?? []) {
      for (const entry of row) {
        if (entry && typeof entry === 'object' && interchangeableIds.has(entry.id)) entry.metadata = null;
      }
    }
    for (const entry of clone.ingredients ?? []) {
      if (entry && typeof entry === 'object' && interchangeableIds.has(entry.id)) entry.metadata = null;
    }
    return clone;
  }

  function findCraftingTable(current: any, radius: number): any | undefined {
    const block = current.registry?.blocksByName?.crafting_table;
    if (!block || typeof current.findBlocks !== 'function') return undefined;
    const positions = current.findBlocks({ matching: block.id, maxDistance: radius, count: 1 }) ?? [];
    if (!positions.length) return undefined;
    return current.blockAt(positions[0]);
  }

  function findFurnaceBlock(current: any, radius: number): any | undefined {
    const block = current.registry?.blocksByName?.furnace;
    if (!block || typeof current.findBlocks !== 'function') return undefined;
    const positions = current.findBlocks({ matching: block.id, maxDistance: radius, count: 1 }) ?? [];
    if (!positions.length) return undefined;
    return current.blockAt(positions[0]);
  }

  async function moveNearBlock(current: any, position: any, signal?: AbortSignal): Promise<void> {
    await current.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 3));
    throwIfAborted(signal);
    if (distanceToBot(current, position) > 4.5) {
      throw new Error('could not get close enough to the crafting table');
    }
  }

  function findFreePlacePosition(current: any, radius: number): Vec3 | undefined {
    const own = current.entity?.position;
    if (!own || typeof current.blockAt !== 'function') return undefined;
    const baseX = Math.floor(Number(own.x ?? 0));
    const baseY = Math.floor(Number(own.y ?? 0));
    const baseZ = Math.floor(Number(own.z ?? 0));
    const candidates: Vec3[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.abs(dx) + Math.abs(dz) < 2) continue;
        const ground = new Vec3(baseX + dx, baseY, baseZ + dz);
        const below = current.blockAt(ground);
        const above = current.blockAt(ground.offset(0, 1, 0));
        // 下方必须是实心方块（不能被放置顶掉，也不能是水/岩浆）
        if (!below || isReplaceableForPlacement(below)) continue;
        // 落点可以是空气或草丛/植物（放置会替换它们）
        if (!above || !isReplaceableForPlacement(above)) continue;
        candidates.push(ground.offset(0, 1, 0));
      }
    }
    candidates.sort((left, right) => distanceToBot(current, left) - distanceToBot(current, right));
    return candidates[0];
  }

  function craftFailure(
    code: MinecraftActionErrorCode,
    message: string,
    started: number,
    details: Record<string, unknown> = {},
  ): MinecraftActionResult {
    return {
      actionId: '',
      outcome: 'failed',
      summary: message,
      durationMs: Date.now() - started,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
      error: { code, recoverable: code !== 'unknown_item', details: { message, ...details } },
    };
  }

  async function runEquipItem(options: { item: string }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const itemName = normalizeMinecraftLookupName(options.item);
    const item = current.inventory?.items?.().find(
      (entry: any) => normalizeMinecraftLookupName(entry.name) === itemName,
    );
    if (!item) return craftFailure('missing_item', `no ${options.item} in inventory to hold or wear`, started);
    const destination = equipDestinationFor(itemName);
    await current.equip(item, destination);
    const wearing = destination !== 'hand' && destination !== 'off-hand';
    return {
      actionId: '',
      outcome: 'succeeded',
      summary: destination === 'off-hand'
        ? `holding ${item.name} in the off hand (it is raised automatically in fights)`
        : wearing ? `wearing ${item.name} on ${destination}` : `holding ${item.name}`,
      durationMs: Date.now() - started,
      inventoryDelta: {},
      worldChanges: [],
      observations: [],
    };
  }

  async function runDropItem(options: {
    item: string;
    count: number;
    player?: string;
  }): Promise<MinecraftActionResult> {
    const current = requireBot(bot);
    const started = Date.now();
    const itemName = normalizeMinecraftLookupName(options.item);
    const item = current.inventory?.items?.().find(
      (entry: any) => normalizeMinecraftLookupName(entry.name) === itemName,
    );
    if (!item) return craftFailure('missing_item', `no ${options.item} in inventory to drop`, started);
    // 数量按背包里这种东西的总数算（不止第一组）：背包满了一次丢掉几组杂物
    const total = current.inventory.items().filter((entry: any) => entry.type === item.type).reduce((sum: number, entry: any) => sum + entry.count, 0);
    const count = Math.max(1, Math.min(Math.trunc(options.count) || 1, total));
    // 只有说了给谁才走过去；丢杂物就地丢（以前不说也走到主人身边）
    const playerName = options.player?.trim();
    if (playerName) {
      const player: any = Object.values(current.players ?? {}).find(
        (entry: any) => entry.username === playerName,
      );
      const entity = player?.entity;
      if (entity) {
        try {
          await current.pathfinder.goto(
            new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2.5),
          );
        } catch {
          // 靠近失败也照常丢弃，不阻塞动作
        }
      }
    }
    // mineflayer 的 toss 一次只丢一组里的：一组一组丢，丢够为止
    let left = count;
    while (left > 0) {
      const stack = current.inventory.items().find((entry: any) => entry.type === item.type);
      if (!stack) break;
      const n = Math.min(left, stack.count);
      if (n === stack.count) await current.tossStack(stack);
      else await current.toss(stack.type, stack.metadata, n);
      left -= n;
    }
    const where = playerName ? `near ${playerName}` : 'at current position';
    return {
      actionId: '',
      outcome: 'succeeded',
      summary: `dropped ${count - left} ${item.name} ${where}`,
      durationMs: Date.now() - started,
      inventoryDelta: { [item.name]: -(count - left) },
      worldChanges: [],
      observations: [],
    };
  }

  return {
    async connect(options) {
      if (bot) {
        owner = options.owner ?? owner;
        return;
      }
      owner = options.owner;
      connection = options;
      intentionalDisconnect = false;
      everSpawned = false;
      knownCraftingTable = undefined;
      let fallbackVersion: string | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await connectOnce(options, attempt === 0 ? undefined : fallbackVersion);
          return;
        } catch (error) {
          if (attempt === 0 && isVersionDataMissingError(error)) {
            const missing = extractMissingVersion(error);
            fallbackVersion = missing ? fallbackSupportedVersion(missing) : undefined;
            if (fallbackVersion) {
              emit({
                kind: 'log',
                level: 'warn',
                message: `[connect] server version ${missing} unsupported; retrying with ${fallbackVersion}`,
              });
              continue;
            }
            if (missing && numericVersionParts(missing) && latestSupportedVersion) {
              throw new Error(
                `Minecraft 服务器版本 ${missing} 超出当前支持的版本范围（最高 ${latestSupportedVersion}）。`
                + `请把游戏切换到受支持版本（如 ${latestSupportedVersion}），或等待 minecraft-data / mineflayer 更新。`,
              );
            }
          }
          throw error;
        }
      }
    },

    async disconnect() {
      if (!bot) return;
      stopFollowSession();
      stopGazeTracking();
      const current = bot;
      intentionalDisconnect = true;
      everSpawned = false;
      knownCraftingTable = undefined;
      bot = undefined;
      current.autoEat?.disableAuto?.();
      await current.pvp?.stop?.();
      current.pathfinder?.stop?.();
      await current.collectBlock?.cancelTask?.();
      current.end('disconnected');
    },

    setOwner(player) {
      const normalized = player?.trim() || undefined;
      if (normalized && normalized.toLocaleLowerCase() === bot?.username?.toLocaleLowerCase()) {
        throw new Error('cannot follow itself');
      }
      owner = normalized;
      gazeTracker.reset();
    },

    isConnected(): boolean {
      return Boolean(bot);
    },

    status(): MinecraftStatus {
      return {
        connected: Boolean(bot),
        username: bot?.username,
        version: bot?.version,
        host: connection?.host,
        port: connection?.port,
        players: bot ? humanPlayerNames(bot) : [],
        spectators: bot ? Object.values(bot.players as Record<string, { username: string; gamemode?: number }>).filter((p) => p.gamemode === 3).map((p) => p.username) : [],
        owner,
        health: bot?.health,
        food: bot?.food,
        behavior: { kind: 'idle' },
      };
    },

    getRawObservation(ownerName?: string): MinecraftRawObservation {
      return getRawObservation(bot, connection, ownerName ?? owner);
    },

    async getSnapshot() {
      const started = Date.now();
      const snapshot = buildMinecraftSnapshot(this.getRawObservation());
      emit({
        kind: 'log',
        level: 'info',
        message: `snapshot completed in ${Date.now() - started}ms (${snapshot.nearby.blocks.length} blocks, ${snapshot.nearby.entities.length} entities)`,
      });
      return snapshot;
    },

    async say(message) {
      requireBot(bot).chat(message);
    },

    async navigateToPlayer(playerName, options) {
      const current = requireBot(bot);
      const target = current.players[playerName]?.entity;
      if (!target) throw new Error(`Minecraft player is not visible: ${playerName}`);
      if (options.dynamic) {
        current.pathfinder.setGoal(dependencies.createFollowGoal(target, options.range), true);
        return immediateNavigationResult(current, target, 'Persistent following started');
      }
      return patchedGoto(
        current,
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, options.range),
        {
          signal: options.signal,
          onProgress: (progress) => emit({
            kind: 'log',
            level: 'info',
            message: `[navigate] elapsed=${progress.elapsedMs}ms position=${formatPosition(progress.currentPos)} remaining=${progress.distanceToTarget.toFixed(1)} moved=${progress.distanceTraveled.toFixed(1)} stagnant=${progress.stagnantTicks}`,
          }),
        },
      );
    },

    async navigateToPosition(position, options) {
      const current = requireBot(bot);
      // 创造模式：远一点的地方飞过去（走路过不了海、上不了天上的房子）
      if (current.game?.gameMode === 'creative' && current.entity.position.distanceTo(new Vec3(position.x, position.y, position.z)) > 3) {
        const started = Date.now();
        const from = current.entity.position.clone();
        let flown = await flyTo(current, position, options.signal).catch((err: Error) => ({ ok: false, message: err.message }));
        // 头顶被挡着（屋里、山洞、水下）：先走到附近头顶开阔的地方再飞
        for (const spot of flown.ok ? [] : openSkySpots(current)) {
          // 屋里出不来多半是门关着：走出去这一段允许开门
          const movements = current.pathfinder.movements;
          const couldOpen = movements.canOpenDoors;
          movements.canOpenDoors = true;
          const walked = await patchedGoto(current, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal: options.signal }).finally(() => { movements.canOpenDoors = couldOpen; });
          if (!walked.ok) continue;
          flown = await flyTo(current, position, options.signal).catch((err: Error) => ({ ok: false, message: err.message }));
          break;
        }
        if (flown.ok) {
          const here = current.entity.position;
          return {
            ok: true, reason: 'success', message: flown.message,
            startPos: { x: from.x, y: from.y, z: from.z }, endPos: { x: here.x, y: here.y, z: here.z },
            distanceTraveled: from.distanceTo(here), distanceToTarget: here.distanceTo(new Vec3(position.x, position.y, position.z)),
            elapsedMs: Date.now() - started, estimatedTimeMs: 0, pathCost: 0,
            environment: { inWater: !!current.entity.isInWater, nearbyLiquids: [] },
          };
        }
        emit({ kind: 'log', level: 'warn', message: `[navigate] could not fly: ${flown.message}; walking instead` });
      }
      // 走进传送门：要踩进那一格，站着等它传过去（生存模式站 4 秒）；到了另一边就算走到了
      const portal = current.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)));
      if (portal && /_portal$/.test(portal.name)) {
        const from = String(current.game?.dimension ?? '');
        // 已经站在门里（刚传过来）：原版要先离开传送门再进去才会传，先往旁边退一步
        const feet = current.entity.position.floored();
        if (/_portal$/.test(current.blockAt(feet)?.name ?? '')) {
          const out = [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 2], [0, -2], [2, 0], [-2, 0]]
            .map(([dx, dz]) => feet.offset(dx, 0, dz))
            .find((p) => {
              const at = current.blockAt(p);
              const head = current.blockAt(p.offset(0, 1, 0));
              const ground = current.blockAt(p.offset(0, -1, 0));
              return at?.boundingBox === 'empty' && !/_portal$|lava|fire/.test(at.name) && head?.boundingBox === 'empty' && ground?.boundingBox === 'block';
            });
          if (out) {
            await patchedGoto(current, new goals.GoalBlock(out.x, out.y, out.z), { signal: options.signal });
            await delay(500, options.signal);
          }
        }
        const r = await patchedGoto(current, new goals.GoalBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)), { signal: options.signal });
        for (let waited = 0; waited < 8000 && String(current.game?.dimension ?? '') === from; waited += 250) await delay(250, options.signal);
        const crossed = String(current.game?.dimension ?? '') !== from;
        return crossed ? { ...r, ok: true, reason: 'success', message: `went through the ${portal.name.replace('_', ' ')}` } : r.ok ? { ...r, ok: false, reason: 'error', message: 'stood in the portal but it did not take her anywhere' } : r;
      }
      return patchedGoto(
        current,
        new goals.GoalNear(position.x, position.y, position.z, options.range),
        {
          signal: options.signal,
          onProgress: (progress) => emit({
            kind: 'log',
            level: 'info',
            message: `[navigate] elapsed=${progress.elapsedMs}ms position=${formatPosition(progress.currentPos)} remaining=${progress.distanceToTarget.toFixed(1)} moved=${progress.distanceTraveled.toFixed(1)} stagnant=${progress.stagnantTicks}`,
          }),
        },
      );
    },

    hide(signal) {
      return hideUnderground(requireBot(bot), signal);
    },

    swimToShore() {
      return swimToShore(requireBot(bot));
    },

    terrain(radius) {
      return scanTerrain(requireBot(bot), Math.max(8, Math.min(64, Math.round(radius))));
    },

    checkBlocks(names) {
      const current = requireBot(bot);
      const out: Record<string, string> = {};
      for (const name of names) {
        if (current.registry?.blocksByName?.[name] && current.registry?.itemsByName?.[name]) continue;
        out[name] = current.registry?.blocksByName?.[name]
          ? `${name} is a block but not an item you can hold and place`
          : unknownNameText(current, name);
      }
      return out;
    },

    async buildStructure(options) {
      const current = requireBot(bot);
      return buildStructure(current, options, {
        place: async (item, target) => { await placeBlockAt(current, item, target, 'auto', options.signal); },
        dig: (target) => digAt(current, target, options.signal, true),
        pickup: async (radius) => { await collectItemDrops(radius, options.signal); },
        progress: (text) => emit({ kind: 'build-progress', text }),
        placed: (b) => emit({ kind: 'build-placed', x: b.x, y: b.y, z: b.z, name: b.name }),
        log: (text) => emit({ kind: 'log', level: 'warn', message: text }),
      });
    },

    async farmPlot(options) {
      const current = requireBot(bot);
      return farmPlot(current, options, farmHelpers(current, options.signal));
    },

    async harvestCrops(options) {
      const current = requireBot(bot);
      return harvestCrops(current, options, farmHelpers(current, options.signal));
    },

    async breedAnimals(options) {
      return breedAnimals(requireBot(bot), options);
    },

    async shearSheep(options) {
      const current = requireBot(bot);
      return shearSheep(current, options, farmHelpers(current, options.signal));
    },

    async useBucket(options) {
      return useBucket(requireBot(bot), options);
    },

    async useOnBlock(options) {
      return useOnBlock(requireBot(bot), options);
    },

    async digAt(options) {
      return digOne(requireBot(bot), options, async (radius) => { await collectItemDrops(radius, options.signal); });
    },

    async closeStrayWindow() {
      const window = bot?.currentWindow;
      if (!window) return;
      emit({ kind: 'log', level: 'warn', message: `[window] ${window.type ?? 'a window'} was left open after an action; closing it` });
      if (window.selectedItem) await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null).catch(() => {});
      bot.closeWindow(window);
    },

    followCam(reset) {
      const current = bot;
      if (!current?.entity?.position) return null;
      if (reset) followCam.reset();
      const pos = current.entity.position;
      return followCam.step({
        now: Date.now(),
        pos: { x: pos.x, y: pos.y, z: pos.z },
        lookYaw: Number(current.entity.yaw ?? 0),
        solid: (x, y, z) => current.blockAt?.(new Vec3(x, y, z))?.boundingBox === 'block',
        // 火把、花草：没有碰撞箱，不挡视线，但镜头停在里面画面上就是一大块火把；没加载的当空的
        clutter: (x, y, z) => {
          const block = current.blockAt?.(new Vec3(x, y, z));
          return !!block && block.boundingBox !== 'block' && !CAMERA_SEE_THROUGH.has(block.name);
        },
      });
    },

    hudState() {
      if (!bot?.entity) return null;
      const slots: any[] = bot.inventory?.slots ?? [];
      const item = (i: any) => {
        if (!i) return null;
        const max = Number(i.maxDurability) || 0;
        return { name: i.name, count: i.count, ...(max ? { damage: Number(i.durabilityUsed) || 0, maxDamage: max } : {}) };
      };
      return {
        health: Number(bot.health ?? 0),
        food: Number(bot.food ?? 0),
        armor: [5, 6, 7, 8].reduce((sum, s) => sum + armorPoints(slots[s]?.name), 0),
        oxygen: Number(bot.oxygenLevel ?? 20),
        level: Number(bot.experience?.level ?? 0),
        progress: Number(bot.experience?.progress ?? 0),
        selected: Number(bot.quickBarSlot ?? 0),
        hotbar: Array.from({ length: 9 }, (_, i) => item(slots[36 + i])),
        offhand: item(slots[45]),
      };
    },

    async evadeCreeper(signal) {
      const current = requireBot(bot);
      await current.pvp?.stop?.();
      // 苦力怕爆炸半径约 3 格：跑开 10 格，5 格内没有就算躲开了
      return fleeFromHostiles(current, signal, 10, (e: any) => e?.name === 'creeper', 5);
    },

    async defendAgainst(entityId, signal) {
      const current = requireBot(bot);
      const started = Date.now();
      const entity = current.entities?.[entityId];
      if (!entity) return actionFailure('defend', 'the attacker is gone', 'target_not_found');
      const heldBefore: string | null = current.heldItem?.name ?? null;
      const weapon = await equipBestWeapon(current).catch(() => null);
      current.__inCombat = true;
      raiseShield(current);
      let killed = false;
      try {
        await current.pvp?.attack?.(entity);
        // 打死、跑开 12 格外、或者 20 秒：停
        for (let t = 0; t < 80 && !signal.aborted; t++) {
          if (!current.entities?.[entityId]) { killed = true; break; }
          if (entity.position.distanceTo(current.entity.position) > 12) break;
          await delay(250, signal).catch(() => undefined);
        }
      } finally {
        await current.pvp?.stop?.();
        current.__inCombat = false;
        lowerShield(current);
        if (weapon && heldBefore && heldBefore !== weapon) {
          const back = current.inventory?.items?.().find((i: any) => i.name === heldBefore);
          if (back) await current.equip(back, 'hand').catch(() => {});
        }
      }
      return {
        actionId: '',
        outcome: killed ? 'succeeded' : 'partial',
        summary: killed ? `killed the ${entity.name}` : `fought the ${entity.name} but it is not dead`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: [],
      };
    },

    flee(signal) {
      return fleeFromHostiles(requireBot(bot), signal);
    },

    sleep(signal) {
      return sleepInBed(requireBot(bot), signal);
    },

    async stopNavigation() {
      if (!bot) return;
      clearPathfinderGoal(bot);
      await bot.pvp?.stop?.();
    },

    async escapeToAir(): Promise<MinecraftSafetyRecovery> {
      const current = requireBot(bot);
      const fallback = lastBreathablePosition ? vector(lastBreathablePosition) : undefined;
      clearPathfinderGoal(current);
      await current.pvp?.stop?.();
      current.clearControlStates?.();

      emit({
        kind: 'log',
        level: 'warn',
        message: `[survival] surfacing from ${formatPosition(current.entity?.position)} oxygen=${Number(current.oxygenLevel ?? 0)}`,
      });
      current.setControlState?.('jump', true);
      let recovered = await waitForOxygen(current, OXYGEN_RECOVERED_LEVEL, SURFACE_ATTEMPT_MS);
      current.setControlState?.('jump', false);
      let method: MinecraftSafetyRecovery['method'] = recovered ? 'surface' : 'failed';

      if (
        !recovered
        && fallback
        && current.entity?.position
        && distanceToBot(current, fallback) <= 32
      ) {
        try {
          await withTimeout(
            current.pathfinder.goto(new goals.GoalNear(fallback.x, fallback.y, fallback.z, 1)),
            LAST_AIR_ROUTE_TIMEOUT_MS,
            () => clearPathfinderGoal(current),
          );
          current.setControlState?.('jump', true);
          recovered = await waitForOxygen(current, OXYGEN_RECOVERED_LEVEL, 2_000);
          current.setControlState?.('jump', false);
          if (recovered) method = 'last-breathable-position';
        } catch (error) {
          emit({
            kind: 'log',
            level: 'warn',
            message: `[survival] route to last breathable position failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      current.clearControlStates?.();
      const oxygen = Number(current.oxygenLevel ?? 0);
      if (recovered) oxygenEmergencyActive = false;
      return { recovered, oxygen, method };
    },

    async inspect() {
      return buildMinecraftSnapshot(this.getRawObservation());
    },

    async scanBlocks(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const started = Date.now();
      const own = current.entity?.position;
      if (!own || typeof current.blockAt !== 'function') {
        return actionFailure('scan_blocks', 'cannot scan blocks without bot position', 'adapter_error');
      }
      const scanned = scanNearbyBlocks(current, options.radius, options.verticalRadius, options.limit);
      emit({
        kind: 'log',
        level: 'info',
        message: `scan_blocks completed in ${Date.now() - started}ms (${scanned.scannedPositions} positions, ${scanned.blocks.length} block types)`,
      });
      return {
        actionId: '',
        outcome: scanned.blocks.length ? 'succeeded' : 'partial',
        summary: scanned.blocks.length
          ? `nearby blocks: ${scanned.blocks.map((block) => `${block.name} x${block.count}`).join(', ')}`
          : `no notable blocks found within ${options.radius} blocks`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: scanned.blocks.map((block, index) => ({
          id: `scan.block.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'scan.block',
          text: `${block.name} x${block.count}, nearest ${formatPosition(block.nearest.position)}, distance ${block.nearest.distance.toFixed(1)}`,
          data: {
            name: block.name,
            displayName: block.displayName,
            count: block.count,
            nearest: block.nearest,
          },
        })),
      };
    },

    async searchBlock(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const blockName = resolveCollectBlock(current, options.block, options.radius);
      if (!blockName) {
        return actionFailure('search_block', `unknown block ${options.block}`, 'adapter_error');
      }
      const block = current.registry.blocksByName[blockName];
      const positions = current.findBlocks({
        matching: block.id,
        maxDistance: options.radius,
        count: options.count,
      }) ?? [];
      const found = positions
        .map((position: any) => current.blockAt(position))
        .filter((candidate: any) => candidate?.type === block.id || candidate?.name === blockName)
        .sort((left: any, right: any) =>
          distanceToBot(current, left.position) - distanceToBot(current, right.position),
        );
      return {
        actionId: '',
        outcome: found.length ? 'succeeded' : 'partial',
        summary: found.length
          ? `found ${found.length} ${blockName}`
          : `no ${blockName} found within ${options.radius} blocks`,
        durationMs: 0,
        inventoryDelta: {},
        worldChanges: [],
        observations: found.slice(0, 8).map((candidate: any, index: number) => ({
          id: `search.block.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'search.block',
          text: `${candidate.name ?? blockName} at ${formatPosition(candidate.position)}, distance ${distanceToBot(current, candidate.position).toFixed(1)}`,
          data: {
            name: candidate.name ?? blockName,
            position: vector(candidate.position),
            distance: distanceToBot(current, candidate.position),
          },
        })),
      };
    },

    async searchEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const found = matchingEntities(current, options.entity, options.radius);
      return {
        actionId: '',
        outcome: found.length ? 'succeeded' : 'partial',
        summary: found.length
          ? `found ${found[0].name ?? options.entity} at distance ${distanceToBot(current, found[0].position).toFixed(1)}`
          : `no ${options.entity} found within ${options.radius} blocks`,
        durationMs: 0,
        inventoryDelta: {},
        worldChanges: [],
        observations: found.slice(0, 8).map((entity: any, index: number) => ({
          id: `search.entity.${index}`,
          at: Date.now(),
          severity: 'info',
          kind: 'search.entity',
          text: `${entity.name ?? options.entity} at ${formatPosition(entity.position)}, distance ${distanceToBot(current, entity.position).toFixed(1)}`,
          data: {
            name: entity.name ?? entity.displayName ?? options.entity,
            position: vector(entity.position),
            distance: distanceToBot(current, entity.position),
          },
        })),
      };
    },

    async approachEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const entity = nearestMatchingEntity(current, options.entity, options.radius);
      if (!entity) return actionFailure('approach_entity', `no ${options.entity} found within ${options.radius} blocks`, 'target_not_found');
      const started = Date.now();
      const deadline = started + (dependencies.approachTimeoutMs ?? 30_000);
      current.pathfinder.setGoal(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, options.range),
      );
      while (Date.now() < deadline) {
        if (!entityStillPresent(current, entity)) {
          return actionFailure('approach_entity', `lost sight of ${options.entity} while approaching`, 'target_not_found');
        }
        const distance = distanceToBot(current, entity.position);
        if (distance <= options.range + 0.5) {
          return {
            actionId: '',
            outcome: 'succeeded',
            summary: `approached ${entity.name ?? options.entity} to ${distance.toFixed(1)} blocks`,
            durationMs: Date.now() - started,
            inventoryDelta: {},
            worldChanges: [],
            observations: [],
          };
        }
        await delay(500);
      }
      const distance = distanceToBot(current, entity.position);
      return {
        actionId: '',
        outcome: 'partial',
        summary: `could not reach ${entity.name ?? options.entity} within ${Math.round((Date.now() - started) / 1000)}s; distance ${distance.toFixed(1)}`,
        durationMs: Date.now() - started,
        inventoryDelta: {},
        worldChanges: [],
        observations: [{
          id: `approach.timeout:${started}`,
          at: Date.now(),
          severity: 'warning',
          kind: 'approach.timeout',
          text: `Could not reach ${entity.name ?? options.entity}; distance ${distance.toFixed(1)} blocks`,
        }],
      };
    },

    async attackEntity(options): Promise<MinecraftActionResult> {
      const current = requireBot(bot);
      const started = Date.now();
      const before = inventoryCounts(current);
      const processedTargets = new Set<string>();
      const observations: MinecraftActionResult['observations'] = [];
      /** 每只死在哪（追下一只可能跑远了，最后回去捡） */
      const killedAt: Vec3[] = [];
      let confirmed = 0;
      let attacked = 0;
      const report = (level: 'info' | 'warn' | 'error', message: string) => emit({
        kind: 'log',
        level,
        message: `[${options.actionId}] combat: ${message}`,
      });

      // 先拿上最好的武器（挖矿换成镐子、封顶换成方块以后，手里常常不是剑）；打完换回原来手里的
      const heldBefore: string | null = current.heldItem?.name ?? null;
      const weapon = await equipBestWeapon(current);
      if (weapon) report('info', `holding ${weapon}${heldBefore && heldBefore !== weapon ? ` (was ${heldBefore})` : ''}`);
      // 副手有盾：一开打就举起来（靠近的路上挡箭）；pvp 插件出手前放下、砍完再举
      current.__inCombat = true;
      if (raiseShield(current)) report('info', 'shield up');
      try {
        if (options.kill && current.pvp?.attack) {
          while (confirmed < options.quantity) {
            throwIfAborted(options.signal);
            let entity = matchingEntities(current, options.entity, options.radius)
              .find((candidate: any) => !processedTargets.has(entityKey(candidate)));
            if (!entity) {
              const fallback = matchingEntities(current, options.entity, COMBAT_CHASE_RADIUS)
                .find((candidate: any) => !processedTargets.has(entityKey(candidate)));
              if (fallback) {
                report('warn', `no ${options.entity} within ${options.radius} blocks; chasing nearest at ${distanceToBot(current, fallback.position).toFixed(1)}`);
                entity = fallback;
              }
            }
            if (!entity) {
              report('warn', `no remaining ${options.entity} within ${options.radius} blocks (${confirmed}/${options.quantity} confirmed)`);
              break;
            }
            processedTargets.add(entityKey(entity));
            attacked += 1;
            report('info', `target ${attacked}: ${options.entity}#${entity.id ?? 'unknown'} at distance ${distanceToBot(current, entity.position).toFixed(1)}`);
            await current.pvp.attack(entity);
            const killed = await (dependencies.confirmEntityDeath ?? confirmEntityDeath)(
              current,
              entity,
              30_000,
              options.signal,
            );
            await current.pvp.stop?.();
            if (killed) {
              confirmed += 1;
              if (entity.position) killedAt.push(entity.position.clone());
              report('info', `confirmed ${options.entity}#${entity.id ?? 'unknown'} dead (${confirmed}/${options.quantity})`);
              continue;
            }
            report('warn', `could not confirm ${options.entity}#${entity.id ?? 'unknown'} dead; excluding target`);
            observations.push({
              id: `combat.unconfirmed.${entity.id ?? attacked}`,
              at: Date.now(),
              severity: 'warning',
              kind: 'combat.target-unconfirmed',
              text: `Could not confirm ${options.entity} target ${entity.id ?? attacked} was defeated`,
              data: { entity: options.entity, entityId: entity.id },
            });
          }
        } else {
          const entity = nearestMatchingEntity(current, options.entity, options.radius);
          if (!entity) return actionFailure('attack_entity', `no ${options.entity} found within ${options.radius} blocks`, 'target_not_found');
          await current.attack?.(entity);
          attacked = 1;
        }

        throwIfAborted(options.signal);
        report('info', `collecting drops after ${confirmed} confirmed kills`);
        // 生物死了要播完倒下的动画（约 1 秒）才掉东西：等它掉出来再去捡，不然最后一只的掉落物会被落下
        if (confirmed > 0) await delay(1200, options.signal);
        let pickedDrops = await (dependencies.collectDrops ?? collectNearbyDrops)(current, 16, options.signal);
        // 离得远的死亡地点（追后面那只跑远了）：走回去再捡一次
        for (const spot of killedAt) {
          if (current.entity.position.distanceTo(spot) <= 8) continue;
          const r = await patchedGoto(current, new goals.GoalNear(spot.x, spot.y, spot.z, 2), { signal: options.signal });
          if (r.ok) pickedDrops += await (dependencies.collectDrops ?? collectNearbyDrops)(current, 8, options.signal);
        }
        const inventoryDelta = inventoryDifference(before, inventoryCounts(current));
        const complete = options.kill ? confirmed >= options.quantity : attacked > 0;
        return {
          actionId: '',
          outcome: complete ? 'succeeded' : 'partial',
          summary: options.kill
            ? `killed ${confirmed}/${options.quantity} ${options.entity}; picked up ${pickedDrops} drops`
            : `attacked ${options.entity}`,
          durationMs: Date.now() - started,
          inventoryDelta,
          worldChanges: confirmed > 0 || attacked > 0
            ? [{ kind: 'entity_hit', name: options.entity, count: options.kill ? confirmed : attacked }]
            : [],
          observations,
        };
      } finally {
        current.__inCombat = false;
        // pvp 插件停手时不放盾：一直举着走路会慢得像潜行
        lowerShield(current);
        if (weapon && heldBefore && heldBefore !== weapon) {
          const back = current.inventory?.items?.().find((i: any) => i.name === heldBefore);
          if (back) await current.equip(back, 'hand').catch(() => {});
        }
      }
    },

    async startFollowing(player) {
      const current = requireBot(bot);
      const target = current.players[player]?.entity;
      stopFollowSession();
      followSession = {
        bot: current,
        player,
        blocked: !target,
        retryInProgress: false,
        blockedNotified: false,
        pathStuckResets: 0,
      };
      if (!target) {
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-runtime] target=${player} entity=pending; follow intent retained`,
        });
        scheduleFollowRetry(FOLLOW_RECOVERY_RETRY_MS, 'owner-entity-pending');
        return;
      }
      const distance = distanceToBot(current, target.position);
      const goal = dependencies.createFollowGoal(target, 2);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] setting goal target=${player} distance=${distance.toFixed(2)} bot=${formatPosition(current.entity?.position)} targetPos=${formatPosition(target.position)} goal=${goal?.constructor?.name ?? 'unknown'} dynamic=true`,
      });
      current.pathfinder.setGoal(goal, true);
      startFollowWatchdog(current, player);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-runtime] goal requested target=${player} moving=${Boolean(current.pathfinder?.isMoving?.())}`,
      });
      const startPosition = vector(current.entity?.position);
      for (const delayMs of [1_000, 5_000]) {
        const timer = setTimeout(() => {
          if (bot !== current) return;
          const liveTarget = current.players[player]?.entity;
          emit({
            kind: 'log',
            level: liveTarget ? 'info' : 'warn',
            message: liveTarget
              ? `[follow-runtime] probe=${delayMs}ms target=${player} distance=${distanceToBot(current, liveTarget.position).toFixed(2)} moved=${distanceBetween(startPosition, vector(current.entity?.position)).toFixed(2)} moving=${Boolean(current.pathfinder?.isMoving?.())}`
              : `[follow-runtime] probe=${delayMs}ms target=${player} visible=false moving=${Boolean(current.pathfinder?.isMoving?.())}`,
          });
        }, delayMs);
        timer.unref?.();
      }
    },

    async stopForeground() {
      if (!bot) return;
      stopFollowSession();
      clearPathfinderGoal(bot);
      await bot.collectBlock?.cancelTask?.();
      await bot.pvp?.stop?.();
    },

    resolveBlock(name) {
      if (!bot) return null;
      const normalized = normalizeMinecraftLookupName(name);
      if (GENERIC_TREE_NAMES.has(normalized)) return nearestVisibleLogName(bot, 16);
      if (bot.registry?.blocksByName?.[normalized]) return normalized;
      if (normalized === 'sugar_cane' && bot.registry?.blocksByName?.reeds) return 'reeds';
      return null;
    },

    async collect(request: CollectionRequest) {
      const result = await collectBlocks(request);
      return result.total;
    },

    async collectItem(options): Promise<MinecraftActionResult> {
      return runCollectItem(options);
    },

    async craftItem(options): Promise<MinecraftActionResult> {
      return runCraftItem(options);
    },

    async smeltItem(options): Promise<MinecraftActionResult> {
      return runSmeltItem(options);
    },

    async equipItem(options): Promise<MinecraftActionResult> {
      return runEquipItem(options);
    },

    async dropItem(options): Promise<MinecraftActionResult> {
      return runDropItem(options);
    },

    async placeBlockItem(options): Promise<MinecraftActionResult> {
      return runPlaceBlock(options);
    },

    async pickupDrops(options): Promise<MinecraftActionResult> {
      const started = Date.now();
      const { found, picked, inventoryDelta } = await collectItemDrops(options.radius);
      return {
        actionId: '',
        outcome: found === 0 || picked > 0 ? 'succeeded' : 'partial',
        summary: picked > 0
          ? `picked up ${picked} dropped item${picked === 1 ? '' : 's'}`
          : found === 0
            ? `no dropped items within ${options.radius} blocks`
            : `could not pick up ${found} dropped item${found === 1 ? '' : 's'}`,
        durationMs: Date.now() - started,
        inventoryDelta,
        worldChanges: picked > 0 ? [{ kind: 'item_picked_up', name: 'item', count: picked }] : [],
        observations: [],
      };
    },

    configurePolicies(handlers) {
      policyHandlers = handlers;
    },
  };
}

function getRawObservation(
  bot: any,
  connection: MinecraftConnectionOptions | undefined,
  owner: string | undefined,
): MinecraftRawObservation {
  const connected = Boolean(bot);
  const ownerEntity = connected && owner ? bot.players?.[owner]?.entity : undefined;
  return {
    capturedAt: Date.now(),
    connection: {
      connected,
      username: bot?.username,
      host: connection?.host,
      port: connection?.port,
    },
    world: connected ? worldSnapshot(bot) : undefined,
    body: connected ? bodySnapshot(bot) : undefined,
    owner: owner
      ? {
          name: owner,
          visible: Boolean(ownerEntity),
          distance: ownerEntity ? distanceToBot(bot, ownerEntity.position) : undefined,
          relativeDirection: ownerEntity ? relativeDirection(bot, ownerEntity.position) : undefined,
        }
      : undefined,
    follow: { phase: 'inactive' },
    nearbyBlocks: [],
    nearbyEntities: connected ? visibleEntities(bot) : [],
    recentEvents: [],
  };
}

function worldSnapshot(bot: any): MinecraftRawObservation['world'] {
  return {
    dimension: bot.game?.dimension ?? bot.dimension ?? 'unknown',
    timeOfDay: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : undefined,
    weather: bot.isRaining ? 'rain' : 'clear',
  };
}

function bodySnapshot(bot: any): MinecraftRawObservation['body'] {
  return {
    position: vector(bot.entity?.position),
    health: bot.health ?? 0,
    food: bot.food ?? 0,
    oxygen: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : undefined,
    inWater: !!bot.entity?.isInWater,
    inventory: inventoryCounts(bot),
  };
}

function inventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    const name = item.name ?? String(item.type);
    counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
  }
  return counts;
}

function resolveCollectBlock(bot: any, name: string, radius: number): string | null {
  const normalized = normalizeMinecraftLookupName(name);
  if (bot.registry?.blocksByName?.[normalized]) return normalized;
  if (GENERIC_TREE_NAMES.has(normalized) || isLogLikeName(normalized)) return nearestVisibleLogName(bot, radius);
  if (normalized === 'sugar_cane' && bot.registry?.blocksByName?.reeds) return 'reeds';
  return null;
}

function normalizeMinecraftLookupName(name: string): string {
  return name.trim().toLowerCase().replace(/^minecraft\s*[: ]\s*/, '').replace(/[\s-]+/g, '_');
}

async function waitForServerInventoryBarrier(
  bot: any,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const client = bot?._client;
  if (!client?.write || !client?.once || !client?.off) {
    throw createCraftError('inventory_desync', 'Minecraft client cannot confirm server inventory state');
  }
  await new Promise<void>((resolve, reject) => {
    const onStatistics = () => finish(resolve);
    const onAbort = () => finish(() => reject(abortError()));
    const timeout = setTimeout(() => finish(() => reject(createCraftError(
      'inventory_desync',
      'Minecraft server did not confirm the inventory transaction',
    ))), 5_000);
    const finish = (done: () => void): void => {
      clearTimeout(timeout);
      client.off('statistics', onStatistics);
      signal?.removeEventListener('abort', onAbort);
      done();
    };
    client.once('statistics', onStatistics);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // REQUEST_STATS is handled on the server's main thread. Its response is
      // the causal boundary for all earlier inventory clicks on this connection.
      client.write('client_command', { actionId: 1 });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function immediateNavigationResult(current: any, target: any, message: string): PathfindResult {
  const position = current.entity.position;
  return {
    ok: true,
    reason: 'success',
    message,
    startPos: vector(position),
    endPos: vector(position),
    distanceTraveled: 0,
    distanceToTarget: distanceToBot(current, target.position),
    elapsedMs: 0,
    estimatedTimeMs: 0,
    pathCost: 0,
    environment: {
      inWater: false,
      oxygen: Number(current.oxygenLevel ?? 20),
      nearbyLiquids: [],
    },
  };
}

// equip 自动判断落点：盔甲按部位穿到对应护甲槽，其余物品切换手持。
// 规则基于物品名后缀，跨版本通用（不依赖具体版本的物品注册表）。
/**
 * 背包满了吗（36 格都占了，也没有一格同种东西还能叠上去）：满了返回给她看的说明（占地方最多的几样、怎么丢），没满返回 null。
 * 要采的东西掉出来是别的（diamond_ore 掉 diamond）：item 填掉出来的那个
 */
function inventoryFullText(bot: any, item: string): string | null {
  const inventory = bot.inventory;
  if (!inventory) return null;
  const empty = typeof inventory.emptySlotCount === 'function' ? inventory.emptySlotCount() : 36 - (inventory.items?.().length ?? 0);
  if (empty > 0) return null;
  const items: any[] = inventory.items?.() ?? [];
  if (items.some((i) => i.name === item && i.count < (i.stackSize ?? 64))) return null;
  const totals = new Map<string, { count: number; slots: number }>();
  for (const i of items) {
    if (i.maxDurability) continue; // 工具、武器、盔甲不算杂物
    const t = totals.get(i.name) ?? { count: 0, slots: 0 };
    t.count += i.count;
    t.slots += 1;
    totals.set(i.name, t);
  }
  const biggest = [...totals.entries()].sort((a, b) => b[1].slots - a[1].slots || b[1].count - a[1].count).slice(0, 5);
  const list = biggest.map(([name, t]) => `${name} ×${t.count} (${t.slots} slots)`).join(', ');
  return `the inventory is full (all 36 slots used), so nothing new can be picked up. Taking the most room: ${list}. Throw away what you do not need with drop (e.g. drop ${biggest[0]?.[0] ?? 'cobblestone'} 64), then try again`;
}

/**
 * 打会射箭的怪时盾才有用：pvp 插件每次出手前放下盾、砍完 150 毫秒再举，盾举起要 5 刻（0.25 秒）才挡得住，
 * 两次出手之间几乎一直是空档；骷髅贴脸也射箭，正好射在空档里（测试：带盾比不带盾掉血还多）。
 * 改成真人的打法：目标在拉弓（living_entity_flags 最低位：手正在用），盾举着不放、先不砍，射完了再出手。
 * 举没举由这里自己记：已经举着再发一次「举」，服务器会把那 5 刻重新算；mineflayer 自己的 usingHeldItem 会被别的实体的状态包清掉，靠不住
 */
function tunePvpShield(bot: any): void {
  const pvp = bot.pvp;
  if (!pvp || pvp.__shieldTuned || typeof pvp.attemptAttack !== 'function') return;
  pvp.__shieldTuned = true;
  let raised = false;
  let loweredAt = 0;
  const activate = bot.activateItem.bind(bot);
  const deactivate = bot.deactivateItem.bind(bot);
  bot.activateItem = (offHand = false) => {
    raised = !!offHand;
    bot.__shieldRaisedAt = raised ? Date.now() : 0;
    return activate(offHand);
  };
  bot.deactivateItem = () => {
    raised = false;
    loweredAt = Date.now();
    bot.__shieldRaisedAt = 0;
    return deactivate();
  };
  // 在打（打怪、还手的整个动作里，包括换下一只的空档）、副手有盾、盾没举着、也不是正在出手（放下不到 0.4 秒）：举起来。
  // pvp 插件出手那一串里目标一死就抛错退出，最后「再举起来」那步不做，盾就一直放着去追下一只
  bot.on('physicsTick', () => {
    if (!(pvp.target || bot.__inCombat) || raised || Date.now() - loweredAt < 400 || !pvp.hasShield()) return;
    bot.activateItem(true);
  });
  const flagsIndex = bot.registry?.entitiesByName?.skeleton?.metadataKeys?.indexOf?.('living_entity_flags') ?? 8;
  const drawing = (entity: any) => (Number(entity?.metadata?.[flagsIndex] ?? 0) & 1) === 1;
  const attempt = pvp.attemptAttack.bind(pvp);
  pvp.attemptAttack = function attemptAttackWithShield(this: any) {
    if (this.target && this.wasInRange && this.hasShield() && drawing(this.target)) {
      if (!raised) bot.activateItem(true);
      this.timeToNextAttack = 2;
      return;
    }
    return attempt();
  };
}

/** 挖过的那几格周围 3 格内还剩的同样方块（「x y z」，近的在前，去重） */
function veinLeftovers(bot: any, minedAt: Vec3[], names: string[]): string[] {
  if (!minedAt.length) return [];
  const wanted = new Set(names);
  const seen = new Set<string>();
  const found: { key: string; d: number }[] = [];
  for (const at of minedAt) {
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
      const p = at.offset(dx, dy, dz);
      const key = `${p.x} ${p.y} ${p.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (wanted.has(bot.blockAt(p)?.name)) found.push({ key, d: bot.entity.position.distanceTo(p) });
    }
  }
  return found.sort((a, b) => a.d - b.d).map((f) => f.key);
}

/** 副手是盾就举起来（返回举没举） */
function raiseShield(bot: any): boolean {
  const off = bot.inventory?.slots?.[45];
  if (!off || off.name !== 'shield') return false;
  // 已经举着就不再发：再发一次服务器会把举盾生效的那 5 刻重新算
  if (!bot.__shieldRaisedAt) bot.activateItem?.(true);
  return true;
}

/** 放下手里在用的（举着的盾）；副手不是盾就不动 */
function lowerShield(bot: any): void {
  if (bot.inventory?.slots?.[45]?.name === 'shield') bot.deactivateItem?.();
}

/** 打怪用的武器，好的在前：剑比斧子出手快，先挑剑；没有剑才用斧子 */
const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe', 'trident',
];

/** 背包里最好的武器拿到手上（已经拿着就不换）；没有武器返回 null */
async function equipBestWeapon(bot: any): Promise<string | null> {
  const items: any[] = bot.inventory?.items?.() ?? [];
  const best = WEAPONS.map((name) => items.find((i) => i.name === name)).find(Boolean);
  if (!best) return null;
  if (bot.heldItem?.name !== best.name) await bot.equip(best, 'hand');
  return best.name;
}

function equipDestinationFor(itemName: string): 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' {
  const name = normalizeMinecraftLookupName(itemName);
  // 盾牌放副手：主手照样拿剑、镐子；打怪时 pvp 插件看副手有盾就会用（出手前放下、砍完举起）
  if (name === 'shield') return 'off-hand';
  if (name.endsWith('_helmet') || name === 'pumpkin' || name === 'carved_pumpkin') return 'head';
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  return 'hand';
}

function isVersionDataMissingError(error: unknown): boolean {
  return error instanceof Error && /No data available for version/.test(error.message);
}

function extractMissingVersion(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /No data available for version (\S+)/.exec(error.message);
  return match?.[1];
}

function fallbackSupportedVersion(target: string): string | undefined {
  const targetParts = numericVersionParts(target);
  const latestParts = numericVersionParts(latestSupportedVersion ?? '');
  if (!targetParts || !latestParts) return undefined;
  // 只有同主版本（如 1.21.9 → 1.21.8）的次版本升级才值得回退；
  // 跨大版本（如 26.x → 1.21.x）协议必然不兼容，不要猜测。
  if (compareVersionParts(targetParts, latestParts) <= 0) return undefined;
  if (targetParts[0] !== latestParts[0]) return undefined;
  return latestSupportedVersion;
}

function numericVersionParts(version: string): number[] | undefined {
  if (!/^\d+(\.\d+)*$/.test(version)) return undefined;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : undefined;
}

function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function deriveDropItemForBlock(bot: any, blockName: string): string | undefined {
  const block = bot.registry?.blocksByName?.[blockName];
  if (!block) return undefined;
  const drops = blockDropIds(block);
  if (drops.length === 0) return KNOWN_BLOCK_DROPS[blockName] ?? blockName;
  const nameById = new Map<number, string>();
  for (const [name, item] of Object.entries(bot.registry?.itemsByName ?? {})) {
    if (typeof (item as any)?.id === 'number') nameById.set((item as any).id, name);
  }
  const names = drops.map((id) => nameById.get(id)).filter(Boolean) as string[];
  return names.find((name) => name === blockName)
    ?? names[0]
    ?? KNOWN_BLOCK_DROPS[blockName]
    ?? blockName;
}

/**
 * 把方块掉落表统一归一化成物品 id 数组。
 *
 * minecraft-data 的 drops 格式随版本不同：
 *   - 1.8-1.12（扁平化前）：[{ drop: <id | {id, metadata}> }, ...]
 *   - 1.13+（扁平化后）：[id, ...]
 * 只取“掉落物物品 id”这一语义，与版本表示无关，因此不会因改名/改格式失效。
 */
function blockDropIds(block: any): number[] {
  const drops = Array.isArray(block?.drops) ? block.drops : [];
  const ids: number[] = [];
  for (const entry of drops) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      ids.push(entry);
    } else if (entry && typeof entry === 'object') {
      const drop = (entry as any).drop;
      if (typeof drop === 'number' && Number.isFinite(drop)) {
        ids.push(drop);
      } else if (drop && typeof drop === 'object' && typeof drop.id === 'number') {
        ids.push(drop.id);
      } else if (typeof (entry as any).id === 'number') {
        ids.push((entry as any).id);
      }
    }
  }
  return ids;
}

/**
 * 按概率掉的东西：minecraft-data 的掉落表只列方块的「本体掉落」，这些不在里面（砍草出种子、挖沙砾出燧石、树叶出树苗和苹果……）。
 * 和掉落表查出来的来源合在一起；不在这个版本里的方块名自动跳过
 */
const CHANCE_DROP_SOURCES: Record<string, string[]> = {
  // 老版本（1.11.2）里 'grass' 是实心草方块，不产种子：只取非实心的草株
  wheat_seeds: ['short_grass', 'tall_grass', 'grass', 'tallgrass', 'fern', 'large_fern', 'double_plant'],
  flint: ['gravel'],
  apple: ['oak_leaves', 'dark_oak_leaves'],
  string: ['cobweb'],
  glowstone_dust: ['glowstone'],
  melon_slice: ['melon'],
};

function chanceDropSources(bot: any, itemName: string): string[] {
  const blocksByName = bot.registry?.blocksByName ?? {};
  // 树苗：同名的树叶（oak_sapling ← oak_leaves）
  const leaves = itemName.endsWith('_sapling') ? [itemName.replace(/_sapling$/, '_leaves')] : [];
  return [...(CHANCE_DROP_SOURCES[itemName] ?? []), ...leaves].filter((name) => {
    const block = blocksByName[name];
    return block && !(itemName === 'wheat_seeds' && block.boundingBox === 'block');
  });
}

function sourceBlocksForItem(bot: any, itemName: string): string[] {
  const registry = bot.registry;
  const item = registry?.itemsByName?.[itemName];
  const blocks = item
    ? Object.entries(registry?.blocksByName ?? {})
        .filter(([, block]) => blockDropIds(block as any).includes(item.id))
        .map(([name]) => name)
        .filter((name) => name !== 'air' && name !== 'cave_air' && name !== 'void_air')
    : [];
  return [...new Set([...blocks, ...chanceDropSources(bot, itemName)])];
}

function nearestVisibleLogName(bot: any, radius: number): string | null {
  const blocksByName = bot.registry?.blocksByName ?? {};
  let best: { name: string; distance: number } | undefined;
  for (const name of availableLogBlockNames(blocksByName)) {
    const block = blocksByName[name];
    if (!block || typeof bot.findBlocks !== 'function') continue;
    const positions = bot.findBlocks({ matching: block.id, maxDistance: radius, count: 8 }) ?? [];
    for (const position of positions) {
      const liveBlock = typeof bot.blockAt === 'function' ? bot.blockAt(position) : undefined;
      if (liveBlock?.type !== undefined && liveBlock.type !== block.id) continue;
      const distance = distanceToBot(bot, position);
      if (!best || distance < best.distance) best = { name, distance };
    }
  }
  return best?.name ?? firstAvailableLogName(blocksByName);
}

function firstAvailableLogName(blocksByName: Record<string, unknown>): string | null {
  return availableLogBlockNames(blocksByName)[0] ?? null;
}

interface ScannedBlockGroup {
  name: string;
  displayName?: string;
  count: number;
  nearest: {
    position: { x: number; y: number; z: number };
    distance: number;
  };
}

function scanNearbyBlocks(
  bot: any,
  radius: number,
  verticalRadius: number,
  limit: number,
): { scannedPositions: number; blocks: ScannedBlockGroup[] } {
  const own = bot.entity.position;
  const groups = new Map<string, ScannedBlockGroup>();
  let scannedPositions = 0;

  for (const [dx, dy, dz] of scanOffsets(radius, verticalRadius)) {
    if (scannedPositions >= MAX_SCAN_BLOCK_POSITIONS) break;
    scannedPositions += 1;
    const position = offset(own, dx, dy, dz);
    const block = bot.blockAt(position);
    if (!isNotableScannedBlock(block)) continue;
    const name = String(block.name ?? block.type);
    const distance = distanceToBot(bot, block.position ?? position);
    const existing = groups.get(name);
    if (!existing) {
      groups.set(name, {
        name,
        displayName: block.displayName,
        count: 1,
        nearest: {
          position: vector(block.position ?? position),
          distance,
        },
      });
      continue;
    }
    existing.count += 1;
    if (distance < existing.nearest.distance) {
      existing.nearest = {
        position: vector(block.position ?? position),
        distance,
      };
    }
  }

  return {
    scannedPositions,
    blocks: [...groups.values()]
      .sort((left, right) => blockScanPriority(left.name) - blockScanPriority(right.name) ||
        left.nearest.distance - right.nearest.distance ||
        right.count - left.count ||
        left.name.localeCompare(right.name))
      .slice(0, limit),
  };
}

function scanOffsets(radius: number, verticalRadius: number): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if ((dx * dx) + (dz * dz) > radius * radius) continue;
        offsets.push([dx, dy, dz]);
      }
    }
  }
  return offsets.sort((left, right) => offsetDistanceSquared(left) - offsetDistanceSquared(right));
}

function offsetDistanceSquared([x, y, z]: [number, number, number]): number {
  return x * x + y * y + z * z;
}

function isNotableScannedBlock(block: any): boolean {
  if (!block) return false;
  const name = String(block.name ?? '');
  if (!name || AIR_BLOCK_NAMES.has(name)) return false;
  if (typeof block.type === 'number' && block.type === 0) return false;
  return true;
}

function blockScanPriority(name: string): number {
  if (isLogLikeName(name)) return 0;
  if (name.includes('leaves')) return 1;
  if (name.includes('ore')) return 2;
  if (name.includes('reeds') || name.includes('sugar_cane')) return 3;
  if (name.includes('crop') || name.includes('wheat') || name.includes('carrot') || name.includes('potato')) return 4;
  if (name.includes('chest') || name.includes('crafting') || name.includes('furnace')) return 5;
  return 10;
}

function availableLogBlockNames(blocksByName: Record<string, unknown>): string[] {
  const known = LOG_BLOCK_NAMES.filter((name) => blocksByName[name]);
  const dynamic = Object.keys(blocksByName)
    .filter((name) => isLogLikeName(name))
    .sort((left, right) => logNamePriority(left) - logNamePriority(right) || left.localeCompare(right));
  return [...new Set([...known, ...dynamic])];
}

function isLogLikeName(name: string): boolean {
  return (
    name === 'log' ||
    name === 'log2' ||
    name.endsWith('_log') ||
    name.endsWith('_stem') ||
    name.endsWith('_wood') ||
    name.endsWith('_hyphae')
  );
}

function logNamePriority(name: string): number {
  if (name === 'oak_log') return 0;
  if (name.endsWith('_log')) return 1;
  if (name === 'log' || name === 'log2') return 2;
  if (name.endsWith('_stem')) return 3;
  return 4;
}

function visibleEntities(bot: any): MinecraftObservedEntity[] {
  return Object.values(bot.entities ?? {})
    .filter((entity: any) => entity !== bot.entity && entity?.position)
    .map((entity: any) => {
      const entityName = observedEntityName(entity);
      const type = observedEntityType(entity);
      return {
        name: entityName,
        type,
        position: vector(entity.position),
        distance: distanceToBot(bot, entity.position),
        hostile: HOSTILE_MOBS.has(normalizeEntityName(entity.name ?? entity.displayName ?? entityName) ?? ''),
      };
    });
}

function matchingEntities(bot: any, name: string, radius: number): any[] {
  const normalized = normalizeEntityName(name);
  return Object.values(bot.entities ?? {})
    .filter((entity: any) => entity !== bot.entity && entity?.position)
    .filter((entity: any) => entityMatches(entity, normalized))
    .filter((entity: any) => distanceToBot(bot, entity.position) <= radius)
    .sort((left: any, right: any) => distanceToBot(bot, left.position) - distanceToBot(bot, right.position));
}

function nearestMatchingEntity(bot: any, name: string, radius: number): any | undefined {
  return matchingEntities(bot, name, radius)[0];
}

function entityMatches(entity: any, normalized: string | undefined): boolean {
  if (!normalized) return false;
  return [
    entity.name,
    entity.displayName,
    entity.username,
    entity.type,
  ]
    .map(normalizeEntityName)
    .some((value) => value === normalized);
}

/** 「这个版本里没有叫 X 的东西」加上相近的名字（含有这个词的物品 / 方块，短的、整词对上的排前面） */
function unknownNameText(bot: any, name: string): string {
  const names = new Set([...Object.keys(bot.registry?.itemsByName ?? {}), ...Object.keys(bot.registry?.blocksByName ?? {})]);
  const words = name.split('_').filter((w) => w.length >= 3);
  const score = (candidate: string): number => {
    const parts = candidate.split('_');
    if (candidate.includes(name)) return 3;
    const hits = words.filter((w) => parts.includes(w)).length;
    return hits === words.length && hits > 0 ? 2 : hits > 0 ? 1 : 0;
  };
  const similar = [...names]
    .map((n) => ({ n, s: score(n) }))
    .filter((c) => c.s > 0 && !c.n.includes('air'))
    .sort((a, b) => b.s - a.s || a.n.length - b.n.length)
    .slice(0, 8)
    .map((c) => c.n);
  return `no item or block is called "${name}" in Minecraft ${bot.version ?? ''}${similar.length ? `; similar names: ${similar.join(', ')}` : ''}`;
}

function actionFailure(
  actionId: string,
  message: string,
  code: MinecraftActionErrorCode,
): MinecraftActionResult {
  return {
    actionId,
    outcome: 'failed',
    summary: message,
    durationMs: 0,
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
    error: { code, recoverable: true, details: { message } },
  };
}

function observedEntityName(entity: any): string {
  if (entity.item?.name) return entity.item.name;
  if (entity.metadata?.item?.name) return entity.metadata.item.name;
  if (entity.displayName && entity.name === 'item') return entity.displayName;
  return entity.username ?? normalizeEntityName(entity.name ?? entity.displayName) ?? entity.type ?? 'unknown';
}

function observedEntityType(entity: any): string {
  const name = normalizeEntityName(entity.name);
  const displayName = normalizeEntityName(entity.displayName);
  if (entity.item || entity.metadata?.item || name === 'item' || name === 'item_stack' || displayName === 'item') {
    return 'item';
  }
  return entity.type ?? 'unknown';
}

function normalizeEntityName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function vector(position: any): { x: number; y: number; z: number } {
  return {
    x: Number(position?.x ?? 0),
    y: Number(position?.y ?? 0),
    z: Number(position?.z ?? 0),
  };
}

function formatPosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(0)},${value.y.toFixed(0)},${value.z.toFixed(0)}`;
}

function formatPrecisePosition(position: any): string {
  const value = vector(position);
  return `${value.x.toFixed(2)},${value.y.toFixed(2)},${value.z.toFixed(2)}`;
}

function formatPositionDelta(from: any, to: any): string {
  const start = vector(from);
  const end = vector(to);
  return `${(end.x - start.x).toFixed(2)},${(end.y - start.y).toFixed(2)},${(end.z - start.z).toFixed(2)}`;
}

async function confirmEntityDeath(
  bot: any,
  entity: any,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!entityStillPresent(bot, entity)) return true;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poll = setInterval(() => {
      if (!entityStillPresent(bot, entity)) finish(true);
    }, 200);
    const onTerminal = (candidate: any) => {
      if (sameEntity(candidate, entity)) finish(true);
    };
    const onAbort = () => finish(abortError());
    const finish = (value: boolean | Error) => {
      clearTimeout(timer);
      clearInterval(poll);
      bot.removeListener('entityDead', onTerminal);
      bot.removeListener('entityGone', onTerminal);
      signal?.removeEventListener('abort', onAbort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    bot.on('entityDead', onTerminal);
    bot.on('entityGone', onTerminal);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function collectNearbyDrops(bot: any, radius: number, signal?: AbortSignal): Promise<number> {
  const { picked } = await walkPickupDrops(bot, radius, signal);
  return picked;
}

async function gotoWithin(bot: any, goal: any, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bot.pathfinder.goto(goal).then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          try { bot.pathfinder.setGoal(null); } catch { /* 已经停了 */ }
          resolve(false);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 走到捡得到这个掉落物的地方：原版里物品碰到玩家身体往外扩一格（上下半格）的范围就吸过来，不用站到它上面
 * （这里每边少算一点余量）。以前的目标是「站到它那里」：东西挂在矿道里还没挖的那格上面时，寻路器会把矿道顶挖开、
 * 爬上去站，人就钻进了石头里。
 * 高度按她的脚实际在哪算：站在耕地、土径、灵魂沙、下半砖这类不满一格的方块上，寻路器的格子往下取整，
 * 脚其实高了将近一格（耕地上差 15/16）；不算上的话，她站在耕地上就以为够得着坑底的土，一步不动，土吸不过来
 */
class GoalPickup extends goals.Goal {
  constructor(
    private readonly bot: any,
    private readonly at: { x: number; y: number; z: number },
  ) {
    super();
  }

  heuristic(node: any): number {
    return Math.hypot(node.x + 0.5 - this.at.x, node.y - this.at.y, node.z + 0.5 - this.at.z);
  }

  isEnd(node: any): boolean {
    const feet = node.y + partialHeight(this.bot.blockAt?.(new Vec3(node.x, node.y, node.z)));
    return Math.abs(node.x + 0.5 - this.at.x) <= 1.2
      && Math.abs(node.z + 0.5 - this.at.z) <= 1.2
      && this.at.y >= feet - 0.6
      && this.at.y <= feet + 2.0;
  }
}

/** 这一格里站得上去的不满一格的方块有多高（耕地 15/16、下半砖 1/2）；空的、满格的都是 0 */
function partialHeight(block: any): number {
  if (!block || block.boundingBox !== 'block') return 0;
  const top = Math.max(0, ...((block.shapes ?? []) as number[][]).map((s) => s[4]));
  return top > 0 && top < 1 ? top : 0;
}

async function walkPickupDrops(
  bot: any,
  radius: number,
  signal?: AbortSignal,
): Promise<{ found: number; picked: number; inventoryDelta: Record<string, number> }> {
  const before = inventoryCounts(bot);
  // 每个掉落物最多走两趟：第一趟时它可能还在往下掉（落进刚挖的坑里），落定以后再按新位置走一趟
  const attempts = new Map<string, number>();
  let picked = 0;
  let found = 0;
  let rescanned = false;
  for (let index = 0; index < 32; index += 1) {
    throwIfAborted(signal);
    const item = matchingEntities(bot, 'item', radius).find(
      (candidate) => (attempts.get(entityKey(candidate)) ?? 0) < 2,
    );
    if (!item) {
      // 刚挖掉、刚打死的东西可能还没掉出来：再等一下看一次
      if (rescanned) break;
      rescanned = true;
      await delay(800, signal);
      continue;
    }
    const tries = attempts.get(entityKey(item)) ?? 0;
    if (!tries) found += 1;
    attempts.set(entityKey(item), tries + 1);
    const goal = new GoalPickup(bot, item.position);
    // 先算一遍路：只有半截路（走不到）的不追——寻路器照样会顺着半截路往那边走，在平台边、悬崖边就走下去了
    const plan = bot.pathfinder.getPathTo?.(bot.pathfinder.movements, goal, 2000);
    if (plan && plan.status !== 'success') continue;
    // 走不过去的（寻路器找不到路时会一直挂着，不报错）8 秒就算了，不让捡东西卡住整个动作
    if (!(await gotoWithin(bot, goal, 8_000))) continue;
    if (await waitForItemPickup(bot, item, signal)) picked += 1;
  }
  return { found, picked, inventoryDelta: inventoryDifference(before, inventoryCounts(bot)) };
}

async function waitForItemPickup(bot: any, item: any, signal?: AbortSignal): Promise<boolean> {
  for (let index = 0; index < 10; index += 1) {
    throwIfAborted(signal);
    if (!entityStillPresent(bot, item)) return true;
    await delay(200, signal);
  }
  return !entityStillPresent(bot, item);
}

function inventoryDifference(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const difference: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[name] ?? 0) - (before[name] ?? 0);
    if (delta !== 0) difference[name] = delta;
  }
  return difference;
}

function entityStillPresent(bot: any, entity: any): boolean {
  return Object.values(bot.entities ?? {}).some((candidate: any) => sameEntity(candidate, entity));
}

function sameEntity(left: any, right: any): boolean {
  return left === right || (left?.id !== undefined && left.id === right?.id);
}

function entityKey(entity: any): string {
  return entity?.id !== undefined ? `id:${entity.id}` : `pos:${formatPosition(entity?.position)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function distanceToBot(bot: any, position: any): number {
  const own = bot.entity?.position;
  if (!own || !position) return Number.POSITIVE_INFINITY;
  if (typeof own.distanceTo === 'function') return own.distanceTo(position);
  const x = Number(own.x ?? 0) - Number(position.x ?? 0);
  const y = Number(own.y ?? 0) - Number(position.y ?? 0);
  const z = Number(own.z ?? 0) - Number(position.z ?? 0);
  return Math.sqrt(x * x + y * y + z * z);
}

function distanceBetween(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return Math.sqrt(x * x + y * y + z * z);
}

function clearPathfinderGoal(bot: any): void {
  if (typeof bot?.pathfinder?.setGoal === 'function') {
    bot.pathfinder.setGoal(null);
    return;
  }
  bot?.pathfinder?.stop?.();
}

function relativeDirection(bot: any, position: any): string {
  const own = bot.entity?.position;
  if (!own || !position) return 'unknown';
  const dx = Number(position.x ?? 0) - Number(own.x ?? 0);
  const dz = Number(position.z ?? 0) - Number(own.z ?? 0);
  const eastWest = Math.abs(dx) < 1 ? '' : dx > 0 ? 'east' : 'west';
  const northSouth = Math.abs(dz) < 1 ? '' : dz > 0 ? 'south' : 'north';
  return [northSouth, eastWest].filter(Boolean).join('-') || 'nearby';
}

async function collectSugarCane(
  bot: any,
  request: CollectionRequest,
  blockId: number,
): Promise<number> {
  const positions = bot.findBlocks({
    matching: blockId,
    maxDistance: request.radius,
    count: Math.min(request.quantity * 3, 192),
  });
  const candidates = positions
    .map((position: any) => bot.blockAt(position))
    .filter((block: any) => block?.type === blockId)
    .sort((left: any, right: any) => {
      const distance = horizontalDistanceSquared(left.position, bot.entity.position) -
        horizontalDistanceSquared(right.position, bot.entity.position);
      return distance || right.position.y - left.position.y;
    });

  let collected = 0;
  const cancel = () => clearPathfinderGoal(bot);
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (const candidate of candidates) {
      if (collected >= request.quantity) break;
      if (request.signal.aborted) throw abortError();

      let liveBlock = bot.blockAt(candidate.position);
      if (liveBlock?.type !== blockId) continue;
      if (!bot.canDigBlock(liveBlock)) {
        await bot.pathfinder.goto(
          new goals.GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 3),
        );
        liveBlock = bot.blockAt(candidate.position);
      }
      if (liveBlock?.type !== blockId || !bot.canDigBlock(liveBlock)) continue;

      await bot.dig(liveBlock, true);
      collected += 1;
    }
    return collected;
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}

/** 跟拍镜头能停在里面的方块 */
const CAMERA_SEE_THROUGH = new Set(['air', 'cave_air', 'void_air', 'water', 'bubble_column', 'light']);

/**
 * mineflayer 4.39 收到任何实体的 entity_metadata，只要带 air_supply 就写进 bot.oxygenLevel（entities.js 没核对是不是她自己），
 * 旁边的鱿鱼、溺尸、别的玩家在水里憋气，她的氧气就跟着掉，在岸上也会被当成要淹死。
 * 只让她自己那条包写进来：包先经过这里记下是谁的，mineflayer 再写的时候不是她就不收（'breath' 事件照发，读到的是她的真实值）
 */
export function guardOwnOxygen(bot: any): void {
  const client = bot?._client;
  if (typeof client?.prependListener !== 'function') return;
  let ownPacket = false;
  let oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;
  client.prependListener('entity_metadata', (packet: any) => {
    ownPacket = bot.entity?.id != null && packet?.entityId === bot.entity.id;
  });
  Object.defineProperty(bot, 'oxygenLevel', {
    configurable: true,
    enumerable: true,
    get: () => oxygen,
    set: (value: number) => { if (ownPacket) oxygen = value; },
  });
}

/**
 * 1.20.5 起的方块数据里，铁矿、金矿、钻石矿、黑曜石、金属块这些（93 种）的材质写成 incorrect_for_wooden_tool 之类，
 * 速度表里这一项只有木头工具，没有石镐、铁镐、钻石镐：mineflayer 就按空手算挖的时间（钻石镐挖黑曜石算成 75 秒，实际 9.4 秒），
 * 一直等到这个时间才告诉服务器挖完。这些都是镐子挖的方块：速度按 mineable/pickaxe 算（能不能挖下来仍按 harvestTools）
 */
export function fixPickaxeSpeeds(registry: any): void {
  const pickaxe = registry?.materials?.['mineable/pickaxe'];
  if (!pickaxe) return;
  for (const name of Object.keys(registry.materials)) {
    if (name.startsWith('incorrect_for_')) registry.materials[name] = { ...registry.materials[name], ...pickaxe };
  }
}

async function collectSingleBlock(current: any, block: any, signal?: AbortSignal): Promise<void> {
  // 没有碰撞箱的方块（草、花、庄稼）：collectblock 要走到「看得见它」的位置，视线检测打不中它们，寻路永远找不到。
  // 走到旁边直接挖（掉落物由后面统一捡）
  if (block.boundingBox === 'empty') {
    if (current.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4) {
      const r = await patchedGoto(current, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { signal });
      if (!r.ok) throw new Error(`cannot reach ${block.name}: ${r.message}`);
    }
    const now = current.blockAt(block.position);
    if (!now || now.name !== block.name) throw new Error(`${block.name} is already gone`);
    await current.dig(now, true);
    return;
  }
  const task = current.collectBlock.collect(block, { ignoreNoPath: true });
  // 15 秒没更靠近它、也没在挖它：放弃这一块（寻路器原地重试可以一直重试下去，一两分钟一步没挪也不报错）
  const watch = stallWatch(current, block.position, 15_000, () => current.collectBlock?.cancelTask?.());
  try {
    await Promise.race([
      runAbortableOperation(task, signal, () => current.collectBlock?.cancelTask?.()),
      watch.stalled,
    ]);
  } finally {
    watch.stop();
  }
}

/** 一直盯着她离 target 多远：ms 毫秒里没近过半格、也没在挖东西，就调 onStall，stalled 报错说卡在哪 */
export function stallWatch(bot: any, target: Vec3, ms: number, onStall: () => void): { stalled: Promise<never>; stop: () => void } {
  const center = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  let best = Number.POSITIVE_INFINITY;
  let last = Date.now();
  let fail: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => { fail = reject; });
  stalled.catch(() => {});
  const timer = setInterval(() => {
    const here = bot.entity?.position;
    if (!here) return;
    const d = here.distanceTo(center);
    if (d < best - 0.5 || bot.targetDigBlock) {
      best = Math.min(best, d);
      last = Date.now();
    }
    if (Date.now() - last < ms) return;
    clearInterval(timer);
    // 先报原因、再取消：取消以后 collectblock 的任务会正常结束，晚一步的话原因就被它盖掉了
    fail(new Error(`no progress toward it for ${Math.round(ms / 1000)} s (stuck at ${Math.floor(here.x)} ${Math.floor(here.y)} ${Math.floor(here.z)}, still ${d.toFixed(0)} blocks away)`));
    onStall();
  }, 500);
  return { stalled, stop: () => clearInterval(timer) };
}

function canHarvestWithInventory(current: any, block: any): boolean {
  if (!block || typeof block.canHarvest !== 'function') return true;
  if (block.canHarvest(null)) return true; // 空手可采（泥土、草等）
  return (current.inventory?.items?.() ?? []).some(
    (item: any) => block.canHarvest(item.type) === true,
  );
}

function offset(position: any, x: number, y: number, z: number): any {
  return new Vec3(position.x + x, position.y + y, position.z + z);
}

function horizontalDistanceSquared(left: any, right: any): number {
  const x = left.x - right.x;
  const z = left.z - right.z;
  return x * x + z * z;
}

function isBreathingSafely(bot: any): boolean {
  const oxygen = Number(bot?.oxygenLevel ?? 20);
  const position = bot?.entity?.position;
  if (!position || oxygen < OXYGEN_RECOVERED_LEVEL) return false;
  const head = bot.blockAt?.(new Vec3(position.x, position.y + 1, position.z));
  return !head || (head.name !== 'water' && head.name !== 'flowing_water');
}

function waitForOxygen(bot: any, minimum: number, timeoutMs: number): Promise<boolean> {
  if (Number(bot?.oxygenLevel ?? 0) >= minimum && isBreathingSafely(bot)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onBreath = () => {
      if (Number(bot?.oxygenLevel ?? 0) >= minimum && isBreathingSafely(bot)) finish(true);
    };
    const onEnd = () => finish(false);
    const finish = (recovered: boolean) => {
      clearTimeout(timer);
      bot.off?.('breath', onBreath);
      bot.off?.('end', onEnd);
      resolve(recovered);
    };
    bot.on?.('breath', onBreath);
    bot.once?.('end', onEnd);
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Minecraft survival route timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForSpawn(bot: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => finish(resolve);
    const onError = (error: Error) => finish(() => reject(error));
    const onEnd = (reason: string) =>
      finish(() => reject(new Error(reason || 'Minecraft connection ended before spawn')));
    const finish = (callback: () => void) => {
      bot.off('spawn', onSpawn);
      bot.off('error', onError);
      bot.off('end', onEnd);
      callback();
    };
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
  });
}

function requireBot(bot: any): any {
  if (!bot) throw new Error('not connected to Minecraft');
  return bot;
}

function humanPlayerNames(bot: any): string[] {
  return Object.keys(bot.players ?? {}).filter((name) => name !== bot.username);
}

function notifyPlayers(
  bot: any,
  emit: (event: MinecraftRuntimeEvent) => void,
  handlers: MinecraftPolicyHandlers,
): void {
  const players = humanPlayerNames(bot);
  emit({ kind: 'players', players });
  Promise.resolve(handlers.onPlayersChanged?.(players)).catch((error) => emit({
    kind: 'log',
    level: 'error',
    message: `[players] change handler failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
}

function notifyFoodState(bot: any, handlers: MinecraftPolicyHandlers): void {
  const foodIds = new Set(
    Object.values(bot.registry?.foodsByName ?? {}).map((food: any) => food.id),
  );
  const hasInventoryFood = bot.inventory
    .items()
    .some((item: any) => foodIds.has(item.type));
  handlers.onFoodState({ food: bot.food, hasInventoryFood });
}

/**
 * 挨了打：6 格内有该还手的怪，交给 worker（它知道身体正在做什么：逃跑、躲起来时不还手；别的事先停下再还手）。
 * 以前这里直接 pvp.attack：不管身体在做什么都把寻路目标换成追着怪打，逃跑被拐回去打架、采集的寻路被抢走，手里拿着什么就用什么打
 */
function defendFromNearbyHostile(bot: any, handlers: MinecraftPolicyHandlers, emit: (event: any) => void): void {
  const entity = bot.nearestEntity?.((candidate: any) => {
    const snapshot = classifyEntity(candidate);
    return (
      handlers.shouldDefendAgainst(snapshot) &&
      candidate.position?.distanceTo(bot.entity.position) <= 6
    );
  });
  if (!entity) return;
  if (!handlers.onHurtByHostile) {
    void bot.pvp?.attack?.(entity);
    return;
  }
  Promise.resolve(handlers.onHurtByHostile({ attacker: entity.name ?? 'mob', entityId: entity.id, distance: entity.position.distanceTo(bot.entity.position) }))
    .catch((error) => emit({ kind: 'log', level: 'error', message: `[survival] fight-back handler failed: ${error instanceof Error ? error.message : String(error)}` }));
}

function classifyEntity(entity: any): MinecraftEntitySnapshot {
  if (entity.type === 'player') return { kind: 'player', name: entity.username ?? 'player' };
  const name = entity.name ?? entity.displayName ?? 'unknown';
  return { kind: HOSTILE_MOBS.has(name) ? 'hostile' : 'neutral', name };
}

function abortError(): Error {
  const error = new Error('Minecraft collection cancelled');
  error.name = 'AbortError';
  return error;
}

/** 原版盔甲值：头盔、胸甲、护腿、靴子各加几点 */
const ARMOR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  golden: [2, 5, 3, 1],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

function armorPoints(name: string | undefined): number {
  if (!name) return 0;
  if (name === 'turtle_helmet') return 2;
  const [material, piece] = name.split('_');
  const index = ARMOR_PIECES.indexOf(piece);
  return index >= 0 ? (ARMOR_POINTS[material]?.[index] ?? 0) : 0;
}
