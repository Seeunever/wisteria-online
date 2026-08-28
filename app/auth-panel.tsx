'use client';

import { useState, type FormEvent } from 'react';
import styles from './home.module.css';

export function AuthPanel({ error }: { error?: string }) {
  const [clientError, setClientError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const serverError = error === 'claimed'
    ? '这个用户名已经绑定在另一台设备上，请换一个名字。'
    : error === 'device-bound'
      ? '这台设备已经绑定了另一个玩家名，请继续使用原来的名字。'
      : error
        ? '没有进入成功。用户名可使用 1–24 个中文、字母、数字、空格、_ 或 -。'
        : null;
  const errorMessage = clientError ?? serverError;

  function submitIdentity(event: FormEvent<HTMLFormElement>) {
    const input = event.currentTarget.elements.namedItem('displayName');
    if (!(input instanceof HTMLInputElement)) return;
    const displayName = input.value.normalize('NFKC').trim();
    const length = Array.from(displayName).length;
    if (!displayName) {
      event.preventDefault();
      setClientError('先填一个玩家名，再进入游戏。');
      input.focus();
      return;
    }
    if (length > 24 || !/^[\p{L}\p{N}_ -]+$/u.test(displayName)) {
      event.preventDefault();
      setClientError('玩家名可使用 1–24 个中文、字母、数字、空格、_ 或 -。');
      input.focus();
      return;
    }
    setClientError(null);
    setSubmitting(true);
  }

  return (
    <section className={styles.authPanel} id="account" aria-labelledby="account-title">
      <div className={styles.authHeading}>
        <div>
          <p className={styles.panelKicker}>PRIVATE SESSION</p>
          <h2 id="account-title">玩家入口</h2>
        </div>
        <span className={styles.secureBadge}>仅用于游戏身份</span>
      </div>

      {errorMessage ? (
        <p className={styles.authError} id="identity-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <form
        className={styles.authForm}
        action="/api/auth/enter"
        method="post"
        noValidate
        onSubmit={submitIdentity}
      >
        <label className={styles.authField} htmlFor="display-name">
          <span>玩家名</span>
          <input
            id="display-name"
            name="displayName"
            minLength={1}
            maxLength={24}
            autoComplete="username"
            placeholder="输入你要使用的名字"
            pattern={'[\\p{L}\\p{N}_ -]+'}
            aria-describedby="identity-hint identity-error"
            aria-invalid={Boolean(errorMessage)}
            onInput={() => setClientError(null)}
            required
          />
        </label>
        <button className={styles.authSubmit} type="submit" disabled={submitting}>
          {submitting ? '正在进入…' : '用这个名字进入'} <span aria-hidden="true">→</span>
        </button>
      </form>

      <p className={styles.authFootnote} id="identity-hint">
        不需要密码。首次使用会把这个玩家名安全绑定到当前设备。
      </p>
    </section>
  );
}
