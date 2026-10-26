export type MinecraftFollowPhase =
  | 'inactive'
  | 'approaching'
  | 'nearby'
  | 'recovering'
  | 'blocked'
  | 'target-lost';

export type MinecraftActionName =
  | 'navigate_to_player'
  | 'go_to'
  | 'hide'
  | 'flee'
  | 'follow_player'
  | 'search_entity'
  | 'search_block'
  | 'scan_blocks'
  | 'approach_entity'
  | 'attack_entity'
  | 'wait'
  | 'inspect'
  | 'collect_item'
  | 'pickup_drops'
  | 'craft_item'
  | 'drop_item'
  | 'smelt_item'
  | 'use_container'
  | 'eat'
  | 'equip'
  | 'defend'
  | 'retreat'
  | 'sleep'
  | 'farm_plot'
  | 'harvest_crops'
  | 'breed_animals'
  | 'shear_sheep'
  | 'use_bucket'
  | 'use_on_block'
  | 'dig_at'
  | 'place_block'
  | 'break_block'
  | 'execute_blueprint'
  | 'build_structure';

export type MinecraftActionErrorCode =
  | 'not_connected'
  | 'target_not_found'
  | 'path_unreachable'
  | 'blocked'
  | 'missing_tool'
  | 'missing_item'
  | 'inventory_full'
  | 'unknown_item'
  | 'unsafe'
  | 'died'
  | 'timeout'
  | 'cancelled'
  | 'recipe_unavailable'
  | 'inventory_desync'
  | 'craft_rejected'
  | 'dig_rejected'
  | 'adapter_error';

export interface MinecraftFact {
  id: string;
  at: number;
  severity: 'info' | 'notice' | 'warning' | 'error';
  kind: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface MinecraftObservedBlock {
  name: string;
  displayName?: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface MinecraftObservedEntity {
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  distance: number;
  hostile: boolean;
}

export interface MinecraftEnvironmentSnapshot {
  capturedAt: number;
  stale: boolean;
  connection: { connected: boolean; username?: string; host?: string; port?: number };
  world?: { dimension: string; biome?: string; timeOfDay?: number; weather?: string };
  body?: {
    position: { x: number; y: number; z: number };
    health: number;
    food: number;
    oxygen?: number;
    /** 身体泡在水里 */
    inWater?: boolean;
    inventory: Record<string, number>;
  };
  owner?: { name: string; visible: boolean; distance?: number; relativeDirection?: string };
  follow: { phase: MinecraftFollowPhase; target?: string; distance?: number };
  nearby: { blocks: MinecraftObservedBlock[]; entities: MinecraftObservedEntity[] };
  action?: {
    id: string;
    name: MinecraftActionName;
    state: 'running' | 'paused' | 'cancelled';
    args: Record<string, unknown>;
  };
  recentEvents: MinecraftFact[];
}

export interface MinecraftActionInstruction {
  id: string;
  name: MinecraftActionName;
  args: Record<string, unknown>;
  /** 标记该动作由 Minecraft 子任务发起；子任务执行期间挂起默认跟随。 */
  task?: boolean;
}

export interface MinecraftWorldChange {
  kind: 'block_broken' | 'block_placed' | 'item_picked_up' | 'entity_hit';
  name: string;
  position?: { x: number; y: number; z: number };
  count?: number;
}

export interface MinecraftActionResult {
  actionId: string;
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  durationMs: number;
  inventoryDelta: Record<string, number>;
  worldChanges: MinecraftWorldChange[];
  observations: MinecraftFact[];
  error?: { code: MinecraftActionErrorCode; recoverable: boolean; details: Record<string, unknown> };
}

export type MinecraftWorkerCommand =
  | { type: 'discover'; requestId: string }
  | { type: 'connect'; requestId: string; host: string; port: number; username?: string }
  | { type: 'disconnect'; requestId: string }
  | { type: 'status'; requestId: string }
  | { type: 'say'; requestId: string; message: string }
  | { type: 'snapshot'; requestId: string }
  | { type: 'execute-action'; requestId: string; instruction: MinecraftActionInstruction }
  | { type: 'cancel-action'; requestId: string; actionId: string }
  | { type: 'task-release'; requestId: string };

/** 快捷栏里的一格：物品名、数量、耐久（用掉多少 / 一共多少，没有耐久就不带） */
export interface MinecraftHudItem {
  name: string;
  count: number;
  damage?: number;
  maxDamage?: number;
}

/** 原版 HUD 上的东西 */
export interface MinecraftHudState {
  health: number;
  food: number;
  /** 盔甲值（0–20） */
  armor: number;
  /** 氧气（0–20，满了不显示） */
  oxygen: number;
  level: number;
  /** 当前等级的经验进度（0–1） */
  progress: number;
  /** 手上拿的是快捷栏第几格（0–8） */
  selected: number;
  hotbar: (MinecraftHudItem | null)[];
  offhand: MinecraftHudItem | null;
}
