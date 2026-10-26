import type { TerrainScan } from '../terrain.js';
import type { FollowPose } from '../followCam.js';
import type {
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftHudState,
} from '../contracts.js';
import type { MinecraftRawObservation, MinecraftStatus } from '../protocol.js';
import type { PathfindResult } from '../patchedGoto.js';
import type { BuildBlock } from '../build.js';

export interface MinecraftConnectionOptions {
  host: string;
  port: number;
  username: string;
  owner?: string;
  /** 陪玩模式（默认 true）：自动认唯一的真人玩家做主人并跟着走。false = 她自己玩，不跟任何人 */
  companion?: boolean;
}

export interface CollectionRequest {
  blocks: string[];
  quantity: number;
  radius: number;
  signal: AbortSignal;
  /** 这次采集里已经放弃过的位置（"x,y,z"）：后面几轮不再试 */
  exclude?: Set<string>;
}

export interface MinecraftEntitySnapshot {
  kind: 'player' | 'hostile' | 'neutral';
  name: string;
}

export interface MinecraftPolicyHandlers {
  onFoodState(state: { food: number; hasInventoryFood: boolean }): void;
  onOxygenEmergency(state: MinecraftOxygenEmergency): void;
  onDeath(state: MinecraftDeathEvent): void;
  onFollowBlocked?(state: MinecraftFollowBlocked): void;
  onFollowRecovered?(state: MinecraftFollowBlocked): void;
  onPlayersChanged?(players: string[]): void | Promise<void>;
  /** 苦力怕贴近（4.5 格内）：同一只 4 秒内只报一次 */
  onCreeperClose?(state: { distance: number; position: { x: number; y: number; z: number } }): void | Promise<void>;
  shouldDefendAgainst(entity: MinecraftEntitySnapshot): boolean;
  /** 挨了打、6 格内有该还手的怪：交给 worker 决定停不停手上的事、还不还手（不给就是直接还手） */
  onHurtByHostile?(state: { attacker: string; entityId: number; distance: number }): void | Promise<void>;
}

export interface MinecraftOxygenEmergency {
  oxygen: number;
  position: { x: number; y: number; z: number };
}

export interface MinecraftDeathEvent {
  position?: { x: number; y: number; z: number };
}

