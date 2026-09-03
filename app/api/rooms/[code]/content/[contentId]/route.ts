import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { getRequestUser } from '@/lib/auth';
import { canProjectImageContent, type AuthorizationContext } from '@/lib/blind-runtime';
import { loadFrozenBundle, loadFrozenContentSource } from '@/lib/packs';
import { getRoomForMember } from '@/lib/rooms';

export const dynamic = 'force-dynamic';

function denied() {
  return new NextResponse(null, {
    status: 404,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; contentId: string }> },
) {
  try {
    const user = getRequestUser(request);
    if (!user) return denied();
    const { code, contentId } = await params;
    const room = getRoomForMember(code, user.id);
    if (!room?.versionId) return denied();
    const bundle = loadFrozenBundle(room.versionId);
    const context: AuthorizationContext = {
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
      investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: room.status === 'completed',
    };
    const block = bundle.contentBlocks[contentId];
    if (!canProjectImageContent(bundle, contentId, context) || block?.kind !== 'image') return denied();
    const rawPart = request.nextUrl.searchParams.get('part') ?? '0';
    if (!/^(0|[1-9][0-9]{0,3})$/.test(rawPart)) return denied();
    const content = loadFrozenContentSource(room.versionId, contentId, Number(rawPart));
    if (content.region.unit !== 'normalized') return denied();
    const left = Math.max(0, Math.floor(content.region.x * content.page.width));
    const top = Math.max(0, Math.floor(content.region.y * content.page.height));
    const right = Math.min(
      content.page.width,
      Math.ceil((content.region.x + content.region.width) * content.page.width),
    );
    const bottom = Math.min(
      content.page.height,
      Math.ceil((content.region.y + content.region.height) * content.page.height),
    );
    if (right <= left || bottom <= top) return denied();
    const bytes = await sharp(content.sourcePath, { page: content.inputPageIndex, limitInputPixels: 100_000_000 })
      .rotate(content.page.rotation)
      .extract({ left, top, width: right - left, height: bottom - top })
      .webp({ quality: 90 })
      .toBuffer();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return denied();
  }
}
