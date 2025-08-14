import { appendRow, ensureHeaderRow, deleteRowByRecordId } from '../lib/sheets';
import { CaptureEntry, getDedupCache, getSettings, pushRecentEntry, setDedupCache } from '../lib/storage';
import { sha256Hex } from '../lib/hash';
let inflightLocks: Record<string, number> = {};

function nowMs() { return Date.now(); }

function computeRecordId(entry: CaptureEntry): string {
  // Prefer LinkedIn job ID extracted from cleaned job URL
  const m = (entry.job_posting_url || '').match(/\/jobs\/view\/(\d+)\//);
  if (m && m[1]) return `li:${m[1]}`;
  const base = `${entry.job_title}|${entry.company}|${entry.job_posting_url}|${entry.date_applied}`;
  return `h:${sha256Hex(base)}`;
}

type InboundMessage =
  | { type: 'test-connection' }
  | { type: 'append-entry'; entry: CaptureEntry }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: any }
  | { type: 'get-recent' }
  | { type: 'delete-record'; recordId?: string };

chrome.runtime.onInstalled.addListener(() => {
  // nothing specific; pages are built via Vite
});

async function loadSeenIds(): Promise<Record<string, true>> {
  const res = await chrome.storage.local.get(['seenRecordIds']);
  return (res.seenRecordIds || {}) as Record<string, true>;
}

async function saveSeenIds(ids: Record<string, true>): Promise<void> {
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
    console.log('dedup: inflight skip id=', recordId);
    return { appended: false, reason: 'inflight' };
  }
  inflightLocks[recordId] = now + 10_000;

  try {
    // Load seen set from storage
    let seen = await loadSeenIds();
    const size = Object.keys(seen).length;
    console.log('dedup: load size=', size);
    if (seen[recordId]) {
      console.log('dedup: skip id=', recordId);
      return { appended: false, reason: 'seen' };
    }

    // Append to Sheets first, then commit to seen + recent
    await appendRow(settings.sheetId, entry);
    // Re-load and commit to be extra safe
    seen = await loadSeenIds();
    seen[recordId] = true;
    await saveSeenIds(seen);
    await pushRecentEntry(entry);
    console.log('dedup: commit id=', recordId);
    return { appended: true };
  } finally {
    // Release lock
    delete inflightLocks[recordId];
  }
}

chrome.runtime.onMessage.addListener((msg: InboundMessage, _sender, sendResponse) => {
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
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});


