export function textContent(el: Element | null | undefined): string {
  return (el?.textContent || '').trim();
}

export function findButtonByText(regex: RegExp): HTMLButtonElement | HTMLAnchorElement | null {
  const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"]')) as Array<HTMLElement>;
  for (const el of candidates) {
    const txt = el.textContent?.trim() || '';
    if (regex.test(txt)) return el as any;
  }
  return null;
}

export function onAnyApplyClick(callback: (ev: Event) => void): () => void {
  const handler = (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const path = ev.composedPath ? (ev.composedPath() as HTMLElement[]) : [];
    const nodes = path.length ? path : [target];
    const regex = /\b(easy apply|apply|submit|next|continue)\b/i;
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const role = node.getAttribute('role') || '';
      const tag = node.tagName.toLowerCase();
      const txt = node.textContent?.trim() || '';
      if (['button'].includes(tag) || role === 'button' || tag === 'a') {
        if (regex.test(txt)) {
          callback(ev);
          break;
        }
      }
    }
  };
  window.addEventListener('click', handler, { capture: true, passive: true });
  return () => window.removeEventListener('click', handler, true);
}

export function observeMutations(callback: () => void): MutationObserver {
  const obs = new MutationObserver(() => {
    callback();
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  return obs;
}

export function onSpaRouteChange(callback: () => void): () => void {
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  const fire = () => setTimeout(callback, 0);
  history.pushState = function (...args: any[]) {
    // @ts-ignore
    const ret = pushState.apply(this, args);
    fire();
    return ret;
  } as any;
  history.replaceState = function (...args: any[]) {
    // @ts-ignore
    const ret = replaceState.apply(this, args);
    fire();
    return ret;
  } as any;
  window.addEventListener('popstate', fire);
  return () => window.removeEventListener('popstate', fire);
}

export function visibleText(selector: string): string {
  const el = document.querySelector(selector);
  if (!el) return '';
  const style = getComputedStyle(el as Element);
  if (style && style.display === 'none' || style.visibility === 'hidden') return '';
  return (el.textContent || '').trim();
}


