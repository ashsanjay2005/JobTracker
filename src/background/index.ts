import { appendRow, ensureHeaderRow, deleteRowByRecordId } from '../lib/sheets';
import { CaptureEntry, getDedupCache, getSettings, pushRecentEntry, setDedupCache } from '../lib/storage';
import { sha256Hex } from '../lib/hash';
let inflightLocks: Record<string, number> = {};
const APPENDED_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function nowMs() { return Date.now(); }

function normalizeWorkdayUrl(raw: string): { cleanUrl: string; reqId: string | null } {
  try {
    const u0 = new URL(raw || location.href);
    const host = u0.host.toLowerCase();
    let path = u0.pathname.replace(/\/+$/, '');
    // Drop locale prefix like /en-US/
    path = path.replace(/^\/(?:[a-z]{2}-[A-Z]{2})\//, '/');
    // Strip /apply and anything after
    path = path.replace(/\/(apply)(?:\/.*)?$/i, '');
    // Collapse multiple slashes
    path = path.replace(/\/+/, '/');
    const cleanUrl = `${u0.protocol}//${host}${path}`;
    // Extract requisition id
    let reqId: string | null = null;
    const m1 = cleanUrl.match(/[_-](R-?\d{4,})\b/i);
    if (m1 && m1[1]) reqId = m1[1].toUpperCase().replace(/_/g, '-');
    if (!reqId) {
      const parts = path.split('/');
      for (const p of parts) {
        const m2 = p.match(/^R-?\d{4,}$/i);
        if (m2) { reqId = m2[0].toUpperCase().replace(/_/g, '-'); break; }
      }
    }
    return { cleanUrl, reqId };
  } catch {
    return { cleanUrl: raw, reqId: null };
  }
}

function computeRecordId(entry: CaptureEntry): string {
  // Prefer LinkedIn job ID extracted from cleaned job URL
  const url = entry.job_posting_url || '';
  const m = url.match(/\/jobs\/view\/(\d+)\//);
  if (m && m[1]) return `li:${m[1]}`;
  // Lever canonical URL: https://jobs.lever.co/<company>/<jobId>
  const lever = url.match(/https?:\/\/jobs\.lever\.co\/[\w-]+\/([\w-]+)/i);
  if (lever && lever[1]) return `lever:${lever[1]}`;
  // Workday requisition id R-12345 or R12345
  if (/workday/i.test(url)) {
    const { cleanUrl, reqId } = normalizeWorkdayUrl(url);
    entry.job_posting_url = cleanUrl; // ensure we store the canonical URL
    if (reqId) return `wd:${reqId}`;
  }
  const base = `${entry.job_title}|${entry.company}|${entry.job_posting_url}|${entry.date_applied}`;
  return `h:${sha256Hex(base)}`;
}

type InboundMessage =
  | { type: 'test-connection' }
  | { type: 'append-entry'; entry: CaptureEntry }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: any }
  | { type: 'get-recent' }
  | { type: 'delete-record'; recordId?: string }
  | { type: 'workday-capture'; entry: CaptureEntry }
  | { type: 'sheet-pull' }
  | { type: 'sheet-update'; record_id: string; patch: Partial<CaptureEntry> };

chrome.runtime.onInstalled.addListener(() => {
  // nothing specific; pages are built via Vite
});

async function loadSeenIds(): Promise<Record<string, number>> {
  const res = await chrome.storage.local.get(['seenRecordIds']);
  const raw = (res.seenRecordIds || {}) as Record<string, any>;
  const now = nowMs();
  const filtered: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const ts = typeof v === 'number' ? v : 0;
    if (ts && now - ts <= APPENDED_TTL_MS) filtered[k] = ts;
  }
  return filtered;
}

async function saveSeenIds(ids: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ seenRecordIds: ids });
}

async function maybeAppend(entry: CaptureEntry): Promise<{ appended: boolean; reason?: string }> {
  const settings = await getSettings();
  if (!settings.sheetId) return { appended: false, reason: 'No Sheet ID configured' };
  await ensureHeaderRow(settings.sheetId);

  // Compute record id and attach
  const recordId = computeRecordId(entry);
  entry.record_id = recordId;

  // In-flight debounce lock (10s)
  const now = nowMs();
  const lockUntil = inflightLocks[recordId] || 0;
  if (now < lockUntil) {
    try { console.debug('[bg][workday] inflight skip', { record_id: recordId }); } catch {}
    return { appended: false, reason: 'inflight' };
  }
  inflightLocks[recordId] = now + 10_000;

  try {
    // Load seen set from storage
    let seen = await loadSeenIds();
    const size = Object.keys(seen).length;
    try { console.debug('[bg][workday] dedup load', { size }); } catch {}
    if (seen[recordId]) {
      try { console.debug('[bg][workday] duplicate (persisted)', { record_id: recordId }); } catch {}
      return { appended: false, reason: 'duplicate' };
    }

    // Append to Sheets first, then commit to seen + recent
    await appendRow(settings.sheetId, entry);
    // Re-load and commit to be extra safe
    seen = await loadSeenIds();
    seen[recordId] = nowMs();
    await saveSeenIds(seen);
    await pushRecentEntry(entry);
    try { console.debug('[bg][workday] commit ok', { record_id: recordId }); } catch {}
    return { appended: true };
  } finally {
    // Release lock
    delete inflightLocks[recordId];
  }
}

