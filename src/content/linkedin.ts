import type { CaptureEntry } from '../lib/storage';
// Inline minimal DOM helpers to avoid shared chunks in content scripts
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

// LinkedIn selectors documented
// - Job Title: h1.top-card-layout__title, .job-details-jobs-unified-top-card__job-title
// - Company: a.topcard__org-name-link, .job-details-jobs-unified-top-card__primary-description .app-aware-link
// - Location: .top-card__flavor--bullet, .job-details-jobs-unified-top-card__primary-description
// - Salary: .compensation__salary, [data-test-description] contains salary text on some pages
// - Posted date: .posted-time-ago__text, .jobs-unified-top-card__posted-date
// - Timeline: visible in description sometimes; attempt simple capture

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
  return (el?.textContent || '').trim();
}

function isNoiseTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return !t || /top job picks/.test(t) || t === 'linkedin';
}

function isPlaceholder(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  return /\{\s*:?(companyName|title)\s*\}/i.test(t) || /\{:\w+\}/.test(t);
}

function getRightPanelRoot(): Element | Document {
  return (
    document.querySelector('.jobs-unified-top-card') ||
    document.querySelector('.jobs-unified-top-card__content--two-pane') ||
    document.querySelector('.scaffold-layout__detail') ||
    document
  ) as Element;
}

function textFromLinkToJob(root: Document | Element = getRightPanelRoot()): string {
  // Try anchors that link to the current job view; useful on collections pages
  // Prefer anchors with /jobs/view/<id>
  const anchors = Array.from(
    root.querySelectorAll(
      'a.jobs-unified-top-card__job-title-link, .jobs-unified-top-card__job-title a, a[href*="/jobs/view/"]'
    )
  ) as HTMLAnchorElement[];
  for (const a of anchors) {
    const txt = (a.textContent || '').trim();
    if (txt && !isNoiseTitle(txt)) return txt;
  }
  return '';
}

function linkToJobView(root: Document | Element = getRightPanelRoot()): string | null {
  const a = (root.querySelector(
    'a.jobs-unified-top-card__job-title-link, .jobs-unified-top-card__job-title a, a[href*="/jobs/view/"]'
  ) as HTMLAnchorElement | null);
  if (a && a.href) return new URL(a.href, location.origin).href;
  return null;
}

function cleanLinkedInJobUrl(raw: string | null | undefined): string {
  const ensureCanonical = (jobId: string | null): string => {
    return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '';
  };
  try {
    const input = (raw || '').trim() || location.href;
    const u = new URL(input, location.origin);
    // 1) Try to extract from pathname /jobs/view/<id>
    const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m && m[1]) return ensureCanonical(m[1]);
    // 2) Try query params (currentJobId, postApplyJobId)
    const params = u.searchParams;
    const jid = params.get('currentJobId') || params.get('postApplyJobId') || params.get('jobId');
    if (jid) return ensureCanonical(jid);
  } catch {}
  // 3) Fallback: best-effort from current location
  try {
    const m2 = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m2 && m2[1]) return `https://www.linkedin.com/jobs/view/${m2[1]}/`;
  } catch {}
  return raw || '';
}

