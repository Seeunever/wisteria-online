import { getCurrentUser } from '@/lib/auth';
import Link from 'next/link';
import { AuthPanel } from './auth-panel';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

const publicClues = [
  { code: 'C-03', phase: '第一阶段', status: '刚刚公开' },
  { code: 'C-08', phase: '第二阶段', status: '2 分钟前' },
  { code: 'C-11', phase: '第二阶段', status: '5 分钟前' },
];

const flow = [
  ['01', '创建账号，进入自己的玩家身份'],
  ['02', '加入房间，选择唯一角色'],
  ['03', '搜索当前阶段开放的地点'],
  ['04', '保留私藏，或主动公开到大看板'],
];

type HomeProps = {
  searchParams: Promise<{ auth?: string | string[] }>;
};

function WisteriaVine() {
  return (
    <svg className={styles.heroVine} viewBox="0 0 360 520" aria-hidden="true">
      <path d="M330 0C280 92 326 151 239 212c-76 54-35 130-142 211-40 30-63 63-79 97" />
      <path className={styles.vineBranch} d="M271 142c-57-12-90 23-103 76M217 257c58-7 89 20 104 65M119 397c-39-18-70-2-88 24" />
      <g className={styles.vineLeaves}>
        <path d="M279 87c-53-6-79 26-76 67 47 4 75-20 76-67Z" />
        <path d="M248 203c52-8 82 20 84 59-45 6-75-14-84-59Z" />
        <path d="M151 340c-45-15-76 6-83 41 39 14 70-2 83-41Z" />
      </g>
      <g className={styles.vineFlowers}>
        <circle cx="181" cy="190" r="17" />
        <circle cx="158" cy="214" r="15" />
        <circle cx="188" cy="225" r="14" />
        <circle cx="145" cy="240" r="13" />
        <circle cx="172" cy="250" r="12" />
        <circle cx="151" cy="272" r="10" />
      </g>
    </svg>
  );
}

