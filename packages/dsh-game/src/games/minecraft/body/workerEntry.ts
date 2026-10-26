import { randomUUID } from 'node:crypto';
import type {
  MinecraftActionInstruction,
  MinecraftActionResult,
  MinecraftCommand,
  MinecraftEnvironmentSnapshot,
  MinecraftRuntimeEvent,
  MinecraftStatus,
  MinecraftWorkerMessage,
} from './protocol.js';
import type {
  MinecraftBotAdapter,
  MinecraftConnectionOptions,
  MinecraftDeathEvent,
  MinecraftOxygenEmergency,
  MinecraftSafetyRecovery,
} from './actions/types.js';
import type { MinecraftEmbodimentRuntime } from './embodimentRuntime.js';

export interface WorkerController {
  connect(payload: any): Promise<unknown>;
  disconnect(): Promise<unknown>;
  status(): unknown;
  snapshot(): Promise<unknown>;
  say(payload: any): Promise<unknown>;
  executeAction(payload: MinecraftActionInstruction): Promise<unknown>;
  cancelAction(actionId: string): Promise<unknown>;
  follow(payload: any): Promise<unknown>;
  hudState(): unknown;
  followCam(payload: any): unknown;
  quickAction(payload: MinecraftActionInstruction): Promise<unknown>;
  checkBlocks(payload: any): unknown;
  terrain(payload: any): unknown;
  stop(): Promise<unknown>;
  taskRelease(): Promise<unknown>;
}

export type WorkerDispatch = ((command: MinecraftCommand) => Promise<void>) & {
  parentDisconnected(): Promise<void>;
};

