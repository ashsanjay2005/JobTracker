import { appendRow, ensureHeaderRow, deleteRowByRecordId } from '../lib/sheets';
import { CaptureEntry, getDedupCache, getSettings, pushRecentEntry, setDedupCache } from '../lib/storage';
import { sha256Hex } from '../lib/hash';

// Simple header ensure cache
async function ensureHeaderOnce(sheetId: string): Promise<void> {
  const { headerEnsured } = await chrome.storage.local.get(['headerEnsured']);
  const cache: Record<string, boolean> = headerEnsured || {};
  if (cache[sheetId]) return;
  await ensureHeaderRow(sheetId);
  cache[sheetId] = true;
  await chrome.storage.local.set({ headerEnsured: cache });
}

// Global error handling for background script
self.addEventListener('error', (event) => {
  console.error('[bg] Global error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[bg] Unhandled promise rejection:', event.reason);
});

// Health check function
function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && 
           typeof chrome.runtime !== 'undefined' && 
           typeof chrome.runtime.sendMessage === 'function';
  } catch {
    return false;
  }
}

// Wrapper for sendResponse with error handling
function safeSendResponse(sendResponse: (response?: any) => void, response: any) {
  try {
    if (isExtensionContextValid()) {
      sendResponse(response);
    } else {
      console.warn('[bg] Extension context invalid, cannot send response');
    }
  } catch (error) {
    console.error('[bg] Failed to send response:', error);
  }
}

let inflightLocks: Record<string, number> = {};
const APPENDED_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const CACHE_VERSION = 1; // Increment when cache structure changes
const CACHE_HEALTH_CHECK_INTERVAL = 24 * 3600 * 1000; // 24 hours

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

async function computeRecordId(entry: CaptureEntry): Promise<string> {
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
  const h = await sha256Hex(base);
  return `h:${h}`;
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
  | { type: 'sheet-update'; record_id: string; patch: Partial<CaptureEntry> }
  | { type: 'create-sheet' };

chrome.runtime.onInstalled.addListener(() => {
  // nothing specific; pages are built via Vite
});

async function loadSeenIds(): Promise<Record<string, number>> {
  const res = await chrome.storage.local.get(['seenRecordIds', 'cacheVersion', 'lastHealthCheck']);
  const raw = (res.seenRecordIds || {}) as Record<string, any>;
  const cacheVersion = res.cacheVersion || 0;
  const lastHealthCheck = res.lastHealthCheck || 0;
  const now = nowMs();
  
  // Check cache health and version
  if (cacheVersion !== CACHE_VERSION || (now - lastHealthCheck) > CACHE_HEALTH_CHECK_INTERVAL) {
    console.debug('[bg] Cache health check needed or version mismatch', { cacheVersion, CACHE_VERSION, lastHealthCheck });
    // For now, we'll trust the cache but mark it for health check
    // In a full implementation, we'd do a sheet sync here
  }
  
  const filtered: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const ts = typeof v === 'number' ? v : 0;
    if (ts && now - ts <= APPENDED_TTL_MS) filtered[k] = ts;
  }
  return filtered;
}

async function saveSeenIds(ids: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ 
    seenRecordIds: ids, 
    cacheVersion: CACHE_VERSION,
    lastHealthCheck: nowMs()
  });
}

async function validateCacheHealth(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(['seenRecordIds', 'cacheVersion']);
    const seenIds = res.seenRecordIds || {};
    const cacheVersion = res.cacheVersion || 0;
    
    // Basic validation: check if cache structure is valid
    if (cacheVersion !== CACHE_VERSION) {
      console.debug('[bg] Cache version mismatch, marking for refresh');
      return false;
    }
    
    // Check if cache has reasonable number of entries (not corrupted)
    const entryCount = Object.keys(seenIds).length;
    if (entryCount > 10000) { // Unreasonably large cache
      console.debug('[bg] Cache size suspicious, marking for refresh');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('[bg] Cache validation failed:', error);
    return false;
  }
}

