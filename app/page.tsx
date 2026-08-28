import { getCurrentUser } from '@/lib/auth';
import Link from 'next/link';
import { AuthPanel } from './auth-panel';
import { StartGameLink } from './start-game-link';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

const publicClues = [
  { code: 'C-03', phase: '第一阶段', status: '刚刚公开' },
  { code: 'C-08', phase: '第二阶段', status: '2 分钟前' },
  { code: 'C-11', phase: '第二阶段', status: '5 分钟前' },
];

const flow = [
  ['01', '输入用户名，进入自己的玩家身份'],
  ['02', '加入房间，选择唯一角色'],
  ['03', '搜索当前阶段开放的地点'],
  ['04', '保留私藏，或主动公开到大看板'],
];

type HomeProps = {
  searchParams: Promise<{ auth?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  const accountHref = user ? '/rooms' : '#account';
  const authError = Array.isArray(params.auth) ? params.auth[0] : params.auth;

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
              <span className={styles.userChip}>当前玩家：{user.displayName}</span>
            ) : null}
            <a className={styles.headerCta} href={accountHref}>
              {user ? '我的房间' : '玩家入口'}
            </a>
          </div>
        </div>
      </header>

      <div id="main-content">
        <section className={styles.hero} id="top">
          <div className={styles.heroVine} aria-hidden="true" />
          <div className={styles.heroGlow} aria-hidden="true" />

          <div className={styles.heroInner}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}><span aria-hidden="true" /> 豪门惊情 · 多人在线剧本游戏</p>
                <h1>
                  让秘密留在<br className={styles.mobileTitleBreak} />暗格里，
                  <em>直到你决定<br className={styles.mobileTitleBreak} />公开。</em>
                </h1>
                <p className={styles.heroDescription}>
                  创建房间、选择角色、搜索地点。拿到的线索先只属于你，真正公开后才会进入全房间的大看板。
                </p>
                <div className={styles.heroActions}>
                  {user ? (
                    <Link className={styles.primaryButton} href={accountHref}>
                      继续我的游戏 <span aria-hidden="true">→</span>
                    </Link>
                  ) : <StartGameLink className={styles.primaryButton} />}
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
                    <p className={styles.panelKicker}>DEVICE PROFILE</p>
                      <h2 id="welcome-title">欢迎回来，{user.displayName}</h2>
                    </div>
                    <span className={styles.onlineBadge}><i aria-hidden="true" /> 本机身份</span>
                  </div>
                  <p className={styles.welcomeCopy}>
                    这台设备已经认出你，不需要再次登录。进入大厅继续上一局，或者创建一个新房间。
                  </p>
                  <Link className={styles.authSubmit} href="/rooms">
                    进入房间大厅 <span aria-hidden="true">→</span>
                  </Link>
                  <dl className={styles.sessionFacts}>
                    <div><dt>身份</dt><dd>{user.displayName}</dd></div>
                    <div><dt>私密内容</dt><dd>按房间授权</dd></div>
                    <div><dt>公开线索</dt><dd>主动公开后可见</dd></div>
                  </dl>
                </section>
              ) : (
                <AuthPanel error={authError} />
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
        <p>阶段 3 · 紫藤深宅视觉资产</p>
      </footer>
    </main>
  );
}
