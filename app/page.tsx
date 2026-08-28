import { getCurrentUser } from '@/lib/auth';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const publicClues = [
  { code: 'X-03', phase: '第一轮', status: '刚刚公开' },
  { code: 'X-11', phase: '第一轮', status: '2 分钟前' },
  { code: 'X-16', phase: '第二轮', status: '5 分钟前' },
];

const flow = [
  ['01', '登录并创建玩家档案'],
  ['02', '加入房间，锁定自己的角色'],
  ['03', '进入开放区域搜证'],
  ['04', '私藏线索，或公开到全员看板'],
];

export default async function Home() {
  const user = await getCurrentUser();
  const accountHref = user ? '/rooms' : '#account';

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="暗格首页">
          <span className="brand-mark" aria-hidden="true">暗</span>
          <span>
            <strong>暗格</strong>
            <small>在线剧本杀</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <a href="#games">剧本库</a>
          <a href="#board">公开看板</a>
          <a href="#workflow">怎么玩</a>
        </nav>
        <div className="account-actions">
          {user ? (
            <>
              <span className="user-chip">{user.displayName}</span>
              <form action="/api/auth/logout" method="post">
                <button className="quiet-link link-button" type="submit">退出</button>
              </form>
            </>
          ) : null}
          <a className="header-cta" href={accountHref}>
            {user ? '进入我的房间' : '登录 / 注册'}
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> 多人在线 · 私密搜证 · 实时公开</p>
          <h1>线索找到以后，<em>由你决定何时公开。</em></h1>
          <p className="lede">
            登录、选本、锁定角色，和同桌玩家同步推进。搜到的线索先进入你的私藏，公开后才会出现在全员大看板。
          </p>
          <div className="hero-actions">
            <a className="primary-button" href={accountHref}>
              {user ? '继续我的游戏' : '登录或创建账号'}
              <span aria-hidden="true">→</span>
            </a>
            <a className="secondary-button" href="#board">浏览公开看板</a>
          </div>
          <div className="practice-note" id="games">
            <span className="practice-seal">练习本</span>
            <p>
              <strong>紫藤夫人</strong>
              <small>正在导入角色、阶段与线索卡配对数据</small>
            </p>
          </div>
        </div>

        <div className="search-console" aria-label="搜证操作预览">
          <div className="console-topline">
            <span>房间 WG-1027</span>
            <span className="live-dot">游戏进行中</span>
          </div>
          <div className="console-title">
            <div><small>当前开放</small><h2>搜证区域 A</h2></div>
            <span className="search-count">剩余 2 次</span>
          </div>
          <button className="search-button" type="button">
            <span className="lens" aria-hidden="true" />开始搜证
          </button>
          <article className="private-clue">
            <div className="clue-stamp">X-27</div>
            <div>
              <p>已收入你的私藏</p>
              <small>其他玩家看不到这张线索</small>
            </div>
            <button type="button">公开</button>
          </article>
          <p className="privacy-line"><span aria-hidden="true">●</span> 私藏内容不会进入房间广播或公开记录</p>
        </div>
      </section>

      <section className="account-section" id="account">
        <div className="account-copy">
          <p className="eyebrow">PRIVATE SESSION</p>
          <h2>{user ? `欢迎回来，${user.displayName}` : '先认领一个只属于你的玩家身份。'}</h2>
          <p>
            账号只用于房间和角色权限。密码会经过本地强哈希保存；未加入房间的人无法探测其中的角色、阶段或线索。
          </p>
          {user ? <Link className="primary-button account-link" href="/rooms">进入房间大厅 →</Link> : null}
        </div>
        {!user ? (
          <div className="auth-grid">
            <form className="auth-card" action="/api/auth/login" method="post">
              <span>已有账号</span>
              <label>玩家名<input name="displayName" minLength={2} maxLength={24} autoComplete="username" required /></label>
              <label>密码<input name="password" type="password" minLength={8} maxLength={128} autoComplete="current-password" required /></label>
              <button type="submit">登录</button>
            </form>
            <form className="auth-card" action="/api/auth/register" method="post">
              <span>第一次来</span>
              <label>玩家名<input name="displayName" minLength={2} maxLength={24} autoComplete="username" required /></label>
              <label>密码<input name="password" type="password" minLength={8} maxLength={128} autoComplete="new-password" required /></label>
              <button type="submit">注册并进入</button>
            </form>
          </div>
        ) : null}
      </section>

      <section className="board-section" id="board">
        <div className="section-heading">
          <div>
            <p className="eyebrow">所有玩家同步可见</p>
            <h2>公开线索大看板</h2>
          </div>
          <p>只展示玩家主动公开的线索。编号、正面与背面绑定在同一张卡上，不再靠数组顺序碰运气。</p>
        </div>
        <div className="board-grid">
          {publicClues.map((clue, index) => (
            <article className="board-card" key={clue.code}>
              <div className="card-index">0{index + 1}</div>
              <div className="card-art" aria-hidden="true"><span>{clue.code}</span><i /></div>
              <div className="card-meta">
                <div><strong>线索 {clue.code}</strong><small>{clue.phase}</small></div>
                <span>{clue.status}</span>
              </div>
            </article>
          ))}
          <article className="board-card board-summary">
            <span className="summary-kicker">PUBLIC BOARD</span>
            <strong>所有公开信息，一眼看全</strong>
            <p>按公开顺序稳定排列，可按阶段、区域或编号筛选。</p>
            <a href={accountHref}>进入房间看板 →</a>
          </article>
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="workflow-intro">
          <p className="eyebrow">从盒装 PDF 到在线开局</p>
          <h2>把复杂留给系统，玩家只管入戏。</h2>
          <p>每个房间固定一个经过复核的剧本版本。角色内容、未公开线索和原始素材都按权限隔离。</p>
        </div>
        <ol className="workflow-list">
          {flow.map(([number, label]) => (
            <li key={number}><span>{number}</span><strong>{label}</strong></li>
          ))}
        </ol>
      </section>

      <section className="integrity-strip" aria-label="线索数据质量保证">
        <div><strong>正反面强绑定</strong><span>每张卡拥有唯一 cardId</span></div>
        <div><strong>编号自动核验</strong><span>重复、缺页、错配直接阻断导入</span></div>
        <div><strong>剧本版本冻结</strong><span>已开局房间不受后续修订影响</span></div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark" aria-hidden="true">暗</span>
          <span><strong>暗格</strong><small>让秘密留在该留的位置</small></span>
        </a>
        <p>练手版本 · 使用紫藤夫人结构数据验证中</p>
      </footer>
    </main>
  );
}
