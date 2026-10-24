import type { MinecraftActionName } from '../contracts.js';
import { createNavigationActions } from './navigation.js';
import { createProductionActions } from './production.js';
import { createResourceActions } from './resources.js';
import { createSearchActions } from './search.js';
import { createSurvivalActions } from './survival.js';
import type { MinecraftActionHandler } from './types.js';

export function createMinecraftActionRegistry(): Map<MinecraftActionName, MinecraftActionHandler> {
  return new Map(
    [...createNavigationActions(), ...createSearchActions(), ...createResourceActions(), ...createProductionActions(), ...createSurvivalActions()].map((handler) => [
      handler.name,
      handler,
    ]),
  );
}
