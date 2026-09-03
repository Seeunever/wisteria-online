import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clueFaceLabel,
  clueFaceTransitionLabel,
  orderClueFacesForReading,
  type ClueFaceReference,
} from '../lib/clue-face-navigation.ts';

const face = (
  faceId: string,
  side: ClueFaceReference['side'],
): ClueFaceReference => ({ faceId, side });

test('clue reader starts on the back before the front', () => {
  const ordered = orderClueFacesForReading([
    face('front', 'front'),
    face('back', 'back'),
  ]);

  assert.deepEqual(ordered.map(({ faceId }) => faceId), ['back', 'front']);
  assert.equal(clueFaceTransitionLabel(ordered[0], ordered[1], 'next'), '查看正面');
  assert.equal(clueFaceTransitionLabel(ordered[1], ordered[0], 'previous'), '返回背面');
});

test('clue reader prefers a front when no back exists', () => {
  const ordered = orderClueFacesForReading([
    face('note', 'unknown'),
    face('front', 'front'),
  ]);

  assert.deepEqual(ordered.map(({ faceId }) => faceId), ['front', 'note']);
  assert.equal(clueFaceLabel(ordered[0].side), '正面');
});

test('clue reader preserves every additional authorized face', () => {
  const ordered = orderClueFacesForReading([
    face('extra-a', 'unknown'),
    face('front', 'front'),
    face('extra-b', 'single'),
    face('back', 'back'),
    face('extra-c', 'unknown'),
  ]);

  assert.deepEqual(
    ordered.map(({ faceId }) => faceId),
    ['back', 'front', 'extra-a', 'extra-b', 'extra-c'],
  );
  assert.equal(clueFaceTransitionLabel(ordered[1], ordered[2], 'next'), '查看下一面');
});

test('single-sided clues stay immediately readable', () => {
  const onlyFace = face('single', 'single');
  assert.deepEqual(orderClueFacesForReading([onlyFace]), [onlyFace]);
  assert.equal(clueFaceLabel(onlyFace.side), '线索内容');
  assert.deepEqual(orderClueFacesForReading([]), []);
});
