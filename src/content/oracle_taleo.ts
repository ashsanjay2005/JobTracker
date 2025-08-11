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

function extract(): CaptureEntry | null {
  // Oracle Cloud Recruiting / Taleo common selectors
  const titleNode = document.querySelector('h1, h2, [data-automation-id="jobTitle"]');
  const companyNode = document.querySelector('[data-automation-id="companyName"], .orcl-CompanyName, .taleo-branding');
  const locationNode = document.querySelector('[data-automation-id="jobLocation"], .orcl-Location');
  const postedNode = document.querySelector('[data-automation-id*="posted" i], .orcl-PostedDate');
  const descriptionNode = document.querySelector('[data-automation-id="jobDescription"], .orcl-JobDescription');
  const payNode = document.querySelector('[data-automation-id*="Salary" i], [data-automation-id*="Compensation" i]');

  const job_posting_url = location.href.split('?')[0];
  const job_title = (titleNode?.textContent || '').trim();
  let company = (companyNode?.textContent || '').trim();
  if (!company) {
    const host = location.host.split('.')[0];
    company = host.charAt(0).toUpperCase() + host.slice(1);
  }
  const locationText = (locationNode?.textContent || '').trim();
  const postedText = (postedNode?.textContent || '').trim();
  const descText = (descriptionNode?.textContent || '').trim();
  const payText = (payNode?.textContent || '').trim();
  let salary_text = '';
  if (/\$\s?\d|\d+\s?[-–]\s?\d+/.test(payText)) salary_text = payText;
  let job_timeline = '';
  const tl = descText.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
  if (tl) job_timeline = tl[0];

  if (!job_title || !company) return null;
  return {
    date_applied: formatDate(),
    job_title,
    company,
    location: locationText,
    job_posting_url,
    salary_text,
    listing_posted_date: postedText,
    job_timeline
  };
}

function showToast() {
  const d = document.createElement('div');
  d.className = 'jt-toast';
  d.textContent = 'Job added to Google Sheet ✓';
  d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
  document.documentElement.appendChild(d);
  setTimeout(() => { d.remove(); }, 2200);
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
    if (!settings.enableOracleTaleo) return;
  detachClick = onAnyApplyClick(() => {
    const host = location.hostname;
    const pathOk = /taleo|oraclecloud/.test(host);
    if (!pathOk) return;
    const entry = extract();
    if (entry) send(entry, !!settings.showToast);
  });
    mo = observeMutations(() => {});
    unhookRoute = onSpaRouteChange(() => {});
  });
}

init();


