export type ClueFaceSide = 'front' | 'back' | 'single' | 'unknown';

export type ClueFaceReference = {
  faceId: string;
  side: ClueFaceSide;
};

/**
 * Put the conventional card sides first without dropping any other authorized
 * faces. A back is always the initial view when one exists; otherwise a front
 * is preferred and the source order is retained for everything else.
 */
export function orderClueFacesForReading<T extends ClueFaceReference>(
  faces: readonly T[],
): T[] {
  const preferredIndexes: number[] = [];
  const backIndex = faces.findIndex((face) => face.side === 'back');
  const frontIndex = faces.findIndex((face) => face.side === 'front');

  if (backIndex >= 0) preferredIndexes.push(backIndex);
  else if (frontIndex >= 0) preferredIndexes.push(frontIndex);

  if (backIndex >= 0 && frontIndex >= 0) preferredIndexes.push(frontIndex);

  const preferred = new Set(preferredIndexes);
  return [
    ...preferredIndexes.map((index) => faces[index]),
    ...faces.filter((_, index) => !preferred.has(index)),
  ];
}

export function clueFaceLabel(side: ClueFaceSide) {
  if (side === 'back') return '背面';
  if (side === 'front') return '正面';
  return '线索内容';
}

export function clueFaceTransitionLabel(
  current: ClueFaceReference,
  target: ClueFaceReference,
  direction: 'previous' | 'next',
) {
  if (target.side === 'back' && current.side !== 'back') return '返回背面';
  if (target.side === 'front' && current.side === 'back') return '查看正面';
  return direction === 'previous' ? '查看上一面' : '查看下一面';
}
