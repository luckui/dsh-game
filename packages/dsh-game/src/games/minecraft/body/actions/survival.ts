import type { MinecraftActionHandler } from './types.js';

/** 自保动作：躲到地下、逃开怪物、睡觉过夜 */
export function createSurvivalActions(): MinecraftActionHandler[] {
  return (['hide', 'flee', 'sleep'] as const).map((name) => ({
    name,
    async run(instruction, context) {
      const result = await context.adapter[name](context.signal);
      return { ...result, actionId: instruction.id };
    },
  }));
}