export interface MinecraftFollowBlocked {
  player: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface MinecraftSafetyRecovery {
  recovered: boolean;
  oxygen: number;
  method: 'surface' | 'last-breathable-position' | 'shore' | 'failed';
}

export interface MinecraftBodyAdapter {
  isConnected(): boolean;
  getSnapshot(): Promise<MinecraftEnvironmentSnapshot>;
  say(message: string): Promise<void>;
  navigateToPlayer(playerName: string, options: {
    range: number;
    timeoutMs: number;
    dynamic: boolean;
    signal?: AbortSignal;
  }): Promise<PathfindResult>;
  navigateToPosition(position: { x: number; y: number; z: number }, options: {
    range: number;
    signal?: AbortSignal;
  }): Promise<PathfindResult>;
  stopNavigation(): Promise<void>;
  /** 自保：躲到地下 / 逃开怪物 / 睡觉过夜（见 survival.ts） */
  hide(signal: AbortSignal): Promise<MinecraftActionResult>;
  /** 原版 HUD 上的东西：血、饱食度、盔甲、氧气、经验、快捷栏（摄像机窗口上的 HUD 层用） */
  hudState(): MinecraftHudState | null;
  /** 跟拍镜头这一步该在哪（见 followCam.ts）；reset = 从头算（镜头刚被别的事占过、她被传送了）。没连上是 null */
  followCam(reset: boolean): FollowPose | null;
  /** 这些名字里哪些不是这个版本能放的方块：名字 → 说明（附相近的名字） */
  checkBlocks(names: string[]): Record<string, string>;
  /** 周围的地形（每一列的地面高度和方块，见 terrain.ts） */
  terrain(radius: number): TerrainScan;
  /** 照图纸盖房子（见 build.ts） */
  buildStructure(options: { label: string; blocks: BuildBlock[]; clear: { x: number; y: number; z: number }[]; signal: AbortSignal }): Promise<MinecraftActionResult>;
  /** 种地、收庄稼、繁殖、剪羊毛（见 farming.ts） */
  farmPlot(options: { seed: string; corner: { x: number; y: number; z: number }; size: number; signal: AbortSignal }): Promise<MinecraftActionResult>;
  harvestCrops(options: { crop?: string; radius: number; replant: boolean; signal: AbortSignal }): Promise<MinecraftActionResult>;
  breedAnimals(options: { animal: string; pairs: number; signal: AbortSignal }): Promise<MinecraftActionResult>;
  shearSheep(options: { count: number; signal: AbortSignal }): Promise<MinecraftActionResult>;
  /** 用桶（装 / 倒）、对一格方块用手里的东西（见 useItems.ts） */
  useBucket(options: { item: string; position: { x: number; y: number; z: number }; signal: AbortSignal }): Promise<MinecraftActionResult>;
  useOnBlock(options: { item: string; position: { x: number; y: number; z: number }; face?: string; signal: AbortSignal }): Promise<MinecraftActionResult>;
  /** 挖掉指定的那一格（见 useItems.ts） */
  digAt(options: { position: { x: number; y: number; z: number }; signal: AbortSignal }): Promise<MinecraftActionResult>;
  /** 还开着的界面（熔炉、箱子、工作台……）关掉，鼠标上拿着的东西先放回背包 */
  closeStrayWindow(): Promise<void>;
  /** 苦力怕反射：躲开附近的苦力怕（跑开约 8 格） */
  evadeCreeper(signal: AbortSignal): Promise<MinecraftActionResult>;
  /** 还手：拿上最好的武器打这只，打死或者它跑开了停（最多 20 秒），换回原来手里的 */
  defendAgainst(entityId: number, signal: AbortSignal): Promise<MinecraftActionResult>;
  flee(signal: AbortSignal): Promise<MinecraftActionResult>;
  sleep(signal: AbortSignal): Promise<MinecraftActionResult>;
  escapeToAir(): Promise<MinecraftSafetyRecovery>;
  /** 浮上来之后游到最近的岸上（寻路器在水里规划不好，手动划水）；到了岸上返回 true */
  swimToShore(): Promise<boolean>;
  inspect(options: { radius: number }): Promise<MinecraftEnvironmentSnapshot>;
  scanBlocks(options: { radius: number; verticalRadius: number; limit: number }): Promise<MinecraftActionResult>;
  searchBlock(options: { block: string; radius: number; count: number }): Promise<MinecraftActionResult>;
  searchEntity(options: { entity: string; radius: number }): Promise<MinecraftActionResult>;
  approachEntity(options: { entity: string; range: number; radius: number }): Promise<MinecraftActionResult>;
  attackEntity(options: {
    actionId: string;
    entity: string;
    radius: number;
    quantity: number;
    kill: boolean;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  collectItem(options: {
    actionId: string;
    block?: string;
    item?: string;
    radius: number;
    maxCount: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  craftItem(options: {
    actionId: string;
    item: string;
    quantity?: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  smeltItem(options: {
    actionId: string;
    item?: string;
    block?: string;
    quantity: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  equipItem(options: { item: string }): Promise<MinecraftActionResult>;
  dropItem(options: { item: string; count: number; player?: string }): Promise<MinecraftActionResult>;
  placeBlockItem(options: {
    actionId: string;
    block: string;
    position?: { x: number; y: number; z: number };
    face?: string;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  pickupDrops(options: { radius: number }): Promise<MinecraftActionResult>;
}

export interface MinecraftBotAdapter extends MinecraftBodyAdapter {
  connect(options: MinecraftConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  setOwner(player?: string): void;
  status(): MinecraftStatus;
  getRawObservation(ownerName?: string): MinecraftRawObservation;
  startFollowing(player: string): Promise<void>;
  stopForeground(): Promise<void>;
  resolveBlock(name: string): string | null;
  collect(request: CollectionRequest): Promise<number>;
  configurePolicies(handlers: MinecraftPolicyHandlers): void;
}

export interface MinecraftActionContext {
  adapter: MinecraftBodyAdapter;
  signal: AbortSignal;
  now: () => number;
  snapshot: () => Promise<MinecraftEnvironmentSnapshot>;
}

export interface MinecraftActionHandler {
  name: MinecraftActionName;
  run(instruction: MinecraftActionInstruction, context: MinecraftActionContext): Promise<MinecraftActionResult>;
}