function extract(): CaptureEntry | null {
  // Try unified job card (right panel or dedicated page)
  const rightRoot = getRightPanelRoot();
  let job_title = qsText('h1.top-card-layout__title, h1.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title-string', rightRoot);
  let companyText = qsText('.jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name, .topcard__org-name-link, .job-details-jobs-unified-top-card__primary-description a.app-aware-link', rightRoot);
  if (isPlaceholder(companyText)) companyText = '';
  let locationText = '';
  let postedText = '';
  let applicantsText: string | null = null;
  let promotedByHirer = false;
  let statusText: string | null = null;

  // New robust parser: look for primary/tertiary description containers and split on bullets
  const primary = rightRoot.querySelector('[class*="primary-description-container"]') as Element | null;
  const tertiary = (primary?.querySelector('[class*="tertiary-description-container"]') as Element | null)
    || (rightRoot.querySelector('[class*="tertiary-description-container"]') as Element | null);

  if (tertiary) {
    const seq = (tertiary.textContent || '').replace(/\s+/g, ' ').trim();
    const parts = seq.split(/·/).map((s) => s.trim()).filter(Boolean);

    // Location: first token that doesn't look like time/promoted/applicants/status
    const locTok = parts.find((p) => !/(\bposted\b|\bapplicants?\b|\bago\b|just now|promoted by hirer|actively\b)/i.test(p));
    if (locTok) locationText = locTok;

    // Posted date: capture relative time including optional "Reposted"
    const postedTok = parts.find((p) => /(just now|\d+\s+(minute|hour|day|week|month|year)s?\s+ago|reposted\s+\d+.*?ago)/i.test(p));
    if (postedTok) {
      const m = postedTok.match(/(just now|\d+\s+(minute|hour|day|week|month|year)s?\s+ago|reposted\s+\d+.*?ago)/i);
      if (m) postedText = m[0];
    }

    // Applicants
    const applTok = parts.find((p) => /applicants?/i.test(p));
    if (applTok) applicantsText = applTok.match(/((over|more than)\s+)?[\d,]+/i)?.[0] || applTok;

    // Promoted and status signals can appear outside bullet separators; scan the full sequence
    promotedByHirer = /promoted by hirer/i.test(seq);
    const statM = seq.match(/Actively reviewing applicants|Actively (hiring|recruiting)/i);
    statusText = statM ? statM[0] : null;
  }

  // Fallbacks for location/posted if the robust parser didn't resolve them
  if (!locationText || !postedText) {
    const locCandidates = [
      '.jobs-unified-top-card__bullet',
      '.jobs-unified-top-card__subtitle-primary-grouping > span',
      '.top-card__flavor--bullet'
    ];
    for (const sel of locCandidates) {
      const t = qsText(sel, rightRoot);
      if (!locationText && t && !/posted/i.test(t)) { locationText = t; }
    }
    if (!postedText) postedText = qsText('.posted-time-ago__text, .jobs-unified-top-card__posted-date', rightRoot);
  }
  let salaryTextRaw = qsText('.compensation__salary, [data-test-description*="salary" i]', rightRoot);
  let descText = qsText('.show-more-less-html__markup, .description__text, .jobs-description__content', rightRoot);

  // On some pages the title is an anchor instead of a heading
  if (!job_title) job_title = textFromLinkToJob(rightRoot);

  // Improve location/posted extraction from the subtitle grouping (e.g., "Kingston, ON · 2 weeks ago · Over 100 applicants")
  const subtitleGroup = rightRoot.querySelector('.jobs-unified-top-card__subtitle-primary-grouping') as Element | null;
  if (subtitleGroup) {
    const parts = Array.from(subtitleGroup.querySelectorAll('span'))
      .map((n) => (n.textContent || '').trim())
      .filter((t) => Boolean(t) && t !== '·' && t !== '•');
    // Prefer the first span as location
    if (parts.length > 0 && !/posted/i.test(parts[0])) {
      const cleaned = parts[0].split('·')[0].trim().replace(/\s*\(.*?\)\s*$/, '');
      if (cleaned) locationText = cleaned;
    }
    // Find a part that looks like relative date (e.g., "2 weeks ago")
    const rel = parts.find((p) => /\b(\d+\s+)?(hour|day|week|month|year)s?\s+ago\b/i.test(p));
    if (!postedText && rel) postedText = rel;
  }

  // Remove older brittle span-based blocks in favor of the robust parser above; keep only basic fallbacks

  // Fallback to active list item on search page (left column)
  if (!job_title || !companyText) {
    const active = (document.querySelector('li.jobs-search-results__list-item[aria-selected="true"], li.jobs-search-results__list-item--active') as Element | null);
    if (active) {
      job_title = job_title || qsText('a.job-card-list__title, .job-card-list__title', active);
      companyText = companyText || qsText('.job-card-container__company-name, .job-card-list__subtitle', active);
      locationText = locationText || qsText('.job-card-container__metadata-item', active);
    }
  }

  // Fallback to Easy Apply modal header (e.g., "Apply to Company")
  if (!companyText) {
    const modal = document.querySelector('[role="dialog"], .artdeco-modal') as Element | null;
    if (modal) {
      const direct = qsText('a[href*="/company/"]', modal);
      if (direct && !isPlaceholder(direct)) companyText = direct;
      const header = qsText('[data-test-modal-title], h2, h1', modal);
      const m = header.match(/apply\s+to\s+(.+)/i);
      if (!companyText && m && !isPlaceholder(m[1])) companyText = m[1].trim();
    }
  }

  // Final title fallback from document.title
  if (!job_title) {
    const dt = (document.title || '').split('|')[0].trim();
    if (dt && dt.toLowerCase() !== 'linkedin' && !isNoiseTitle(dt)) job_title = dt;
  }

  // Final fallback to context captured at click time
  if (!job_title && lastCtxTitle) job_title = lastCtxTitle;
  if (!companyText && lastCtxCompany) companyText = lastCtxCompany;

  // Build a durable job view URL first; fall back to current location if needed
  let job_posting_url = linkToJobView(rightRoot) || '';
  if (!job_posting_url) {
    const params = new URLSearchParams(location.search || location.hash.replace(/^#\/?/, ''));
    const jid = params.get('currentJobId') || params.get('postApplyJobId');
    if (jid) job_posting_url = `https://www.linkedin.com/jobs/view/${jid}/`;
  }
  if (!job_posting_url) job_posting_url = location.href;
  // Clean to canonical form https://www.linkedin.com/jobs/view/<jobId>/
  job_posting_url = cleanLinkedInJobUrl(job_posting_url);
  let salary_text = '';
  if (/\$\s?\d|\d+\s?[-–]\s?\d+/.test(salaryTextRaw)) salary_text = salaryTextRaw;
  let job_timeline = '';
  const tl = descText.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
  if (tl) job_timeline = tl[0];

  if (!job_title || !companyText) return null;
  // Debug: show what we extracted
  try { console.debug('[JobTracker][LinkedIn] extract', { job_title, companyText, locationText, postedText, job_posting_url }); } catch {}
  return {
    date_applied: formatDate(),
    job_title,
    company: companyText,
    location: locationText,
    job_posting_url,
    salary_text,
    listing_posted_date: postedText,
    job_timeline
  };
}

/**
 * Extract with retries to handle async right-panel rendering.
 * We retry until at least job_title, company, and location are present or retries run out.
 */
function extractAndSendWithRetries(shouldToast: boolean, maxRetries = 6, delayMs = 400) {
  const tryOnce = (attempt: number) => {
    const entry = extract();
    if (entry && entry.location) {
      send(entry, shouldToast);
      return;
    }
    if (attempt < maxRetries) {
      setTimeout(() => tryOnce(attempt + 1), delayMs);
    } else if (entry) {
      // send whatever we have after retries
      send(entry, shouldToast);
    }
  };
  tryOnce(0);
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
  chrome.runtime.sendMessage({ type: 'append-entry', entry }, undefined, (res) => {
    try { console.debug('[JobTracker][LinkedIn] send response', res); } catch {}
    if (shouldToast && res?.appended) showToast();
    if (res && res.appended === false && (res.reason === 'inflight' || res.reason === 'seen')) {
      try { console.debug('[JobTracker][LinkedIn] Already captured — skipped.'); } catch {}
    }
  });
}

let detachClick: (() => void) | null = null;
let mo: MutationObserver | null = null;
let unhookRoute: (() => void) | null = null;
let lastConfirmAt = 0;
let lastClickAt = 0;
let lastCtxTitle: string | null = null;
let lastCtxCompany: string | null = null;
let lastModalOpenAt = 0;

async function init() {
  if (detachClick) return; // already initialized
  chrome.runtime.sendMessage({ type: 'get-settings' }, undefined, (res) => {
    const settings = res?.settings || {};
    if (!settings.enableLinkedIn) return;
  // Capture both Easy Apply button on the page and buttons inside the modal
  const clickHandler = (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const pathOk = /linkedin\.com\/jobs\//.test(location.href);
    if (!pathOk) return;
    const now = Date.now();
    if (now - lastClickAt < 1000) return; // debounce bursts

    // Walk up to find button-like element
    let el: HTMLElement | null = target;
    let hops = 0;
    while (el && hops < 6) {
      const role = el.getAttribute('role') || '';
      const tag = el.tagName?.toLowerCase() || '';
      if (tag === 'button' || tag === 'a' || role === 'button') break;
      el = el.parentElement;
      hops++;
    }
    if (!el) return;

    const txt = (el.innerText || '').trim().toLowerCase();
    const inModal = !!document.querySelector('[role="dialog"], .artdeco-modal');
    const isEasyApply = /(easy\s*apply)/i.test(txt); // only Easy Apply here; external 'Apply' handled elsewhere
    const isModalProgress = /(next|continue|submit|done)/i.test(txt);

    if (isEasyApply || (inModal && isModalProgress)) {
      lastClickAt = now;
      try { console.debug('[JobTracker][LinkedIn] click matched', { txt, inModal, isEasyApply, isModalProgress }); } catch {}
      // Capture context for fallback
      const panel = document.querySelector('.jobs-unified-top-card, .jobs-unified-top-card__content--two-pane') as Element | null;
      lastCtxTitle = qsText('h1, .jobs-unified-top-card__job-title-string', panel || document);
      lastCtxCompany = qsText('.jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name, .topcard__org-name-link', panel || document);
      // Debounce extraction to avoid duplicate appends from rapid modal changes
      if (now - lastConfirmAt > 800) {
        extractAndSendWithRetries(!!settings.showToast);
        lastConfirmAt = now;
      }
    }
  };
  window.addEventListener('click', clickHandler, { capture: true, passive: true });
  detachClick = () => window.removeEventListener('click', clickHandler, true);
    // Watch for Easy Apply modal open and confirmation; send once
    mo = observeMutations(() => {
      const now = Date.now();
      const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
      if (!dialog) return;
      const txt = (dialog.textContent || '').toLowerCase();
      // fire when modal opens (header appears) to capture context early
      if (now - lastModalOpenAt > 4000 && /(apply\s+to|easy\s*apply|apply|postuler|candidature)/i.test(txt)) {
        lastModalOpenAt = now;
        try { console.debug('[JobTracker][LinkedIn] modal open detected'); } catch {}
        extractAndSendWithRetries(!!settings.showToast);
      }
      // also fire when confirmation appears
      if (now - lastConfirmAt > 4000 && /application\s+sent|thanks\s+for\s+applying|your\s+application\s+was\s+sent|applied\b/i.test(txt)) {
        try { console.debug('[JobTracker][LinkedIn] modal confirmation detected'); } catch {}
        lastConfirmAt = now;
        extractAndSendWithRetries(!!settings.showToast);
      }
    });
    unhookRoute = onSpaRouteChange(() => {});
  });
}

init();