export function createWorkerDispatcher(
  controller: WorkerController,
  send: (message: MinecraftWorkerMessage) => void,
): WorkerDispatch {
  let parentClosed = false;

  const dispatch = async (command: MinecraftCommand): Promise<void> => {
    try {
      const data = await runCommand(controller, command);
      send({ type: 'response', id: command.id, ok: true, data });
    } catch (error) {
      send({
        type: 'response',
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return Object.assign(dispatch, {
    async parentDisconnected(): Promise<void> {
      if (parentClosed) return;
      parentClosed = true;
      await controller.disconnect();
    },
  });
}

async function runCommand(
  controller: WorkerController,
  command: MinecraftCommand,
): Promise<unknown> {
  switch (command.action) {
    case 'connect':
      return controller.connect(command.payload);
    case 'disconnect':
      return controller.disconnect();
    case 'status':
      return controller.status();
    case 'snapshot':
      return controller.snapshot();
    case 'say':
      return controller.say((command.payload as { message: string }).message);
    case 'execute-action':
      return controller.executeAction(command.payload as MinecraftActionInstruction);
    case 'cancel-action':
      return controller.cancelAction((command.payload as { actionId: string }).actionId);
    case 'follow':
      return controller.follow(command.payload);
    case 'hud-state':
      return controller.hudState();
    case 'follow-cam':
      return controller.followCam(command.payload);
    case 'quick-action':
      return controller.quickAction(command.payload as MinecraftActionInstruction);
    case 'check-blocks':
      return controller.checkBlocks(command.payload);
    case 'terrain':
      return controller.terrain(command.payload);
    case 'stop':
      return controller.stop();
    case 'task-release':
      return controller.taskRelease();
    default:
      throw new Error(`Unsupported Minecraft worker action: ${command.action}`);
  }
}

async function startWorker(): Promise<void> {
  const [{ MinecraftEmbodimentRuntime }, { createMineflayerAdapter }] =
    await Promise.all([import('./embodimentRuntime.js'), import('./mineflayerAdapter.js')]);
  const send = (message: MinecraftWorkerMessage) => process.send?.(message);
  const emitLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    send({ type: 'event', event: { kind: 'log', level, message } });
  };
  const memoryStats = (): string => {
    const mem = process.memoryUsage();
    return `rss=${Math.round(mem.rss / 1048576)}MB heapUsed=${Math.round(mem.heapUsed / 1048576)}MB heapTotal=${Math.round(mem.heapTotal / 1048576)}MB external=${Math.round(mem.external / 1048576)}MB uptime=${Math.round(process.uptime())}s`;
  };
  process.on('uncaughtException', (error) => {
    emitLog('error', `[worker] uncaughtException: ${error?.stack ?? error}`);
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    emitLog('warn', `[worker] unhandledRejection: ${detail}`);
  });
  setInterval(() => {
    emitLog('info', `[worker] heartbeat mem ${memoryStats()}`);
  }, 60_000);
  emitLog('info', `[worker] started pid=${process.pid} mem ${memoryStats()}`);
  const adapter = createMineflayerAdapter((event) =>
    send({ type: 'event', event }),
  );
  const runtime = new MinecraftEmbodimentRuntime({ adapter });
  const controller = createRuntimeWorkerController(adapter, runtime, (event) => {
    send({ type: 'event', event });
  });
  const dispatch = createWorkerDispatcher(controller, send);

  process.on('message', (message: MinecraftCommand) => void dispatch(message));
  process.once('disconnect', () => {
    void dispatch.parentDisconnected().finally(() => process.exit(0));
  });
}

if (process.env.DSH_GAME_MINECRAFT_WORKER === '1') {
  void startWorker();
}

export function createRuntimeWorkerController(
  adapter: MinecraftBotAdapter,
  runtime: MinecraftEmbodimentRuntime,
  emit: (event: MinecraftRuntimeEvent) => void,
): WorkerController {
  let foodShortageActive = false;
  let companion = true;
  let ownerPlayer: string | undefined;
  let followEnabled = true;
  let currentAction: MinecraftEnvironmentSnapshot['action'];
  let taskActive = false;
  let followBlocked = false;
  let oxygenRecovery: {
    actionId?: string;
    promise: Promise<MinecraftSafetyRecovery>;
  } | undefined;

  const setCurrentAction = (instruction: MinecraftActionInstruction): void => {
    currentAction = {
      id: instruction.id,
      name: instruction.name,
      state: 'running',
      args: { ...instruction.args },
    };
    emit({
      kind: 'log',
      level: 'info',
      message: `[action-state] current=${instruction.name} id=${instruction.id} args=${JSON.stringify(instruction.args)}`,
    });
  };

  const hasForegroundAction = (): boolean => Boolean(
    currentAction && currentAction.name !== 'follow_player',
  );
  /** 身体自己在做的自保反应（躲苦力怕、挨打还手）：一次一个，新动作等它做完再开始 */
  let reflex: Promise<unknown> | null = null;
  /** 正在逃跑、躲起来：本来就在离开，自保反应不打断它 */
  const escaping = (): boolean => hasForegroundAction() && (currentAction?.name === 'flee' || currentAction?.name === 'hide');

  const resumeFollowing = async (): Promise<void> => {
    if (!companion) {
      currentAction = undefined;
      return;
    }
    if (taskActive) {
      currentAction = undefined;
      emit({ kind: 'log', level: 'info', message: '[follow-state] task owns body; follow suspended' });
      return;
    }
    if (!followEnabled || !ownerPlayer) {
      currentAction = undefined;
      emit({
        kind: 'log',
        level: 'info',
        message: `[action-state] current=none; default follow ${followEnabled ? 'has no owner' : 'disabled'}`,
      });
      return;
    }
    if (currentAction?.name === 'follow_player' && currentAction.args.player === ownerPlayer) {
      return;
    }
    try {
      const before = safeOwnerObservation(adapter, ownerPlayer);
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-state] restoring player=${ownerPlayer} visible=${before.owner?.visible ?? false} distance=${formatDebugDistance(before.owner?.distance)}`,
      });
      await adapter.startFollowing(ownerPlayer);
      followBlocked = false;
      currentAction = {
        id: randomUUID(),
        name: 'follow_player',
        state: 'running',
        args: { player: ownerPlayer },
      };
      const after = safeOwnerObservation(adapter, ownerPlayer);
      emit({
        kind: 'log',
        level: 'info',
        message: `[action-state] current=follow_player id=${currentAction.id} player=${ownerPlayer} visible=${after.owner?.visible ?? false} distance=${formatDebugDistance(after.owner?.distance)}`,
      });
    } catch (error) {
      currentAction = undefined;
      emit({
        kind: 'log',
        level: 'warn',
        message: `Could not start default following: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const statusWithAction = (): MinecraftStatus => {
    const status = adapter.status();
    if (currentAction?.name === 'follow_player' && ownerPlayer) {
      return { ...status, owner: ownerPlayer, behavior: { kind: 'follow', player: ownerPlayer } };
    }
    if (currentAction?.name === 'collect_item') {
      return {
        ...status,
        owner: ownerPlayer,
        behavior: {
          kind: 'collect',
          jobId: currentAction.id,
          block: String(currentAction.args.block ?? 'unknown'),
          requested: Number(currentAction.args.maxCount ?? 0),
          collected: 0,
        },
      };
    }
    return { ...status, owner: ownerPlayer, behavior: { kind: 'idle' } };
  };
  adapter.configurePolicies({
    onFoodState(state) {
      const shortage = state.food <= 6 && !state.hasInventoryFood;
      if (shortage && !foodShortageActive) {
        foodShortageActive = true;
        emit({ kind: 'food-shortage', food: state.food });
      } else if (!shortage && foodShortageActive) {
        foodShortageActive = false;
        emit({ kind: 'food-recovered', food: state.food });
      }
    },
    onOxygenEmergency(state) {
      if (oxygenRecovery) return;
      const actionId = hasForegroundAction() ? currentAction?.id : undefined;
      const promise = recoverFromLowOxygen(state, actionId);
      oxygenRecovery = { actionId, promise };
      if (!actionId) {
        void promise.then(async (recovery) => {
          if (oxygenRecovery?.promise === promise) oxygenRecovery = undefined;
          if (taskActive) return;
          currentAction = undefined;
          emit({
            kind: 'oxygen-danger',
            recovered: recovery.recovered,
            oxygen: recovery.oxygen,
            method: recovery.method,
            position: state.position,
          });
          if (recovery.recovered) await resumeFollowing();
        });
      }
    },
    onDeath(state) {
      void stopForDeath(state);
    },
    onFollowBlocked(state) {
      followBlocked = true;
      emit({
        kind: 'movement-blocked',
        mode: 'follow',
        player: state.player,
        position: state.position,
        distance: state.distance,
      });
    },
    onFollowRecovered(state) {
      followBlocked = false;
      emit({
        kind: 'log',
        level: 'info',
        message: `[follow-state] recovered player=${state.player} distance=${state.distance.toFixed(1)}`,
      });
    },
    async onPlayersChanged(players) {
      if (!companion) return;
      const status = adapter.status();
      const humanPlayers = players.filter((player) => !samePlayer(player, status.username));
      if (!ownerPlayer && humanPlayers.length === 1) {
        ownerPlayer = humanPlayers[0];
        adapter.setOwner(ownerPlayer);
        emit({ kind: 'log', level: 'info', message: `[follow-state] owner inferred player=${ownerPlayer}` });
      }
      if (ownerPlayer
        && currentAction?.name === 'follow_player'
        && !humanPlayers.some((player) => samePlayer(player, ownerPlayer))) {
        await adapter.stopForeground();
        currentAction = undefined;
        emit({
          kind: 'log',
          level: 'info',
          message: `[follow-state] owner unavailable player=${ownerPlayer}; binding retained`,
        });
        return;
      }
      if (ownerPlayer && humanPlayers.some((player) => samePlayer(player, ownerPlayer))) {
        await resumeFollowing();
      }
    },
    async onCreeperClose(state) {
      // 正在逃跑、躲起来：本来就在离开，不打断；已经在躲别的、在还手：不重复
      if (reflex || escaping()) return;
      // 跟溺水自救一样：停下手上的事（回报给她「苦力怕靠近，身体先躲开了」），躲开，再报一声
      const actionId = hasForegroundAction() ? currentAction?.id : undefined;
      const run = (async () => {
        if (actionId) {
          await runtime.cancel(actionId, {
            code: 'unsafe',
            summary: 'a creeper came close, so the body stopped and backed away from it',
            details: { reason: 'creeper', distance: Number(state.distance.toFixed(1)) },
          });
        } else {
          await adapter.stopForeground();
        }
        const result = await adapter.evadeCreeper(new AbortController().signal);
        emit({ kind: 'creeper-evaded', distance: state.distance, ok: result.outcome === 'succeeded' });
      })();
      reflex = run;
      try { await run; } finally { if (reflex === run) reflex = null; }
    },
    async onHurtByHostile(state) {
      // 正在逃跑、躲起来：不回头打；正在打怪：本来就在打；已经在躲苦力怕、在还手：不重复
      if (reflex || escaping() || (hasForegroundAction() && currentAction?.name === 'attack_entity')) return;
      const actionId = hasForegroundAction() ? currentAction?.id : undefined;
      const interrupted = actionId ? currentAction?.name ?? null : null;
      const run = (async () => {
        if (actionId) {
          await runtime.cancel(actionId, {
            code: 'unsafe',
            summary: `a ${state.attacker} hit her, so the body stopped to fight back`,
            details: { reason: 'attacked', attacker: state.attacker },
          });
        } else {
          await adapter.stopForeground();
        }
        const result = await adapter.defendAgainst(state.entityId, new AbortController().signal);
        emit({ kind: 'fought-back', attacker: state.attacker, killed: result.outcome === 'succeeded', interrupted });
      })();
      reflex = run;
      try { await run; } finally { if (reflex === run) reflex = null; }
    },
    // 苦力怕不去近战（会一起炸），交给上面的躲避反射
    shouldDefendAgainst: (entity) => entity.kind === 'hostile' && entity.name !== 'creeper',
  });

  async function stopForDeath(state: MinecraftDeathEvent): Promise<void> {
    const actionId = hasForegroundAction() ? currentAction?.id : undefined;
    emit({ kind: 'death', position: state.position });
    emit({
      kind: 'log',
      level: 'error',
      message: `[survival] death action=${actionId ?? 'none'} position=${state.position ? `${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}` : 'unknown'}`,
    });
    if (actionId) {
      await runtime.cancel(actionId, {
        code: 'died',
        recoverable: false,
        summary: 'Minecraft task stopped because the body died',
        details: { reason: 'death', position: state.position },
      });
      return;
    }
    await adapter.stopForeground();
  }

  async function recoverFromLowOxygen(
    state: MinecraftOxygenEmergency,
    actionId?: string,
  ): Promise<MinecraftSafetyRecovery> {
    emit({
      kind: 'log',
      level: 'warn',
      message: `[survival] oxygen emergency oxygen=${state.oxygen} position=${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)} action=${actionId ?? 'none'}`,
    });
    if (actionId) {
      await runtime.cancel(actionId, {
        code: 'unsafe',
        summary: 'Minecraft action interrupted because oxygen became unsafe',
        details: { reason: 'oxygen_low', oxygen: state.oxygen, position: state.position },
      });
    } else {
      await adapter.stopForeground();
    }
    let recovery: MinecraftSafetyRecovery;
    try {
      recovery = await adapter.escapeToAir();
    } catch (error) {
      recovery = { recovered: false, oxygen: state.oxygen, method: 'failed' };
      emit({
        kind: 'log',
        level: 'error',
        message: `[survival] oxygen recovery threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // 只浮上来不够：一松手又沉下去，空气又耗光。接着游到岸上
    try {
      const ashore = await adapter.swimToShore();
      emit({ kind: 'log', level: ashore ? 'info' : 'warn', message: `[survival] swim to shore ${ashore ? 'reached land' : 'found no reachable shore'}` });
      if (ashore) recovery = { ...recovery, recovered: true, method: recovery.recovered ? recovery.method : 'shore' };
    } catch (error) {
      emit({ kind: 'log', level: 'warn', message: `[survival] swim to shore threw: ${error instanceof Error ? error.message : String(error)}` });
    }
    emit({
      kind: 'log',
      level: recovery.recovered ? 'info' : 'error',
      message: `[survival] oxygen recovery recovered=${recovery.recovered} oxygen=${recovery.oxygen} method=${recovery.method}`,
    });
    return recovery;
  }

  return {
    async connect(payload: MinecraftConnectionOptions): Promise<MinecraftStatus> {
      if (samePlayer(payload.owner, payload.username)) {
        throw new Error('cannot follow itself');
      }
      const wasConnected = adapter.status().connected;
      companion = payload.companion !== false;
      await adapter.connect(payload);
      const status = adapter.status();
      const humanPlayers = status.players.filter((player) => !samePlayer(player, status.username));
      ownerPlayer = !companion ? undefined : payload.owner?.trim()
        || ownerPlayer
        || (samePlayer(status.owner, status.username) ? undefined : status.owner)
        || (humanPlayers.length === 1 ? humanPlayers[0] : undefined);
      adapter.setOwner(ownerPlayer);
      if (!wasConnected) {
        followEnabled = true;
        taskActive = false;
        followBlocked = false;
      }
      await resumeFollowing();
      return statusWithAction();
    },
    async disconnect(): Promise<void> {
      ownerPlayer = undefined;
      followEnabled = true;
      currentAction = undefined;
      taskActive = false;
      followBlocked = false;
      await adapter.stopForeground();
      await adapter.disconnect();
    },
    status(): MinecraftStatus {
      return statusWithAction();
    },
    async snapshot() {
      const started = Date.now();
      emit({ kind: 'log', level: 'info', message: 'snapshot started' });
      try {
        const snapshot = await runtime.snapshot();
        emit({
          kind: 'log',
          level: 'info',
          message: `[snapshot-state] action=${currentAction?.name ?? 'none'} id=${currentAction?.id ?? 'none'} task=${taskActive} owner=${snapshot.owner?.name ?? 'none'} visible=${snapshot.owner?.visible ?? false} distance=${formatDebugDistance(snapshot.owner?.distance)}`,
        });
        if (!currentAction) return { ...snapshot, follow: { phase: 'inactive' } };
        const follow = currentAction.name === 'follow_player'
          ? {
            phase: followBlocked
              ? 'blocked' as const
              : snapshot.owner?.visible
              ? (snapshot.owner.distance ?? Number.POSITIVE_INFINITY) <= 2 ? 'nearby' as const : 'approaching' as const
              : 'target-lost' as const,
            target: String(currentAction.args.player ?? ownerPlayer ?? ''),
            distance: snapshot.owner?.distance,
          }
          : { phase: 'inactive' as const };
        return {
          ...snapshot,
          follow,
          action: { ...currentAction, args: { ...currentAction.args } },
        };
      } finally {
        emit({ kind: 'log', level: 'info', message: `snapshot finished in ${Date.now() - started}ms` });
      }
    },
    async say(message: string): Promise<void> {
      await adapter.say(message);
    },
    async executeAction(payload: MinecraftActionInstruction) {
      if (payload.task) taskActive = true;
      if (hasForegroundAction()) {
        throw new Error(`Minecraft action already running: ${currentAction?.name} (${currentAction?.id})`);
      }
      // 身体自己在躲苦力怕、在还手：等它做完再开始（两边同时设寻路目标，后开始的那个会被「目标改了」打断）
      if (reflex) await reflex.catch(() => undefined);
      await adapter.stopForeground();
      setCurrentAction(payload);
      let result: MinecraftActionResult | undefined;
      try {
        result = await runtime.execute(payload);
        const recovery = oxygenRecovery?.actionId === payload.id
          ? oxygenRecovery
          : undefined;
        if (!recovery) return result;
        const recovered = await recovery.promise;
        if (oxygenRecovery?.promise === recovery.promise) oxygenRecovery = undefined;
        return withOxygenRecovery(result, recovered);
      } finally {
        if (taskActive) {
          currentAction = undefined;
          emit({ kind: 'log', level: 'info', message: '[follow-state] task owns body; follow suspended' });
        } else if (result?.error?.code === 'blocked'
          || result?.error?.code === 'path_unreachable'
          || result?.error?.code === 'timeout'
          || result?.error?.code === 'unsafe') {
          currentAction = undefined;
          emit({
            kind: 'log',
            level: 'warn',
            message: `[follow-state] suspended after ${result.error.code}; waiting for player assistance or a new movement command`,
          });
        } else {
          await resumeFollowing();
        }
      }
    },
    cancelAction(actionId: string) {
      return runtime.cancel(actionId);
    },
    async follow(payload: { player: string }): Promise<{ state: 'following'; player: string }> {
      const username = adapter.status().username;
      if (samePlayer(payload.player, username)) {
        throw new Error('cannot follow itself');
      }
      taskActive = false;
      followBlocked = false;
      if (hasForegroundAction() && currentAction) await runtime.cancel(currentAction.id);
      await adapter.stopForeground();
      ownerPlayer = payload.player.trim();
      followEnabled = true;
      adapter.setOwner(ownerPlayer);
      await resumeFollowing();
      return { state: 'following', player: ownerPlayer };
    },
    hudState() {
      return adapter.hudState();
    },
    followCam(payload: { reset?: boolean }) {
      return adapter.followCam(!!payload?.reset);
    },
    quickAction(payload: MinecraftActionInstruction) {
      return runtime.quick(payload);
    },
    terrain(payload: { radius?: number }) {
      return adapter.terrain(payload.radius ?? 32);
    },
    checkBlocks(payload: { names: string[] }) {
      return adapter.checkBlocks(payload.names ?? []);
    },
    async stop(): Promise<void> {
      followEnabled = false;
      taskActive = false;
      followBlocked = false;
      if (hasForegroundAction() && currentAction) await runtime.cancel(currentAction.id);
      await adapter.stopForeground();
      currentAction = undefined;
    },
    async taskRelease(): Promise<MinecraftStatus> {
      taskActive = false;
      await resumeFollowing();
      return statusWithAction();
    },
  };
}

function withOxygenRecovery(
  result: MinecraftActionResult,
  recovery: MinecraftSafetyRecovery,
): MinecraftActionResult {
  const text = recovery.recovered
    ? 'Oxygen became unsafe, so the action stopped and the body returned to air. Re-observe the surroundings and choose a safer route before retrying.'
    : 'Oxygen became unsafe and the body could not confirm a return to air. Stop this task and report the danger.';
  return {
    ...result,
    outcome: recovery.recovered ? 'partial' : 'failed',
    summary: text,
    observations: [
      ...(result.observations ?? []),
      {
        id: `survival.oxygen:${Date.now()}`,
        at: Date.now(),
        severity: recovery.recovered ? 'warning' : 'error',
        kind: 'survival.oxygen',
        text,
        data: { ...recovery },
      },
    ],
    error: {
      code: 'unsafe',
      recoverable: recovery.recovered,
      details: {
        ...(result.error?.details ?? {}),
        reason: 'oxygen_low',
        recovered: recovery.recovered,
        oxygen: recovery.oxygen,
        recoveryMethod: recovery.method,
        message: text,
      },
    },
  };
}

function formatDebugDistance(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown';
}

function samePlayer(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}

function safeOwnerObservation(
  adapter: MinecraftBotAdapter,
  player: string,
): { owner?: { visible: boolean; distance?: number } } {
  try {
    return adapter.getRawObservation(player);
  } catch {
    return {};
  }
}