chrome.runtime.onMessage.addListener((msg: InboundMessage, _sender, sendResponse) => {
  if (msg.type === 'workday-capture') {
    (async () => {
      try {
        try { console.debug('[bg][workday] received'); } catch {}
        const res = await maybeAppend(msg.entry);
        if (res.appended) {
          try { console.debug('[bg][workday] sheets append ok'); } catch {}
          // Notify popup to refresh recent list if open
          try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
          sendResponse({ ok: true, reason: 'appended', entry: msg.entry });
        } else {
          try { console.debug('[bg][workday] duplicate or skipped:', res.reason); } catch {}
          const reason = res.reason === 'seen' || res.reason === 'inflight' ? 'duplicate' : (res.reason || 'duplicate');
          sendResponse({ ok: true, reason, entry: msg.entry });
        }
      } catch (e: any) {
        try { console.error('[bg][workday] append failed', e); } catch {}
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async branch
  }
  (async () => {
    try {
      switch (msg.type) {
        case 'test-connection': {
          const settings = await getSettings();
          if (!settings.sheetId) throw new Error('Sheet ID not set');
          await ensureHeaderRow(settings.sheetId);
          sendResponse({ ok: true });
          break;
        }
        case 'append-entry': {
          const res = await maybeAppend(msg.entry);
          sendResponse({ ok: true, ...res });
          break;
        }
        case 'get-settings': {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
          break;
        }
        case 'save-settings': {
          await chrome.storage.sync.set({ settings: msg.settings });
          sendResponse({ ok: true });
          break;
        }
        case 'get-recent': {
          const res = await chrome.storage.local.get(['recentEntries']);
          sendResponse({ ok: true, recent: (res.recentEntries || []).slice(0, 10) });
          break;
        }
        case 'delete-record': {
          const recordId = msg.recordId || '';
          // Remove from local recent list
          const rec = await chrome.storage.local.get(['recentEntries']);
          const list: CaptureEntry[] = rec.recentEntries || [];
          const filtered = list.filter((e) => (e.record_id || '') !== recordId);
          await chrome.storage.local.set({ recentEntries: filtered });
          // Remove from sheet
          try {
            const settings = await getSettings();
            if (!settings.sheetId) throw new Error('No Sheet ID');
            await deleteRowByRecordId(settings.sheetId, recordId);
            sendResponse({ ok: true });
          } catch (e: any) {
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
          break;
        }
        case 'sheet-pull': {
          try {
            const settings = await getSettings();
            if (!settings.sheetId) throw new Error('No Sheet ID configured');
            
            // Get raw sheet data
            const { getRawSheetData } = await import('../lib/sheets');
            const data = await getRawSheetData(settings.sheetId);
            
            sendResponse({ ok: true, rows: data.rows, header: data.header });
          } catch (e: any) {
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
          break;
        }
        case 'sheet-update': {
          const recordId = (msg as any).recordId ?? (msg as any).record_id;
          const patch = (msg as any).patch ?? {};
          console.debug('[bg][sheet-update] req', { recordId, keys: Object.keys(patch) });

          (async () => {
            try {
              if (!recordId) throw new Error('Missing recordId');
              const settings = await getSettings();
              if (!settings.sheetId) throw new Error('NO_SHEET_ID');

              // Ensure header has the trailing Record ID column and correct order
              await ensureHeaderRow(settings.sheetId);
              const { updateRowByRecordId } = await import('../lib/sheets');
              const out = await updateRowByRecordId(settings.sheetId, recordId, patch);
              
              // Update recent cache optimistically
              const rec = await chrome.storage.local.get(['recentEntries']);
              const list: CaptureEntry[] = rec.recentEntries || [];
              const idx = list.findIndex((e) => (e.record_id || '') === recordId);
              if (idx !== -1) {
                list[idx] = { ...list[idx], ...patch };
                await chrome.storage.local.set({ recentEntries: list });
              }
              
              try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
              sendResponse({ ok: true, version: out.version });
            } catch (err: any) {
              console.error('[bg][sheet-update] error', err);
              sendResponse({ ok: false, error: err?.message ?? String(err) });
            }
          })();
          
          return true; // IMPORTANT for async response
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});


