'use client';

import type { MouseEvent } from 'react';

export function StartGameLink({ className }: { className: string }) {
  function focusPlayerName(event: MouseEvent<HTMLAnchorElement>) {
    const input = document.getElementById('display-name');
    if (!(input instanceof HTMLInputElement)) return;
    event.preventDefault();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }

  return (
    <a className={className} href="#display-name" onClick={focusPlayerName} aria-controls="account">
      填写玩家名
      <span aria-hidden="true">→</span>
    </a>
  );
}
