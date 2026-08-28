'use client';

import { useState } from 'react';
import styles from './home.module.css';

type AuthMode = 'login' | 'register';

export function AuthPanel({ authFailed = false }: { authFailed?: boolean }) {
  const [mode, setMode] = useState<AuthMode>('login');

  return (
    <section className={styles.authPanel} id="account" aria-labelledby="account-title">
      <div className={styles.authHeading}>
        <div>
          <p className={styles.panelKicker}>PRIVATE SESSION</p>
          <h2 id="account-title">账户入口</h2>
        </div>
        <span className={styles.secureBadge}>仅用于游戏身份</span>
      </div>

      <div className={styles.authTabs} role="tablist" aria-label="选择登录或注册">
        <button
          className={mode === 'login' ? styles.authTabActive : styles.authTab}
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          aria-controls="login-panel"
          id="login-tab"
          onClick={() => setMode('login')}
        >
          登录
        </button>
        <button
          className={mode === 'register' ? styles.authTabActive : styles.authTab}
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          aria-controls="register-panel"
          id="register-tab"
          onClick={() => setMode('register')}
        >
          注册
        </button>
      </div>

      {authFailed ? (
        <p className={styles.authError} role="alert">
          登录或注册没有成功。请检查玩家名和密码后再试一次。
        </p>
      ) : null}

      <div
        id="login-panel"
        role="tabpanel"
        aria-labelledby="login-tab"
        hidden={mode !== 'login'}
      >
        <form className={styles.authForm} action="/api/auth/login" method="post">
          <label className={styles.authField} htmlFor="login-display-name">
            <span>玩家名</span>
            <input
              id="login-display-name"
              name="displayName"
              minLength={2}
              maxLength={24}
              autoComplete="username"
              placeholder="输入你的玩家名"
              required
            />
          </label>
          <label className={styles.authField} htmlFor="login-password">
            <span>密码</span>
            <input
              id="login-password"
              name="password"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="current-password"
              placeholder="至少 8 位"
              required
            />
          </label>
          <button className={styles.authSubmit} type="submit">
            登录并进入 <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>

      <div
        id="register-panel"
        role="tabpanel"
        aria-labelledby="register-tab"
        hidden={mode !== 'register'}
      >
        <form className={styles.authForm} action="/api/auth/register" method="post">
          <label className={styles.authField} htmlFor="register-display-name">
            <span>玩家名</span>
            <input
              id="register-display-name"
              name="displayName"
              minLength={2}
              maxLength={24}
              autoComplete="username"
              placeholder="2–24 个字符"
              required
            />
          </label>
          <label className={styles.authField} htmlFor="register-password">
            <span>设置密码</span>
            <input
              id="register-password"
              name="password"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              placeholder="至少 8 位"
              required
            />
          </label>
          <button className={styles.authSubmit} type="submit">
            创建账号并进入 <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>

      <p className={styles.authFootnote}>
        账号只用于区分房间、角色与私密线索权限。
      </p>
    </section>
  );
}
