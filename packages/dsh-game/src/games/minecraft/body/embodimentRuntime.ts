import type {
  MinecraftActionErrorCode,
  MinecraftActionInstruction,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
} from './contracts.js';
import { createMinecraftActionRegistry } from './actions/registry.js';
import { QUICK_ACTIONS } from './protocol.js';
import type { MinecraftBodyAdapter } from './actions/types.js';

export class MinecraftEmbodimentRuntime {
  private readonly registry = createMinecraftActionRegistry();
  private readonly now: () => number;
  private active?: {
    id: string;
    abort: AbortController;
    interruption?: MinecraftActionInterruption;
  };

  constructor(private readonly options: { adapter: MinecraftBodyAdapter; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): Promise<MinecraftEnvironmentSnapshot> {
    return this.options.adapter.getSnapshot();
  }

  async execute(instruction: MinecraftActionInstruction): Promise<MinecraftActionResult> {
    if (!this.options.adapter.isConnected()) {
      return failure(instruction.id, instruction.name, 'not_connected', true, this.now());
    }

    const handler = this.registry.get(instruction.name);
    if (!handler) {
      return failure(instruction.id, instruction.name, 'adapter_error', false, this.now(), {
        message: `Unsupported Minecraft action: ${instruction.name}`,
      });
    }

    const abort = new AbortController();
    this.active = { id: instruction.id, abort };
    const started = this.now();
    try {
      return await handler.run(instruction, {
        adapter: this.options.adapter,
        signal: abort.signal,
        now: this.now,
        snapshot: () => this.snapshot(),
      });
    } catch (error) {
      const interruption = this.active?.id === instruction.id
        ? this.active.interruption
        : undefined;
      const cancelled = abort.signal.aborted && !interruption;
      if (interruption) {
        return failure(
          instruction.id,
          instruction.name,
          interruption.code,
          interruption.recoverable ?? true,
          started,
          interruption.details,
          interruption.summary,
        );
      }
      return failure(
        instruction.id,
        instruction.name,
        cancelled ? 'cancelled' : 'adapter_error',
        !cancelled,
        started,
        { message: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      if (this.active?.id === instruction.id) this.active = undefined;
      // 动作结束（成没成都一样）还开着的界面（熔炉、箱子、工作台……）关掉：开着的时候背包的更新进的是那个界面，身体看到的背包就对不上了
      await this.options.adapter.closeStrayWindow().catch(() => {});
    }
  }

  /**
   * 一下就完、不走路的动作（拿东西、丢东西、找东西）：直接做，不占「正在做的动作」的位置，
   * 正在做的长动作照常做下去（她挨打时想换剑、背包满了丢杂物，不用先停下采集）
   */
  async quick(instruction: MinecraftActionInstruction): Promise<MinecraftActionResult> {
    if (!this.options.adapter.isConnected()) {
      return failure(instruction.id, instruction.name, 'not_connected', true, this.now());
    }
    const handler = this.registry.get(instruction.name);
    if (!handler || !QUICK_ACTIONS.has(instruction.name)) {
      return failure(instruction.id, instruction.name, 'adapter_error', false, this.now(), {
        message: `${instruction.name} cannot run alongside another action`,
      });
    }
    const started = this.now();
    try {
      return await handler.run(instruction, {
        adapter: this.options.adapter,
        signal: new AbortController().signal,
        now: this.now,
        snapshot: () => this.snapshot(),
      });
    } catch (error) {
      return failure(instruction.id, instruction.name, 'adapter_error', true, started, { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async cancel(
    actionId: string,
    interruption?: MinecraftActionInterruption,
  ): Promise<boolean> {
    if (!this.active || this.active.id !== actionId) return false;
    this.active.interruption = interruption;
    this.active.abort.abort();
    await this.options.adapter.stopNavigation();
    return true;
  }
}

export interface MinecraftActionInterruption {
  code: MinecraftActionErrorCode;
  summary: string;
  details: Record<string, unknown>;
  recoverable?: boolean;
}

function failure(
  actionId: string,
  actionName: string,
  code: MinecraftActionErrorCode,
  recoverable: boolean,
  started: number,
  details: Record<string, unknown> = {},
  summary?: string,
): MinecraftActionResult {
  return {
    actionId,
    outcome: 'failed',
    summary: summary ?? `${actionName} failed: ${code}`,
    durationMs: Math.max(0, Date.now() - started),
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
    error: { code, recoverable, details },
  };
}
