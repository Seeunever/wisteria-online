import type { BlindBundle } from './blind-runtime.ts';

/**
 * Resolve the canonical stages whose usage contributes to a location limit at
 * the active stage. A reset stage starts a new window at that stage. Invalid
 * or out-of-stage inputs fail closed by returning no usable window.
 */
export function canonicalUsageWindowStageIds(
  bundle: BlindBundle,
  activeStageId: string,
  locationId: string,
) {
  const activeStage = bundle.stages[activeStageId];
  const location = bundle.locations[locationId];
  if (!activeStage || !location || !activeStage.locationIds.includes(locationId)) return [];

  const orderedStages = Object.values(bundle.stages)
    .sort((left, right) => left.sequence - right.sequence);
  if (
    orderedStages.some((stage, index) => (
      !Number.isSafeInteger(stage.sequence)
      || stage.sequence < 1
      || (index > 0 && stage.sequence === orderedStages[index - 1].sequence)
    ))
  ) return [];

  const activeIndex = orderedStages.findIndex((stage) => stage.stageId === activeStageId);
  if (activeIndex < 0) return [];
  const resetStageIds = new Set(location.searchPolicy.resetAtStageIds);
  let startIndex = 0;
  for (let index = 0; index <= activeIndex; index += 1) {
    if (resetStageIds.has(orderedStages[index].stageId)) startIndex = index;
  }
  return orderedStages
    .slice(startIndex, activeIndex + 1)
    .map((stage) => stage.stageId);
}
