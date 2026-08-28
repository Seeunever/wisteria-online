import { getCurrentUser } from '@/lib/auth';
import { listFrozenPackVersions } from '@/lib/packs';
import { listRooms } from '@/lib/rooms';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import styles from './rooms.module.css';

export const dynamic = 'force-dynamic';

type RoomsPageProps = {
  searchParams: Promise<{ error?: string | string[]; deleted?: string | string[] }>;
};

type RoomSummary = ReturnType<typeof listRooms>[number];

const roomStatus = {
  lobby: { label: '等待开局', detail: '剧本与角色准备中', action: '进入房间' },
  running: { label: '游戏进行中', detail: '返回当前阶段继续行动', action: '继续游戏' },
  completed: { label: '本局已结束', detail: '查看最终房间状态', action: '查看房间' },
} as const;

function getRoomStatus(status: string) {
  return roomStatus[status as keyof typeof roomStatus] ?? {
    label: '房间可进入',
    detail: '查看当前房间状态',
    action: '进入房间',
  };
}

function formatRoomDate(createdAt: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(createdAt));
}

function RoomCard({ room }: { room: RoomSummary }) {
  const status = getRoomStatus(room.status);
  const isMember = Boolean(room.isMember);
  const canJoin = room.status === 'lobby';

  const content = (
    <>
      <div className={styles.roomCardTopline}>
        <span className={styles.roomCode}>{room.code}</span>
        <span className={styles.roomRole}>
          {room.isOwner ? '房主' : isMember ? '已加入' : canJoin ? '可加入' : '已开场'}
        </span>
      </div>
      <div>
        <strong>{status.label}</strong>
        <p>{room.packLabel ?? status.detail}</p>
      </div>
      <footer>
        <span>{room.memberCount} 人</span>
        <time dateTime={new Date(room.createdAt).toISOString()}>{formatRoomDate(room.createdAt)} 创建</time>
        <b>{isMember ? status.action : canJoin ? '加入房间' : '等待下一局'} <i aria-hidden="true">{canJoin || isMember ? '→' : ''}</i></b>
      </footer>
    </>
  );

  if (isMember) {
    return <Link className={styles.roomCard} href={`/rooms/${room.code}`} aria-label={`${status.action} ${room.code}`}>{content}</Link>;
  }
  if (canJoin) {
    return (
      <form className={styles.roomCard} action="/api/rooms/join" method="post">
        <input type="hidden" name="code" value={room.code} />
        <button className={styles.roomCardSubmit} type="submit" aria-label={`加入房间 ${room.code}`} />
        {content}
      </form>
    );
  }
  return <article className={styles.roomCard}>{content}</article>;
}

