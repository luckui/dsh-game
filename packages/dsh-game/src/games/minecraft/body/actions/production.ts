import type { MinecraftActionHandler } from './types.js';

export function createProductionActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'craft_item',
      async run(instruction, context) {
        const item = stringArg(instruction.args.item, 'item');
        const quantity = numberArg(instruction.args.quantity ?? instruction.args.maxCount, 1, 1, 64);
        const result = await context.adapter.craftItem({
          actionId: instruction.id,
          item,
          quantity,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'place_block',
      async run(instruction, context) {
        const block = stringArg(instruction.args.block, 'block');
        const result = await context.adapter.placeBlockItem({
          actionId: instruction.id,
          block,
          position: positionArg(instruction.args.position),
          face: typeof instruction.args.face === 'string' ? instruction.args.face : undefined,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'build_structure',
      async run(instruction, context) {
        const blocks = Array.isArray(instruction.args.blocks) ? instruction.args.blocks as any[] : [];
        const clear = Array.isArray(instruction.args.clear) ? instruction.args.clear as any[] : [];
        if (!blocks.length) throw new Error('Missing Minecraft action argument: blocks');
        const result = await context.adapter.buildStructure({
          label: typeof instruction.args.label === 'string' ? instruction.args.label : 'the building',
          blocks,
          clear,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'farm_plot',
      async run(instruction, context) {
        const corner = positionArg(instruction.args.corner);
        if (!corner) throw new Error('Missing Minecraft action argument: corner');
        const result = await context.adapter.farmPlot({
          seed: stringArg(instruction.args.seed, 'seed'),
          corner,
          size: numberArg(instruction.args.size, 3, 1, 9),
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'harvest_crops',
      async run(instruction, context) {
        const result = await context.adapter.harvestCrops({
          crop: typeof instruction.args.crop === 'string' && instruction.args.crop.trim() ? instruction.args.crop.trim() : undefined,
          radius: numberArg(instruction.args.radius, 16, 2, 32),
          replant: instruction.args.replant !== false,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'breed_animals',
      async run(instruction, context) {
        const result = await context.adapter.breedAnimals({
          animal: stringArg(instruction.args.animal, 'animal'),
          pairs: numberArg(instruction.args.pairs, 1, 1, 4),
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'shear_sheep',
      async run(instruction, context) {
        const result = await context.adapter.shearSheep({
          count: numberArg(instruction.args.count, 3, 1, 16),
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'use_bucket',
      async run(instruction, context) {
        const position = positionArg(instruction.args.position);
        if (!position) throw new Error('Missing Minecraft action argument: position');
        const result = await context.adapter.useBucket({ item: stringArg(instruction.args.item, 'item'), position, signal: context.signal });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'use_on_block',
      async run(instruction, context) {
        const position = positionArg(instruction.args.position);
        if (!position) throw new Error('Missing Minecraft action argument: position');
        const result = await context.adapter.useOnBlock({
          item: stringArg(instruction.args.item, 'item'),
          position,
          face: typeof instruction.args.face === 'string' ? instruction.args.face : undefined,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'dig_at',
      async run(instruction, context) {
        const position = positionArg(instruction.args.position);
        if (!position) throw new Error('Missing Minecraft action argument: position');
        const result = await context.adapter.digAt({ position, signal: context.signal });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'smelt_item',
      async run(instruction, context) {
        const item = typeof instruction.args.item === 'string' ? instruction.args.item.trim() : undefined;
        const block = typeof instruction.args.block === 'string' ? instruction.args.block.trim() : undefined;
        if (!item && !block) throw new Error('Missing Minecraft action argument: block or item');
        const quantity = numberArg(instruction.args.quantity ?? instruction.args.maxCount, 1, 1, 64);
        const result = await context.adapter.smeltItem({
          actionId: instruction.id,
          item,
          block,
          quantity,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
  ];
}

function stringArg(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing Minecraft action argument: ${name}`);
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function positionArg(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const z = Number(record.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : undefined;
}
