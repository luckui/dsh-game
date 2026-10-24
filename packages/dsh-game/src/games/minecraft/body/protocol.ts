export type MinecraftAction =
  | 'discover'
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'say'
  | 'snapshot'
  | 'execute-action'
  | 'cancel-action'
  | 'task-release'
  | 'follow'
  | 'view'
  | 'hud'
  | 'hud-state'
  | 'stop';

export type {
  MinecraftRawObservation,
} from './perception.js';

export type {
  MinecraftActionErrorCode,
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftFact,
  MinecraftFollowPhase,
  MinecraftObservedBlock,
  MinecraftObservedEntity,
  MinecraftWorkerCommand,
  MinecraftWorldChange,
} from './contracts.js';

export interface MinecraftCommand<T = unknown> {
  type: 'command';
  id: string;
  action: MinecraftAction;
  payload: T;
}

export interface MinecraftRoom {
  motd: string;
  advertisedHost: string;
  host: string;
  port: number;
}

export type MinecraftBehavior =
  | { kind: 'idle' }
  | { kind: 'follow'; player: string }
  | {
      kind: 'collect';
      jobId: string;
      block: string;
      requested: number;
      collected: number;
    };

export interface MinecraftStatus {
  connected: boolean;
  username?: string;
  /** 服务器的游戏版本（mineflayer 连上后协商的） */
  version?: string;
  host?: string;
  port?: number;
  players: string[];
  /** 处于旁观模式的玩家（隐身、碰不到） */
  spectators?: string[];
  owner?: string;
  health?: number;
  food?: number;
  behavior: MinecraftBehavior;
}

export type MinecraftRuntimeEvent =
  | { kind: 'chat'; player: string; message: string }
  | { kind: 'player-gaze'; player: string; durationMs: number; distance: number }
  | { kind: 'players'; players: string[] }
  | { kind: 'food-shortage'; food: number }
  | { kind: 'food-recovered'; food: number }
  | { kind: 'death'; position?: { x: number; y: number; z: number } }
  | { kind: 'movement-blocked'; mode: 'follow'; player: string; position: { x: number; y: number; z: number }; distance: number }
  | { kind: 'oxygen-danger'; recovered: boolean; oxygen: number; method: 'surface' | 'last-breathable-position' | 'shore' | 'failed'; position: { x: number; y: number; z: number } }
  | { kind: 'creeper-evaded'; distance: number; ok: boolean }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type MinecraftWorkerMessage =
  | { type: 'response'; id: string; ok: true; data: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'event'; event: MinecraftRuntimeEvent };
