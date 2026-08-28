import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { evaluateCondition, type AuthorizationContext } from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { getRoomForMember, searchLocation } from '@/lib/rooms';
import { assertSameOrigin } from '@/lib/security';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  let origin = new URL(request.url).origin;
  const { code } = await params;
  try {
    origin = assertSameOrigin(request);
    const user = getRequestUser(request);
    if (!user) return NextResponse.redirect(new URL('/#account', origin), 303);
    const room = getRoomForMember(code, user.id);
    const activeStageId = room?.reachedStages.find((stage) => stage.completedAt === null)?.stageId;
    if (!room?.versionId || !room.assignedRoleId || room.status !== 'running' || !activeStageId) {
      throw new Error('SEARCH_REJECTED');
    }
    const form = await request.formData();
    const locationId = form.get('locationId');
    const clueId = form.get('clueId');
    if (typeof locationId !== 'string' || typeof clueId !== 'string') {
      throw new Error('SEARCH_REJECTED');
    }
    const bundle = loadFrozenBundle(room.versionId);
    const stage = bundle.stages[activeStageId];
    const location = bundle.locations[locationId];
    if (
      !stage?.allowedActions.includes('search')
      || !location
      || !stage.locationIds.includes(locationId)
    ) throw new Error('SEARCH_REJECTED');

    const assignedRoleIds = new Set(
      room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
    );
    const context: AuthorizationContext = {
      joined: true,
      assignedRoleId: room.assignedRoleId,
      assignedRoleIds,
      activeStageId,
      reachedStageIds: new Set(room.reachedStages.map((item) => item.stageId)),
      heldClueIds: new Set(room.clues.filter((clue) => clue.isHeld).map((clue) => clue.clueId)),
      roomHeldClueIds: new Set(room.roomHeldClueIds),
      publishedClueIds: new Set(
        room.clues.filter((clue) => clue.publishedAt !== null).map((clue) => clue.clueId),
      ),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: false,
    };
    if (!evaluateCondition(location.availableWhen, context)) throw new Error('SEARCH_REJECTED');
    const eligibleClueIds = location.cluePool
      .filter((entry) => (
        evaluateCondition(entry.availableWhen, context)
        && Boolean(bundle.clues[entry.clueId])
        && evaluateCondition(bundle.clues[entry.clueId].acquisition.when, context)
      ))
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.clueId);
    const selectableClueIds = location.searchPolicy.mode === 'fixed_sequence'
      ? eligibleClueIds.filter((candidate) => !context.roomHeldClueIds.has(candidate)).slice(0, 1)
      : eligibleClueIds.filter((candidate) => !context.roomHeldClueIds.has(candidate));
    if (!selectableClueIds.includes(clueId)) throw new Error('SEARCH_REJECTED');
    if (!searchLocation({
      code: room.code,
      userId: user.id,
      versionId: room.versionId,
      locationId,
      stageId: activeStageId,
      selectedClueId: clueId,
      eligibleClueIds,
      mode: location.searchPolicy.mode,
      perPlayerLimit: location.searchPolicy.perPlayerLimit,
      globalLimit: location.searchPolicy.globalLimit,
    })) throw new Error('SEARCH_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}/clues/${clueId}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=search`, origin), 303);
  }
}
