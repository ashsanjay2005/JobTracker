import type { CaptureEntry } from '../lib/storage';
function onAnyApplyClick(callback: (ev: Event) => void): () => void {
  const handler = (ev: Event) => {
    const start = ev.target as HTMLElement | null;
    if (!start) return;
    const regex = /\b(easy apply|apply|submit|next|continue)\b/i;
    const deny = /\b(view|find|see|browse|explore)\s+(jobs?|roles?|openings?)\b/i;
    let el: HTMLElement | null = start;
    let hops = 0;
    while (el && hops < 4) {
      const role = el.getAttribute('role') || '';
      const tag = el.tagName?.toLowerCase() || '';
      if (tag === 'button' || tag === 'a' || role === 'button') {
        const txt = (el.innerText || '').trim();
        if (regex.test(txt) && !deny.test(txt)) {
          // Only proceed if the page looks like an application flow
          if (hasApplicationSignals()) callback(ev);
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
  const mon = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d);
  const day = d.getDate();
  const year = d.getFullYear();
  const suf = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `${mon} ${day}${suf(day)} ${year}`;
}

function bestText(selectors: string[]): string {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const t = (el.textContent || '').trim();
      if (t) return t;
    }
  }
  return '';
}

function guessCompanyFromHost(): string {
  const host = location.hostname.replace(/^www\./, '').split('.')[0];
  if (!host) return '';
  return host.charAt(0).toUpperCase() + host.slice(1);
}

function extractGeneric(): CaptureEntry | null {
  // Heuristics across arbitrary job pages
  const title = bestText([
    'h1', 'h1[role="heading"]', 'header h1', 'h2[aria-level="1"]'
  ]);
  const company = bestText([
    '[data-company], .company, .job-company, .jobHeader-companyName, .topcard__org-name-link'
  ]) || guessCompanyFromHost();
  const locationText = bestText([
    '[data-location], .location, .job-location, [itemprop="jobLocation"]'
  ]);
  const posted = bestText([
    '[data-posted], .posted, .posted-date, time[datetime]'
  ]);
  const desc = bestText(['[data-description], .description, .job-description']);
  let salary_text = '';
  const pageText = (document.body?.innerText || '').slice(0, 20000);
  const salaryMatch = pageText.match(/\$\s?\d[\d,]*(?:\s?[kK])?(?:\s?[-–]\s?\$?\d[\d,]*(?:\s?[kK])?)?/);
  if (salaryMatch) salary_text = salaryMatch[0];
  let job_timeline = '';
  const tl = desc.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
  if (tl) job_timeline = tl[0];

  const job_title = title.trim();
  const blocked = ['jobs', 'careers', 'job search', 'all open positions', 'open positions', 'grow your career'];
  const hostBlock = /accounts\.google\.com|google\.com\/recaptcha|googleusercontent\.com|gstatic\.com/.test(location.hostname + location.pathname);
  if (!job_title || blocked.includes(job_title.toLowerCase()) || !company.trim() || hostBlock) return null;
  return {
    date_applied: formatDate(),
    job_title,
    company: company.trim(),
    location: locationText,
    job_posting_url: location.href.split('?')[0],
    salary_text,
    listing_posted_date: posted,
    job_timeline
  };
}

function hasApplicationSignals(): boolean {
  // URL hints
  const url = location.href.toLowerCase();
  const urlSignals = /(apply|application|submit)/.test(url) || /(greenhouse|lever\.co|workday|myworkdayjobs|taleo|oraclecloud)/.test(url);
  // Form hints
  const form = document.querySelector('form');
  const hasEmail = !!document.querySelector('input[type="email"], input[name*="email" i]');
  const hasResume = !!document.querySelector('input[type="file"], input[name*="resume" i], input[name*="cv" i]');
  const hasSubmit = !!document.querySelector('button[type="submit"], input[type="submit"]');
  const confirmText = /application\s+sent|thank(s)?\s+you\s+for\s+applying|applied\b/i.test(document.body?.innerText || '');
  return urlSignals || (form != null && (hasEmail || hasResume || hasSubmit)) || confirmText;
}

function showToast() {
  const d = document.createElement('div');
  d.textContent = 'Job added to Google Sheet ✓';
  d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
  document.documentElement.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

function send(entry: CaptureEntry, shouldToast: boolean) {
  chrome.runtime.sendMessage({ type: 'append-entry', entry }, (res) => {
    if (shouldToast && res?.appended) showToast();
  });
}

let detachClick: (() => void) | null = null;
let mo: MutationObserver | null = null;
let unhookRoute: (() => void) | null = null;

function init() {
  if (detachClick) return;
  chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
    const settings = res?.settings || {};
    if (!settings.enableGeneric) return;
    detachClick = onAnyApplyClick(() => {
      const entry = extractGeneric();
      if (entry) send(entry, !!settings.showToast);
    });
    mo = observeMutations(() => {});
    unhookRoute = onSpaRouteChange(() => {});
  });
}

init();