export default async function Home({ searchParams }: HomeProps) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  const accountHref = user ? '/rooms' : '#account';
  const authFailed = params.auth === 'failed';

  return (
    <main className={styles.home}>
      <a className={styles.skipLink} href="#main-content">跳到主要内容</a>

      <header className={styles.siteHeader}>
        <div className={styles.headerInner}>
          <a className={styles.brand} href="#top" aria-label="暗格首页">
            <span className={styles.brandMark} aria-hidden="true">藤</span>
            <span className={styles.brandText}>
              <strong>暗格</strong>
              <small>在线剧本游戏</small>
            </span>
          </a>

          <nav className={styles.primaryNav} aria-label="主导航">
            <a href="#how">怎么玩</a>
            <a href="#board">公开看板</a>
            <a href="#safety">数据边界</a>
          </nav>

          <div className={styles.accountActions}>
            {user ? (
              <>
                <span className={styles.userChip}>{user.displayName}</span>
                <form action="/api/auth/logout" method="post">
                  <button className={styles.logoutButton} type="submit">退出</button>
                </form>
              </>
            ) : null}
            <a className={styles.headerCta} href={accountHref}>
              {user ? '我的房间' : '登录 / 注册'}
            </a>
          </div>
        </div>
      </header>

      <div id="main-content">
        <section className={styles.hero} id="top">
          <WisteriaVine />
          <div className={styles.heroGlow} aria-hidden="true" />

          <div className={styles.heroInner}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}><span aria-hidden="true" /> 豪门惊情 · 多人在线剧本游戏</p>
                <h1>让秘密留在暗格里，<em>直到你决定公开。</em></h1>
                <p className={styles.heroDescription}>
                  创建房间、选择角色、搜索地点。拿到的线索先只属于你，真正公开后才会进入全房间的大看板。
                </p>
                <div className={styles.heroActions}>
                  <a className={styles.primaryButton} href={accountHref}>
                    {user ? '继续我的游戏' : '开始游戏'}
                    <span aria-hidden="true">→</span>
                  </a>
                  <a className={styles.secondaryButton} href="#how">了解玩法</a>
                </div>
                <div className={styles.versionNote}>
                  <span className={styles.versionSeal} aria-hidden="true">验</span>
                  <span>
                    <strong>剧本版本独立冻结</strong>
                    <small>已开局房间不会被后续修订悄悄改变</small>
                  </span>
                </div>
              </div>

              {user ? (
                <section className={styles.welcomePanel} id="account" aria-labelledby="welcome-title">
                  <div className={styles.authHeading}>
                    <div>
                      <p className={styles.panelKicker}>SESSION ACTIVE</p>
                      <h2 id="welcome-title">欢迎回来，{user.displayName}</h2>
                    </div>
                    <span className={styles.onlineBadge}><i aria-hidden="true" /> 已登录</span>
                  </div>
                  <p className={styles.welcomeCopy}>
                    你的房间、角色与线索权限已经准备好。进入大厅继续上一局，或者创建一个新房间。
                  </p>
                  <Link className={styles.authSubmit} href="/rooms">
                    进入房间大厅 <span aria-hidden="true">→</span>
                  </Link>
                  <dl className={styles.sessionFacts}>
                    <div><dt>身份</dt><dd>已验证玩家</dd></div>
                    <div><dt>私密内容</dt><dd>按房间授权</dd></div>
                    <div><dt>公开线索</dt><dd>主动公开后可见</dd></div>
                  </dl>
                </section>
              ) : (
                <AuthPanel authFailed={authFailed} />
              )}
            </div>

            <div className={styles.heroFlow} aria-label="核心玩法">
              <div className={styles.flowItem}><span>01</span><p><strong>搜索地点</strong><small>调查当前阶段允许的区域</small></p></div>
              <div className={styles.flowItem}><span>02</span><p><strong>私藏线索</strong><small>获得后默认仅持有者可见</small></p></div>
              <div className={styles.flowItem}><span>03</span><p><strong>公开看板</strong><small>主动公开后全房间同步浏览</small></p></div>
            </div>

            <section className={styles.boardPreview} id="board" aria-labelledby="board-title">
              <div className={styles.boardIntro}>
                <p className={styles.panelKicker}>PUBLIC BOARD</p>
                <h2 id="board-title">公开线索，一览无余</h2>
                <p>编号、阶段和公开状态固定可见；未公开内容不会出现在这里。</p>
                <a href={accountHref}>进入房间看板 <span aria-hidden="true">→</span></a>
              </div>
              <div className={styles.cluePreviewGrid}>
                {publicClues.map((clue) => (
                  <article className={styles.publicClue} key={clue.code} aria-label={`公开线索 ${clue.code}`}>
                    <span className={styles.clueCode}>{clue.code}</span>
                    <div className={styles.clueLines} aria-hidden="true"><i /><i /><i /></div>
                    <footer><span>{clue.phase}</span><time>{clue.status}</time></footer>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>

        <section className={styles.howSection} id="how" aria-labelledby="how-title">
          <div className={styles.howIntro}>
            <p className={styles.eyebrow}><span aria-hidden="true" /> 从入座到公开</p>
            <h2 id="how-title">复杂交给系统，<br />玩家只管入戏。</h2>
            <p>每一步都围绕当前任务展开。角色秘密和私藏线索由服务端按身份与阶段授权，不靠页面隐藏来假装保密。</p>
          </div>
          <ol className={styles.workflowList}>
            {flow.map(([number, label]) => (
              <li key={number}><span>{number}</span><strong>{label}</strong><i aria-hidden="true">↗</i></li>
            ))}
          </ol>
        </section>

        <section className={styles.integrityStrip} id="safety" aria-label="数据与权限保证">
          <div><span className={styles.integrityIcon} aria-hidden="true">◇</span><p><strong>正反面强绑定</strong><small>每张线索卡使用同一稳定编号</small></p></div>
          <div><span className={styles.integrityIcon} aria-hidden="true">✓</span><p><strong>编号自动核验</strong><small>重复、缺页与错配在导入时阻断</small></p></div>
          <div><span className={styles.integrityIcon} aria-hidden="true">▣</span><p><strong>权限服务端判定</strong><small>私密内容不会随公共页面下发</small></p></div>
        </section>
      </div>

      <footer className={styles.siteFooter}>
        <a className={styles.brand} href="#top">
          <span className={styles.brandMark} aria-hidden="true">藤</span>
          <span className={styles.brandText}><strong>暗格</strong><small>让秘密留在该留的位置</small></span>
        </a>
        <p>阶段 2 · 响应式首页与账户入口</p>
      </footer>
    </main>
  );
}
