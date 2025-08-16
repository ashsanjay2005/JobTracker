import type { CaptureEntry } from '../lib/storage';

function onAnyApplyClick(callback: (ev: Event) => void): () => void {
  const handler = (ev: Event) => {
    const start = ev.target as HTMLElement | null;
    if (!start) return;
    const regex = /\b(submit application|apply|submit)\b/i;
    let el: HTMLElement | null = start;
    let hops = 0;
    while (el && hops < 5) {
      const role = el.getAttribute('role') || '';
      const tag = el.tagName?.toLowerCase() || '';
      if (tag === 'button' || tag === 'a' || role === 'button' || el.getAttribute('type') === 'submit') {
        const txt = (el.innerText || '').trim();
        if (regex.test(txt)) {
          callback(ev);
        }
        break;
      }
      el = el.parentElement;
      hops++;
    }
  };
  window.addEventListener('click', handler, { capture: true, passive: true });
  return () => window.removeEventListener('click', handler, true);
}

function bestText(selectors: string[], root: Document | Element = document): string {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const t = (el.textContent || '').trim();
      if (t) return t;
    }
  }
  return '';
}

function formatDate(): string {
  const d = new Date();
  const mon = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d);
  const day = d.getDate();
  const year = d.getFullYear();
  const suf = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `${mon} ${day}${suf(day)} ${year}`;
}

function inferCompanyFromUrl(): string {
  // https://jobs.lever.co/<company>/...
  const parts = location.pathname.split('/').filter(Boolean);
  const slug = parts[0] || '';
  if (!slug) return '';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function cleanLeverUrl(): string {
  try {
    const u = new URL(location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.host.includes('jobs.lever.co') && parts.length >= 2) {
      return `https://jobs.lever.co/${parts[0]}/${parts[1]}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch { return location.href; }
}

function textOr(el: Element | null): string { return (el?.textContent || '').trim(); }

function extract(): CaptureEntry | null {
  // Title
  const postingHeader = document.querySelector('.section.page-centered.posting-header, [class*="posting-header"]');
  let job_title = textOr(postingHeader?.querySelector('h2'));
  if (!job_title) job_title = bestText(['.posting-header h2', 'h2']);

  // Company: prefer header brand anchor or visible text; fall back to URL slug
  let company = '';
  const brandA = document.querySelector('a.main-header-logo, a[class*="header-logo" i]') as HTMLAnchorElement | null;
  if (brandA) {
    const alt = (brandA.querySelector('img')?.getAttribute('alt') || '').replace(/\s*logo\s*$/i, '').trim();
    const t = (brandA.textContent || '').replace(/\s*logo\s*$/i, '').trim();
    company = alt || t;
  }
  if (!company) company = inferCompanyFromUrl();

  // Categories: location, department, commitment, workplaceTypes
  const cats = postingHeader?.querySelector('.posting-categories') || document.querySelector('.posting-categories');
  const locRaw = textOr(cats?.querySelector('.location, [class*="location" i]'));
  const department = textOr(cats?.querySelector('.department, [class*="department" i]'));
  const commitment = textOr(cats?.querySelector('.commitment, [class*="commitment" i]'));
  const workplaceRaw = textOr(cats?.querySelector('.workplaceTypes, [class*="workplacetypes" i], [class*="workplace" i]'));

  const normalizeTrailing = (s: string) => s.replace(/\s*\/+\s*$/,'').trim();
  const normalizeWorkplace = (s: string) => {
    const t = s.toLowerCase();
    if (!t) return '';
    if (t.includes('remote')) return 'Remote';
    if (t.includes('hybrid')) return 'Hybrid';
    if (t.includes('on-site') || t.includes('on site')) return 'On-site';
    return s.trim();
  };
  const commitmentClean = normalizeTrailing(commitment);
  const workplace = normalizeWorkplace(workplaceRaw);
  const locClean = normalizeTrailing(locRaw);
  const location = workplace ? (locClean ? `${locClean}, (${workplace})` : `(${workplace})`) : locClean;
  const job_timeline = commitmentClean;

  // URL
  const job_posting_url = cleanLeverUrl();

  if (!job_title || !company) return null;
  return {
    date_applied: formatDate(),
    job_title,
    company,
    location,
    job_posting_url,
    salary_text: '',
    listing_posted_date: '',
    job_timeline
  };
}

function send(entry: CaptureEntry, shouldToast: boolean) {
  chrome.runtime.sendMessage({ type: 'append-entry', entry }, undefined, (res) => {
    if (shouldToast && res?.appended) {
      const d = document.createElement('div');
      d.textContent = 'Job added to Google Sheet ✓';
      d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), 2200);
    }
  });
}

let detachClick: (() => void) | null = null;
let mo: MutationObserver | null = null;

let lastClickAt = 0;

function init() {
  if (detachClick) return;
  chrome.runtime.sendMessage({ type: 'get-settings' }, undefined, (res) => {
    const settings = res?.settings || {};
    if (!settings.enableGeneric) return; // piggyback on generic toggle
    // Capture submit button clicks
    detachClick = onAnyApplyClick(() => {
      const now = Date.now();
      if (now - lastClickAt < 1000) return; // debounce
      lastClickAt = now;
      const entry = extract();
      if (entry) send(entry, !!settings.showToast);
    });
    mo = new MutationObserver(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      if (/application submitted|thanks for applying|application received/i.test(txt)) {
        const entry = extract();
        if (entry) send(entry, !!settings.showToast);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}

init();


