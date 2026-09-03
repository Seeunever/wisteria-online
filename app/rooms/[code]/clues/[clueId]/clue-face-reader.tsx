'use client';

import { Children, useState, type ReactNode } from 'react';
import {
  clueFaceLabel,
  clueFaceTransitionLabel,
  orderClueFacesForReading,
  type ClueFaceReference,
} from '@/lib/clue-face-navigation';

type ClueFaceReaderProps = {
  faces: ClueFaceReference[];
  children: ReactNode;
};

export function ClueFaceReader({ faces, children }: ClueFaceReaderProps) {
  const orderedFaces = orderClueFacesForReading(faces);
  const faceContent = Children.toArray(children);
  const [activeFaceId, setActiveFaceId] = useState(
    () => orderedFaces[0]?.faceId ?? null,
  );
  const selectedIndex = orderedFaces.findIndex((face) => face.faceId === activeFaceId);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const activeFace = orderedFaces[activeIndex];

  if (!activeFace) return null;

  const originalIndex = faces.findIndex((face) => face.faceId === activeFace.faceId);
  const previousFace = activeIndex > 0 ? orderedFaces[activeIndex - 1] : null;
  const nextFace = activeIndex + 1 < orderedFaces.length
    ? orderedFaces[activeIndex + 1]
    : null;

  return (
    <div className="clue-face-reader">
      <p className="clue-face-status" aria-live="polite">
        <strong>{clueFaceLabel(activeFace.side)}</strong>
        {orderedFaces.length > 1 ? (
          <span>{activeIndex + 1} / {orderedFaces.length}</span>
        ) : null}
      </p>
      <div className="clue-face-content" key={activeFace.faceId}>
        {originalIndex >= 0 ? faceContent[originalIndex] : null}
      </div>
      {previousFace || nextFace ? (
        <nav className="clue-face-controls" aria-label="线索卡面切换">
          {previousFace ? (
            <button
              type="button"
              onClick={() => setActiveFaceId(previousFace.faceId)}
            >
              {clueFaceTransitionLabel(activeFace, previousFace, 'previous')}
            </button>
          ) : <span aria-hidden="true" />}
          {nextFace ? (
            <button
              type="button"
              onClick={() => setActiveFaceId(nextFace.faceId)}
            >
              {clueFaceTransitionLabel(activeFace, nextFace, 'next')}
            </button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
