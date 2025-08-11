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

function extract(): CaptureEntry | null {
  const job_title = bestText([
    'h1',
    '[data-qa="posting-name"]',
    '.posting-header h2',
    'h2'
  ]);
  let company = bestText(['.posting-header .company', '.company-name']);
  if (!company) company = inferCompanyFromUrl();
  const location = bestText(['[data-qa="posting-location"]', '.sort-by-time posting-categories .location', '.posting-categories .location', '.location']);
  const posted = bestText(['[data-qa="posting-posted-date"]']);
  const job_posting_url = location.href.split('?')[0];
  let salary_text = '';
  const pageText = (document.body?.innerText || '').slice(0, 20000);
  const salaryMatch = pageText.match(/\$\s?\d[\d,]*(?:\s?[kK])?(?:\s?[-–]\s?\$?\d[\d,]*(?:\s?[kK])?)?/);
  if (salaryMatch) salary_text = salaryMatch[0];
  let job_timeline = '';
  const tl = pageText.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
  if (tl) job_timeline = tl[0];

  if (!job_title || !company) return null;
  return {
    date_applied: formatDate(),
    job_title,
    company,
    location,
    job_posting_url,
    salary_text,
    listing_posted_date: posted,
    job_timeline
  };
}

function send(entry: CaptureEntry, shouldToast: boolean) {
  chrome.runtime.sendMessage({ type: 'append-entry', entry }, (res) => {
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

function init() {
  if (detachClick) return;
  chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
    const settings = res?.settings || {};
    if (!settings.enableGeneric) return; // piggyback on generic toggle
    detachClick = onAnyApplyClick(() => {
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


