import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import {
  projectVisibleClues,
  type AuthorizationContext,
} from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { getRoomForMember } from '@/lib/rooms';
import { ProtectedContent } from '../../protected-content';

export const dynamic = 'force-dynamic';

type CluePageProps = {
  params: Promise<{ code: string; clueId: string }>;
};

function loadVisibleClue(
  versionId: string,
  clueId: string,
  authorization: AuthorizationContext,
) {
  try {
    return projectVisibleClues(loadFrozenBundle(versionId), authorization)
      .find((candidate) => candidate.clueId === clueId) ?? null;
  } catch {
    return null;
  }
}

export default async function CluePage({ params }: CluePageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/#account');
  const { code, clueId } = await params;
  const room = getRoomForMember(code, user.id);
  if (!room?.versionId) notFound();

  const authorization: AuthorizationContext = {
    joined: true,
    assignedRoleId: room.assignedRoleId,
    assignedRoleIds: new Set(
      room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
    ),
    activeStageId: room.reachedStages.find((stage) => stage.completedAt === null)?.stageId ?? null,
    reachedStageIds: new Set(room.reachedStages.map((stage) => stage.stageId)),
    heldClueIds: new Set(room.clues.filter((clue) => clue.isHeld).map((clue) => clue.clueId)),
    roomHeldClueIds: new Set(room.roomHeldClueIds),
    publishedClueIds: new Set(
      room.clues.filter((clue) => clue.publishedAt !== null).map((clue) => clue.clueId),
    ),
    hostReleaseIds: new Set(room.hostReleaseIds),
    sessionCompleted: room.status === 'completed',
  };
  const clue = loadVisibleClue(room.versionId, clueId, authorization);
  if (!clue) notFound();

  return (
      <main className="rooms-shell clue-reader-shell">
        <header className="room-header">
          <Link className="brand" href={`/rooms/${room.code}`}>
            <span className="brand-mark" aria-hidden="true">暗</span>
            <span><strong>返回房间</strong><small>当前玩家：{user.displayName}</small></span>
          </Link>
          <div className="room-toolbar">
            <span className="room-player">当前玩家：{user.displayName}</span>
            <span className="room-code">房间 {room.code}</span>
          </div>
        </header>

        <section className="clue-reader" aria-labelledby="clue-reader-title">
          <p className="eyebrow">PRIVATE CLUE</p>
          <h1 id="clue-reader-title">线索已打开</h1>
          <p className="clue-visibility">
            {clue.isPublished ? '这张线索已经对全房间公开。' : '这张线索目前只有你能看到。'}
          </p>
          <article className="clue-content-card">
            {clue.faces.map((face) => (
              <div key={face.faceId}>
                {face.content.map((content, index) => (
                  <ProtectedContent
                    key={`${face.faceId}-${index}`}
                    code={room.code}
                    content={content}
                  />
                ))}
              </div>
            ))}
          </article>
          <div className="clue-decision-bar" aria-label="线索可见性选择">
            <Link className="clue-hide-button" href={`/rooms/${room.code}`}>暂时隐藏</Link>
            {clue.canPublish ? (
              <form action={`/api/rooms/${room.code}/clues/publish`} method="post">
                <input type="hidden" name="clueId" value={clue.clueId} />
                <button type="submit">公开到全房间</button>
              </form>
            ) : null}
          </div>
        </section>
      </main>
  );
}
