import type { CaptureEntry } from '../lib/storage';
function onAnyApplyClick(callback: (ev: Event) => void): () => void {
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
function observeMutations(callback: () => void): MutationObserver {
  const obs = new MutationObserver(() => callback());
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  return obs;
}
function onSpaRouteChange(callback: () => void): () => void {
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

function formatDate(): string {
  const d = new Date();
  const options: Intl.DateTimeFormatOptions = { month: 'short' };
  const mon = new Intl.DateTimeFormat('en-US', options).format(d);
  const day = d.getDate();
  const year = d.getFullYear();
  const suffix = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `${mon} ${day}${suffix(day)} ${year}`;
}

function qsText(sel: string, root: Document | Element = document): string {
  const el = root.querySelector(sel);
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function cleanWorkdayUrl(href: string): string {
  try {
    const u = new URL(href || location.href, location.origin);
    // Drop query/hash
    let path = u.pathname;
    // Remove trailing /apply and anything after
    path = path.replace(/\/(apply|[?].*)$/i, '');
    return `${u.origin}${path}`;
  } catch { return href || location.href; }
}

function inferCompanyFromHeader(): string {
  const headerTitle = qsText('[data-automation-id="headerTitle"] h1');
  if (headerTitle) {
    const c = headerTitle.replace(/\s+careers\s*$/i, '').trim();
    if (c) return c;
  }
  // Try to pull a brand from path like /recruiting/<org>/<brand>
  const m1 = location.pathname.match(/\/recruiting\/[^/]+\/([A-Za-z][A-Za-z0-9_-]+)/i);
  if (m1 && m1[1]) return m1[1].replace(/[_-]+/g, ' ').replace(/\s+careers\s*$/i, '').replace(/\s+/g, ' ').trim();
  // Try token before _External_Careers in path
  const m2 = location.pathname.match(/\/([A-Za-z][A-Za-z0-9_-]+)_External_Careers/i);
  if (m2 && m2[1]) return m2[1].replace(/[_-]+/g, ' ');
  // Host fallback
  const host = location.host.split('.')[0];
  return host.charAt(0).toUpperCase() + host.slice(1);
}

function extract(): CaptureEntry | null {
  // Title
  let job_title = qsText('h2[data-automation-id="jobPostingHeader"]');
  if (!job_title) job_title = qsText('[data-automation-id="jobPostingPage"] h2');

  // Company
  let company = inferCompanyFromHeader();

  // Location (optional for now)
  let locationText = '';
  const locContainer = document.querySelector('[data-automation-id="jobPostingPage"] [data-automation-id="locations"], [data-automation-id="locations"]') as Element | null;
  if (locContainer) {
    const dd = locContainer.querySelector('dd');
    if (dd) locationText = (dd.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Time type
  const job_timeline = qsText('[data-automation-id="time"] dd');

  // Posted relative
  const postedRel = qsText('[data-automation-id="postedOn"] dd');

  // URL
  const job_posting_url = cleanWorkdayUrl(location.href);

  if (!job_title || !company) return null;
  const entry: CaptureEntry = {
    date_applied: formatDate(),
    job_title,
    company,
    location: locationText,
    job_posting_url,
    salary_text: '',
    listing_posted_date: postedRel,
    posted_relative: postedRel,
    job_timeline
  };
  try { console.debug('[workday][send]', entry); } catch {}
  return entry;
}

function showToast() {
  const d = document.createElement('div');
  d.className = 'jt-toast';
  d.textContent = 'Logged to sheet.';
  d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
  document.documentElement.appendChild(d);
  setTimeout(() => { d.remove(); }, 2200);
}

async function send(entry: CaptureEntry, shouldToast: boolean) {
  try {
    const res = await new Promise<any>((resolve) => {
      chrome.runtime.sendMessage({ type: 'workday-capture', entry }, (r) => resolve(r));
    });
    try { console.debug('[workday][resp]', res); } catch {}
    if (res?.ok && res.reason === 'appended') {
      if (shouldToast) showToast();
    } else if (res?.ok && res.reason === 'duplicate') {
      if (shouldToast) {
        const d = document.createElement('div');
        d.className = 'jt-toast';
        d.textContent = 'Already captured — skipped.';
        d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
        document.documentElement.appendChild(d);
        setTimeout(() => { d.remove(); }, 2200);
      }
    } else if (res?.ok && res.reason === 'inflight') {
      // optional quiet: no toast
    } else {
      const d = document.createElement('div');
      d.className = 'jt-toast';
      d.textContent = 'Log failed. Check console.';
      d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(127,29,29,0.95);color:#fee2e2;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
      document.documentElement.appendChild(d);
      setTimeout(() => { d.remove(); }, 2200);
    }
  } catch (e) {
    try { console.error('[workday] sendMessage failed', e); } catch {}
  }
}

let detachClick: (() => void) | null = null;
let mo: MutationObserver | null = null;
let unhookRoute: (() => void) | null = null;

function init() {
  if (detachClick) return;
  chrome.runtime.sendMessage({ type: 'get-settings' }, undefined, (res) => {
    const settings = res?.settings || {};
    if (!settings.enableWorkday) return;
  let lastAt = 0;
  detachClick = onAnyApplyClick(() => {
    const pathOk = /workday|myworkdayjobs/.test(location.hostname);
    if (!pathOk) return;
    const now = Date.now();
    if (now - lastAt < 500) return; // debounce per URL
    lastAt = now;
    // Ensure target is an Apply button, prefer adventureButton
    const t = (document.activeElement as HTMLElement | null) || document.body;
    const inApply = !!document.querySelector('[data-automation-id="adventureButton"], a[data-automation-id="adventureButton"], button[data-automation-id="adventureButton"]');
    if (!inApply) return; // conservative
    const entry = extract();
    if (entry) send(entry, !!settings.showToast);
  });
    mo = observeMutations(() => {});
    unhookRoute = onSpaRouteChange(() => {});
  });
}

init();


