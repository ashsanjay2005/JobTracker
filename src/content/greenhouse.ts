import type { CaptureEntry } from '../lib/storage';

// Inline minimal helpers to avoid shared chunks
function onClickCapture(callback: (ev: Event) => void): () => void {
  const handler = (ev: Event) => {
    const start = ev.target as HTMLElement | null;
    if (!start) return;
    let el: HTMLElement | null = start;
    let hops = 0;
    while (el && hops < 6) {
      const role = el.getAttribute('role') || '';
      const tag = el.tagName?.toLowerCase() || '';
      if (tag === 'button' || role === 'button' || el.getAttribute('type') === 'submit') {
        const txt = (el.innerText || '').trim().toLowerCase();
        if (/\b(submit application|apply|submit)\b/i.test(txt) || el.getAttribute('type') === 'submit') {
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

function observeMutations(callback: () => void): MutationObserver {
  const obs = new MutationObserver(() => callback());
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
  return obs;
}

function showToast(text: string, durationMs = 2000) {
  const d = document.createElement('div');
  d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
  d.textContent = text;
  document.documentElement.appendChild(d);
  setTimeout(() => d.remove(), durationMs);
}

function text(sel: string, root: Document | Element = document): string {
  const el = root.querySelector(sel);
  return (el?.textContent || '').trim();
}

function firstNotMatching(parts: string[], block: RegExp[]): string {
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (block.some((r) => r.test(t))) continue;
    return t;
  }
  return '';
}

function inferCompanyFromHost(): string {
  // boards.greenhouse.io/<company>/jobs/<id>
  // job-boards.greenhouse.io/<company>/jobs/<id>
  try {
    const u = new URL(location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = parts[0] || '';
    if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1);
  } catch {}
  return '';
}

function canonicalGreenhouseUrl(): string {
  try {
    const u = new URL(location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    const idxJobs = parts.indexOf('jobs');
    if (idxJobs > 0 && parts[idxJobs + 1]) {
      const company = parts[idxJobs - 1];
      const jobId = parts[idxJobs + 1];
      const host = u.host.includes('job-boards.') ? 'boards.greenhouse.io' : u.host;
      return `https://${host}/${company}/jobs/${jobId}`;
    }
  } catch {}
  return location.href;
}

function extractGreenhouse(): CaptureEntry | null {
  // Title selectors
  // - h1, h1.posting-headline, .app-title h1
  let job_title = text('h1') || text('h1.posting-headline') || text('.app-title h1');

  // Company selectors
  // - .company, .organization, a[href*="/company/"], og:site_name, or derive from URL path
  let company = text('.company') || text('.organization') || text('a[href*="/company/"]');
  if (!company) {
    const meta = document.querySelector('meta[property="og:site_name"]') as HTMLMetaElement | null;
    if (meta?.content) company = meta.content.trim();
  }
  if (!company) company = inferCompanyFromHost();

  // Location and posted date
  // Location selectors (include job__location structure: svg + div text)
  let location = text('.job__location div') || text('.job__location') || text('.location') || text('.app-location') || text('.posting-categories .location') || text('.location[data-source]');
  if (!location) {
    // bullet-separated line under title
    const header = document.querySelector('.posting-headline, .app-title, header') as Element | null;
    const seq = (header?.textContent || '').replace(/\s+/g, ' ').trim();
    if (seq.includes('·')) {
      const parts = seq.split('·').map((s) => s.trim());
      location = firstNotMatching(parts, [/posted/i, /applicant/i]);
    }
  }

  let posted = text('.posting-date') || text('.app-posted-date') || text('time[datetime]');
  if (!posted) {
    const body = (document.body?.innerText || '').toLowerCase();
    const m = body.match(/(just now|\d+\s+(minute|hour|day|week|month|year)s?\s+ago)/i);
    if (m) posted = m[0];
  }

  const job_posting_url = canonicalGreenhouseUrl();

  // Salary: scan limited portion
  let salary_text = '';
  const pageText = (document.body?.innerText || '').slice(0, 40000);
  const sal = pageText.match(/\$\s?\d[\d,]*(?:\s?[kK])?(?:\s?[-–]\s?\$?\d[\d,]*(?:\s?[kK])?)?/);
  if (sal) salary_text = sal[0];

  // Timeline: reuse generic regex
  let job_timeline = '';
  const tl = pageText.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
  if (tl) job_timeline = tl[0];

  // Guard
  if (!job_title || !company) return null;

  const date_applied = (() => {
    const d = new Date();
    const mon = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d);
    const day = d.getDate();
    const year = d.getFullYear();
    const suffix = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
    return `${mon} ${day}${suffix(day)} ${year}`;
  })();

  try { console.debug('[JT][Greenhouse] extract', { job_title, company, location, posted, job_posting_url }); } catch {}

  return {
    date_applied,
    job_title,
    company,
    location,
    job_posting_url,
    salary_text,
    listing_posted_date: posted,
    job_timeline
  };
}

function send(entry: CaptureEntry, savingToast?: HTMLElement | null) {
  if (!chrome?.runtime?.id) {
    try { console.debug('[JT][Greenhouse] runtime.id missing; clearing toast'); } catch {}
    if (savingToast) savingToast.remove();
    return;
  }
  try { console.debug('[JT][Greenhouse] sending entry', { t: entry.job_title, c: entry.company, u: entry.job_posting_url }); } catch {}
  chrome.runtime.sendMessage({ type: 'append-entry', entry }, (res) => {
    const err = (chrome as any)?.runtime?.lastError || null;
    try { console.debug('[JT][Greenhouse] received response', { err, res }); } catch {}
    if (savingToast) savingToast.remove();
    if (err) { showToast('Could not save (extension reloaded?)', 2200); return; }
    if (res?.appended) { showToast('Job added to Google Sheet ✓', 2000); return; }
    if (res?.reason === 'duplicate' || res?.reason === 'inflight') { showToast('Already saved ✓', 1800); return; }
    showToast('Could not save', 2200);
  });
}

let detach: (() => void) | null = null;
let mo: MutationObserver | null = null;
let lastClickAt = 0;

function attach() {
  if (detach) return;
  // Immediate feedback + capture on submit/apply clicks
  detach = onClickCapture(() => {
    const now = Date.now();
    if (now - lastClickAt < 800) return;
    lastClickAt = now;
    const saving = document.createElement('div');
    saving.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:rgba(17,24,39,0.95);color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
    saving.textContent = 'Saving…';
    document.documentElement.appendChild(saving);
    // Safety auto-hide in case background never responds
    let safetyTimer = window.setTimeout(() => {
      try { console.debug('[JT][Greenhouse] no response within 6s; giving up'); } catch {}
      saving.remove();
      showToast('Could not save (no response)', 2200);
    }, 6000);

    // Try now; if location/posted missing, retry briefly but don't block toast
    const attempt = (i: number) => {
      const entry = extractGreenhouse();
      if (entry && (entry.location || i >= 3)) {
        // Cancel safety timer once we decide to send
        window.clearTimeout(safetyTimer);
        send(entry, saving);
      } else if (i < 3) {
        setTimeout(() => attempt(i + 1), 300);
      } else if (entry) {
        window.clearTimeout(safetyTimer);
        send(entry, saving);
      } else {
        window.clearTimeout(safetyTimer);
        saving.remove();
        showToast('Could not detect job info', 2000);
      }
    };
    attempt(0);
  });

  // Observe SPA transitions which may render fields late
  mo = observeMutations(() => {});
}

(function init() {
  // Only run on greenhouse
  if (!/greenhouse\.io$/i.test(location.hostname) && !/greenhouse\.io/i.test(location.hostname)) return;
  attach();
})();
