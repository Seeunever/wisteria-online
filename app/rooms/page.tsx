import { getCurrentUser } from '@/lib/auth';
import { listRooms } from '@/lib/rooms';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function RoomsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/#account');
  const rooms = listRooms(user.id);

  return (
    <main className="rooms-shell">
      <header className="room-header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">暗</span>
          <span><strong>暗格</strong><small>房间大厅</small></span>
        </Link>
        <div><span>{user.displayName}</span><form action="/api/auth/logout" method="post"><button className="quiet-link link-button" type="submit">退出</button></form></div>
      </header>

      <section className="rooms-hero">
        <p className="eyebrow">ROOM CONTROL</p>
        <h1>开一个房间，或者凭房间码归队。</h1>
        <p>房间会锁定剧本版本。之后导入修订版，也不会悄悄改变已经开始的那一局。</p>
      </section>

      <section className="room-actions-grid">
        <form className="room-action-card" action="/api/rooms/create" method="post">
          <span>我是发起人</span><h2>创建新房间</h2><p>先建立空房间，再选择已冻结的剧本版本。</p><button type="submit">创建房间</button>
        </form>
        <form className="room-action-card" action="/api/rooms/join" method="post">
          <span>朋友已经开房</span><h2>输入房间码</h2><label>六位房间码<input name="code" minLength={6} maxLength={6} autoComplete="off" required /></label><button type="submit">加入房间</button>
        </form>
      </section>

      <section className="room-list-section">
        <div><p className="eyebrow">MY ROOMS</p><h2>我的房间</h2></div>
        {rooms.length ? (
          <div className="room-list">{rooms.map((room) => (
            <a href={`/rooms/${room.code}`} key={room.code}>
              <strong>{room.code}</strong><span>{room.status === 'lobby' ? '等待开局' : '游戏进行中'}</span><small>{room.memberCount} 人 · {room.isOwner ? '房主' : '成员'}</small>
            </a>
          ))}</div>
        ) : <p className="empty-state">这里还没有房间。开一间，桌子就支起来了。</p>}
      </section>
    </main>
  );
}
