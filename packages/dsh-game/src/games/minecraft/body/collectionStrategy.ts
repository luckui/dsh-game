export interface AdaptiveCollectionRequest {
  radius: number;
  quantity: number;
}

export interface AdaptiveCollectionSweepResult {
  collectedBlocks: number;
  gainedItems: number;
  stop?: boolean;
}

export interface AdaptiveCollectionOptions {
  targetCount: number;
  initialRadius: number;
  maxRadius: number;
  maxSweeps: number;
  collect: (request: AdaptiveCollectionRequest) => Promise<AdaptiveCollectionSweepResult>;
}

export interface AdaptiveCollectionResult {
  reached: boolean;
  gainedItems: number;
  finalRadius: number;
  sweeps: number;
  /** 为什么停：够了 / 缺工具（采集方说停）/ 最大范围内没有了 / 轮数用完（可能还有） */
  stoppedBy: 'reached' | 'stop' | 'exhausted' | 'sweeps';
}

export async function runAdaptiveCollection(
  options: AdaptiveCollectionOptions,
): Promise<AdaptiveCollectionResult> {
  const targetCount = Math.max(1, Math.trunc(options.targetCount));
  const maxRadius = Math.max(1, Math.trunc(options.maxRadius));
  let radius = Math.min(maxRadius, Math.max(1, Math.trunc(options.initialRadius)));
  let gainedItems = 0;
  let sweeps = 0;
  let stoppedBy: AdaptiveCollectionResult['stoppedBy'] = 'sweeps';

  while (sweeps < Math.max(1, Math.trunc(options.maxSweeps)) && gainedItems < targetCount) {
    const quantity = targetCount - gainedItems;
    const result = await options.collect({ radius, quantity });
    sweeps += 1;
    gainedItems += Math.max(0, Math.trunc(result.gainedItems));

    if (gainedItems >= targetCount) { stoppedBy = 'reached'; break; }
    if (result.stop) { stoppedBy = 'stop'; break; }
    if (result.collectedBlocks > 0) continue;
    if (radius >= maxRadius) { stoppedBy = 'exhausted'; break; }
    radius = Math.min(maxRadius, radius * 2);
  }

  return {
    reached: gainedItems >= targetCount,
    gainedItems,
    finalRadius: radius,
    sweeps,
    stoppedBy: gainedItems >= targetCount ? 'reached' : stoppedBy,
  };
}
