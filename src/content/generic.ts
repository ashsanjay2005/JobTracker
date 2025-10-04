import type { CaptureEntry } from '../lib/storage';

// Skip Greenhouse; handled by greenhouse-specific script
if (/greenhouse\.io$/i.test(location.hostname) || /greenhouse\.io/i.test(location.hostname)) {
  // Do nothing: greenhouse script will run
} else {
  // Guard functions to prevent TypeError: getAttribute is not a function
  const isElement = (n: any): n is Element => {
    try {
      return !!n && 
             typeof n === 'object' && 
             typeof n.getAttribute === 'function' &&
             typeof n.tagName === 'string';
    } catch {
      return false;
    }
  };

  const getAttribute = (n: any, name: string) => {
    try {
      return isElement(n) ? n.getAttribute(name) : null;
    } catch {
      return null;
    }
  };

  const getText = (n: any) => {
    try {
      if (!n) return "";
      if (typeof n === "string") return n.trim();
      if (isElement(n)) {
        return ((n as any).textContent ?? (n as any).innerText ?? "").toString().trim();
      }
      return "";
    } catch {
      return "";
    }
  };

  const getValue = (n: any) => {
    try {
      if (n && typeof (n as HTMLInputElement).value !== "undefined") {
        return String((n as HTMLInputElement).value);
      }
      return "";
    } catch {
      return "";
    }
  };

  function onAnyApplyClick(callback: (ev: Event) => void): () => void {
    const handler = (ev: Event) => {
      const start = ev.target as HTMLElement | null;
      console.log('[Scoutly Generic] Click detected on:', start);
      
      if (!start) return;
      
      const regex = /\b(easy apply|apply|submit|next|continue)\b/i;
      const deny = /\b(view|find|see|browse|explore)\s+(jobs?|roles?|openings?)\b/i;
      let el: HTMLElement | null = start;
      let hops = 0;
      
      while (el && hops < 4) {
        const role = getAttribute(el, 'role') || '';
        const tag = el.tagName?.toLowerCase() || '';
        const txt = getText(el);
        
        console.log('[Scoutly Generic] Checking element:', { tag, role, text: txt, hops });
        
        if (tag === 'button' || tag === 'a' || role === 'button') {
          console.log('[Scoutly Generic] Found potential button:', { tag, role, text: txt });
          console.log('[Scoutly Generic] Regex test:', regex.test(txt));
          console.log('[Scoutly Generic] Deny test:', deny.test(txt));
          
          if (regex.test(txt) && !deny.test(txt)) {
            console.log('[Scoutly Generic] Button text matches, checking application signals...');
            const hasSignals = hasApplicationSignals();
            console.log('[Scoutly Generic] Application signals:', hasSignals);
            
            if (hasSignals) {
              console.log('[Scoutly Generic] Calling callback...');
              callback(ev);
            } else {
              console.log('[Scoutly Generic] No application signals found, skipping');
            }
          } else {
            console.log('[Scoutly Generic] Button text does not match or is denied');
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
        const t = getText(el);
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
    console.log('[Scoutly Generic] Starting job extraction...');
    
    // More comprehensive job title detection
    const title = bestText([
      'h1', 'h1[role="heading"]', 'header h1', 'h2[aria-level="1"]',
      'h2', 'h3', '.job-title', '.position-title', '.role-title',
      '[data-job-title]', '.title', '.job-header h1', '.job-header h2',
      '.job-details h1', '.job-details h2', '.job-info h1', '.job-info h2',
      '.job-posting h1', '.job-posting h2', '.job-description h1', '.job-description h2',
      '.position', '.role', '.job-name', '.vacancy-title', '.opening-title'
    ]);
    console.log('[Scoutly Generic] Title found:', title);
    
    // More comprehensive company detection
    const company = bestText([
      '[data-company]', '.company', '.job-company', '.jobHeader-companyName', '.topcard__org-name-link',
      '.employer', '.organization', '.job-employer', '.job-organization', '.company-name',
      '.job-header .company', '.job-info .company', '.job-details .company',
      '[data-employer]', '[data-organization]', '.brand', '.logo-text',
      '.company-info', '.employer-name', '.organization-name', '.hiring-company'
    ]) || guessCompanyFromHost();
    console.log('[Scoutly Generic] Company found:', company);
    
    // More comprehensive location detection
    const locationText = bestText([
      '[data-location]', '.location', '.job-location', '[itemprop="jobLocation"]',
      '.job-location', '.work-location', '.office-location', '.address',
      '.job-header .location', '.job-info .location', '.job-details .location',
      '[data-address]', '.geo', '.place', '.workplace', '.job-address'
    ]);
    console.log('[Scoutly Generic] Location found:', locationText);
    
    // More comprehensive posted date detection
    const posted = bestText([
      '[data-posted]', '.posted', '.posted-date', 'time[datetime]',
      '.job-posted', '.date-posted', '.publish-date', '.created-date',
      '.job-header .date', '.job-info .date', '.job-details .date',
      '[data-date]', '.timestamp', '.meta-date', '.posting-date'
    ]);
    console.log('[Scoutly Generic] Posted date found:', posted);
    
    // More comprehensive description detection
    const desc = bestText([
      '[data-description]', '.description', '.job-description',
      '.job-details', '.job-content', '.job-summary', '.job-overview',
      '.job-requirements', '.job-responsibilities', '.job-info',
      '.content', '.main-content', '.job-body', '.position-description'
    ]);
    console.log('[Scoutly Generic] Description found:', desc);
    
    let salary_text = '';
    const pageText = (getText(document.body) || '').slice(0, 20000);
    const salaryMatch = pageText.match(/\$\s?\d[\d,]*(?:\s?[kK])?(?:\s?[-–]\s?\$?\d[\d,]*(?:\s?[kK])?)?/);
    if (salaryMatch) salary_text = salaryMatch[0];
    let job_timeline = '';
    const tl = desc.match(/([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}\s+[-–]\s+([A-Z][a-z]{2})\s+\d{1,2}(st|nd|rd|th)?\s+\d{4}/);
    if (tl) job_timeline = tl[0];

    const job_title = title.trim();
    const blocked = ['jobs', 'careers', 'job search', 'all open positions', 'open positions', 'grow your career'];
    const hostBlock = /accounts\.google\.com|google\.com\/recaptcha|googleusercontent\.com|gstatic\.com/.test(location.hostname + location.pathname);
    
    // More lenient validation - allow jobs even without company if we have a good title
    if (!job_title || blocked.includes(job_title.toLowerCase()) || hostBlock) {
      console.log('[Scoutly Generic] Blocked job title:', job_title);
      return null;
    }
    
    if (!company.trim() && job_title.length < 5) {
      console.log('[Scoutly Generic] Job title too short without company');
      return null;
    }
    
    console.log('[Scoutly Generic] Extracted job data:', { job_title, company, location: locationText });
    
    return {
      date_applied: formatDate(),
      job_title,
      company: company.trim() || 'Unknown Company',
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
    const confirmText = /application\s+sent|thank(s)?\s+you\s+for\s+applying|applied\b/i.test(getText(document.body) || '');
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
    
    console.log('[Scoutly Generic] Initializing on:', location.href);
    
    chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
      // Default to enabled if settings can't be loaded
      const settings = res?.settings || { enableGeneric: true, showToast: true };
      console.log('[Scoutly Generic] Settings loaded:', settings);
      
      if (!settings.enableGeneric) {
        console.log('[Scoutly Generic] Generic capture disabled in settings');
        return;
      }
      
      console.log('[Scoutly Generic] Setting up generic job capture...');
      detachClick = onAnyApplyClick(() => {
        const entry = extractGeneric();
        if (entry) {
          console.log('[Scoutly Generic] Captured job:', entry);
          send(entry, !!settings.showToast);
        } else {
          console.log('[Scoutly Generic] Failed to extract job data');
        }
      });
      mo = observeMutations(() => {});
      unhookRoute = onSpaRouteChange(() => {});
    });
  }

  init();
}