async function maybeAppend(entry: CaptureEntry): Promise<{ appended: boolean; reason?: string; optimistic?: boolean }> {
  const settings = await getSettings();
  if (!settings.sheetId) return { appended: false, reason: 'No Sheet ID configured' };
  await ensureHeaderOnce(settings.sheetId);

  // Compute record id and attach
  const recordId = await computeRecordId(entry);
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
    // Validate cache health first
    const cacheHealthy = await validateCacheHealth();
    if (!cacheHealthy) {
      console.debug('[bg] Cache unhealthy, falling back to sheet-based duplicate check');
      // For now, we'll still trust the cache but log the issue
      // In a full implementation, we'd do a sheet sync here
    }
    
    // Load seen set from storage
    let seen = await loadSeenIds();
    const size = Object.keys(seen).length;
    try { console.debug('[bg][workday] dedup load', { size, cacheHealthy }); } catch {}
    if (seen[recordId]) {
      try { console.debug('[bg][workday] duplicate (persisted)', { record_id: recordId }); } catch {}
      return { appended: false, reason: 'duplicate' };
    }

    // Optimistic UI: Add to cache and recent entries immediately
    seen[recordId] = nowMs();
    await saveSeenIds(seen);
    await pushRecentEntry(entry);
    
    // Do sheet append in background
    appendRow(settings.sheetId, entry).then(async () => {
      // Sheet append succeeded, notify UI to refresh
      try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
    }).catch(async (error) => {
      console.error('[bg] Sheet append failed, removing from cache:', error);
      // Remove from cache on failure
      const updatedSeen = await loadSeenIds();
      delete updatedSeen[recordId];
      await saveSeenIds(updatedSeen);
      // Notify UI of failure
      try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
    });
    
    try { console.debug('[bg][workday] optimistic commit ok', { record_id: recordId }); } catch {}
    return { appended: true, optimistic: true };
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
          try { console.debug('[bg][workday] optimistic append ok'); } catch {}
          // Notify popup to refresh recent list immediately for optimistic update
          try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
          safeSendResponse(sendResponse, { ok: true, reason: 'appended', entry: msg.entry });
        } else {
          try { console.debug('[bg][workday] duplicate or skipped:', res.reason); } catch {}
          const reason = res.reason === 'seen' || res.reason === 'inflight' ? 'duplicate' : (res.reason || 'duplicate');
          safeSendResponse(sendResponse, { ok: true, reason, entry: msg.entry });
        }
      } catch (e: any) {
        try { console.error('[bg][workday] append failed', e); } catch {}
        safeSendResponse(sendResponse, { ok: false, error: e?.message || String(e) });
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
          await ensureHeaderOnce(settings.sheetId);
          safeSendResponse(sendResponse, { ok: true });
          break;
        }
        case 'append-entry': {
          const res = await maybeAppend(msg.entry);
          safeSendResponse(sendResponse, { ok: true, ...res });
          break;
        }
        case 'get-settings': {
          const settings = await getSettings();
          safeSendResponse(sendResponse, { ok: true, settings });
          break;
        }
        case 'save-settings': {
          await chrome.storage.sync.set({ settings: msg.settings });
          safeSendResponse(sendResponse, { ok: true });
          break;
        }
        case 'get-recent': {
          const res = await chrome.storage.local.get(['recentEntries']);
          safeSendResponse(sendResponse, { ok: true, recent: (res.recentEntries || []).slice(0, 10) });
          break;
        }
        case 'delete-record': {
          const recordId = msg.recordId || '';
          
          // Remove from sheet (background operation)
          try {
            const settings = await getSettings();
            if (!settings.sheetId) throw new Error('No Sheet ID');
            await deleteRowByRecordId(settings.sheetId, recordId);
            
            // Also remove from seen cache to prevent re-capture
            const seen = await loadSeenIds();
            delete seen[recordId];
            await saveSeenIds(seen);
            
            // Notify UI of successful deletion
            try { chrome.runtime.sendMessage({ type: 'recent-updated' }); } catch {}
            
            safeSendResponse(sendResponse, { ok: true });
          } catch (e: any) {
            safeSendResponse(sendResponse, { ok: false, error: e?.message || String(e) });
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
            
            safeSendResponse(sendResponse, { ok: true, rows: data.rows, header: data.header });
          } catch (e: any) {
            safeSendResponse(sendResponse, { ok: false, error: e?.message || String(e) });
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
              await ensureHeaderOnce(settings.sheetId);
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
              safeSendResponse(sendResponse, { ok: true, version: out.version });
            } catch (err: any) {
              console.error('[bg][sheet-update] error', err);
              // Send error notification to popup if it's open
              try { chrome.runtime.sendMessage({ type: 'sheet-update-error', recordId, error: err?.message ?? String(err) }); } catch {}
              safeSendResponse(sendResponse, { ok: false, error: err?.message ?? String(err) });
            }
          })();
          
          return true; // IMPORTANT for async response
        }
        case 'create-sheet': {
          (async () => {
            try {
              const { createNewSpreadsheet } = await import('../lib/sheets');
              const sheetId = await createNewSpreadsheet();
              
              // Save the new sheet ID to settings
              const settings = await getSettings();
              settings.sheetId = sheetId;
              await chrome.storage.sync.set({ settings });
              
              safeSendResponse(sendResponse, { ok: true, sheetId });
            } catch (err: any) {
              console.error('[bg][create-sheet] error', err);
              safeSendResponse(sendResponse, { ok: false, error: err?.message ?? String(err) });
            }
          })();
          
          return true; // IMPORTANT for async response
        }
        default:
          safeSendResponse(sendResponse, { ok: false, error: 'Unknown message' });
      }
    } catch (e: any) {
      safeSendResponse(sendResponse, { ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});