export default async function RoomsPage({ searchParams }: RoomsPageProps) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  if (!user) redirect('/#account');

  const rooms = listRooms(user.id);
  const packs = listFrozenPackVersions();
  const [recentRoom, ...olderRooms] = rooms;
  const runningCount = rooms.filter((room) => room.status === 'running').length;
  const currentCount = rooms.filter((room) => room.status !== 'completed').length;
  const joinedCount = rooms.filter((room) => Boolean(room.isMember)).length;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const deleted = Array.isArray(params.deleted) ? params.deleted[0] : params.deleted;
  const errorMessage = error === 'join'
    ? '这个房间当前不能加入，可能已经开场或刚刚结束。'
    : error === 'create'
      ? '房间暂时没有创建成功，请稍后重试。'
      : null;

  return (
    <main className={styles.shell}>
      <a className={styles.skipLink} href="#lobby-content">跳到大厅内容</a>

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="返回暗格首页">
            <span className={styles.brandMark} aria-hidden="true">藤</span>
            <span className={styles.brandText}><strong>暗格</strong><small>房间大厅</small></span>
          </Link>

          <nav className={styles.nav} aria-label="大厅导航">
            <Link href="/">首页</Link>
            <a href="#current-rooms">当前房间</a>
            <a href="#create-room">创建房间</a>
          </nav>

          <div className={styles.account}>
            <span className={styles.userName}>当前玩家：{user.displayName}</span>
          </div>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="lobby-title">
        <div className={styles.heroVine} aria-hidden="true" />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span aria-hidden="true" /> FRIENDS LOBBY</p>
          <h1 id="lobby-title">今晚开的房间，<em>都在这里。</em></h1>
          <p>本机首次登记用户名后会自动记住身份。以后直接查看当前房间，点一下加入；也可以自己选择剧本开一张新桌子。</p>
        </div>
        <dl className={styles.lobbyStats} aria-label="我的大厅摘要">
          <div><dt>当前房间</dt><dd>{currentCount}</dd></div>
          <div><dt>进行中</dt><dd>{runningCount}</dd></div>
          <div><dt>我已加入</dt><dd>{joinedCount}</dd></div>
        </dl>
      </section>

      <div className={styles.lobbyGrid} id="lobby-content">
        <section className={styles.roomSection} id="current-rooms" aria-labelledby="current-rooms-title">
          <div className={styles.sectionHeading}>
            <div><p className={styles.sectionKicker}>OPEN ROOMS</p><h2 id="current-rooms-title">当前房间</h2></div>
            {rooms.length ? <span>按创建时间倒序</span> : null}
          </div>

          {recentRoom ? (
            <>
              <div className={styles.recentLabel}><span>已加入的房间会优先显示</span><i aria-hidden="true" /></div>
              <RoomCard room={recentRoom} />
            </>
          ) : (
            <div className={styles.emptyState}>
              <span aria-hidden="true">◇</span>
              <div><h3>现在还没有房间</h3><p>创建一张新桌子后，朋友登录就能直接看到并加入。</p></div>
            </div>
          )}
        </section>

        <aside className={styles.actionRail} aria-label="房间操作">
          {deleted === '1' ? <p className={styles.noticeBanner} role="status">房间已删除。</p> : null}
          {errorMessage ? <p className={styles.errorBanner} role="status">{errorMessage}</p> : null}

          <form className={styles.createCard} action="/api/rooms/create" method="post" id="create-room">
            <div className={styles.cardHeading}>
              <span className={styles.actionNumber}>01</span>
              <div><p>我是发起人</p><h2>创建新房间</h2></div>
            </div>
            {packs.length ? (
              <>
                <label htmlFor="create-pack">选择剧本</label>
                <select
                  id="create-pack"
                  name="versionId"
                  required
                  defaultValue={packs.length === 1 ? packs[0].versionId : ''}
                  aria-describedby="create-pack-hint"
                >
                  {packs.length > 1 ? <option value="" disabled>请选择一个剧本</option> : null}
                  {packs.map((pack) => (
                    <option key={pack.versionId} value={pack.versionId}>{pack.publicLabel}</option>
                  ))}
                </select>
                <p className={styles.cardDescription} id="create-pack-hint">
                  创建时即锁定这个冻结版本，后续更新不会改变已经开的房间。
                </p>
                <button type="submit">创建并进入 <span aria-hidden="true">＋</span></button>
              </>
            ) : (
              <p className={styles.cardDescription}>目前没有可选的已冻结剧本，暂时不能创建房间。</p>
            )}
          </form>

          <div className={styles.versionNote}>
            <span aria-hidden="true">验</span>
            <p><strong>房间版本独立冻结</strong><small>已经开始的房间不会被后续修订悄悄改变。</small></p>
          </div>
        </aside>

        {olderRooms.length ? (
          <section className={styles.olderRooms} aria-labelledby="other-rooms-title">
            <h3 id="other-rooms-title">更多房间</h3>
            <div className={styles.roomList}>
              {olderRooms.map((room) => <RoomCard room={room} key={room.code} />)}
            </div>
          </section>
        ) : null}
      </div>

      <footer className={styles.footer}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark} aria-hidden="true">藤</span>
          <span className={styles.brandText}><strong>暗格</strong><small>让秘密留在该留的位置</small></span>
        </Link>
        <p>房间大厅 · 本机身份可查看全部当前房间</p>
      </footer>
    </main>
  );
}
