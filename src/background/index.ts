import { appendRow, ensureHeaderRow } from '../lib/sheets';
import { CaptureEntry, getDedupCache, getSettings, pushRecentEntry, setDedupCache } from '../lib/storage';
import { sha256Hex } from '../lib/hash';

type InboundMessage =
  | { type: 'test-connection' }
  | { type: 'append-entry'; entry: CaptureEntry }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: any }
  | { type: 'get-recent' };

chrome.runtime.onInstalled.addListener(() => {
  // nothing specific; pages are built via Vite
});

async function maybeAppend(entry: CaptureEntry): Promise<{ appended: boolean; reason?: string }> {
  const settings = await getSettings();
  if (!settings.sheetId) return { appended: false, reason: 'No Sheet ID configured' };
  await ensureHeaderRow(settings.sheetId);

  const dedupKey = await sha256Hex(`${entry.job_posting_url}|${entry.company}|${entry.job_title}`);
  const cache = await getDedupCache();
  const now = Date.now();
  const ttl48h = 48 * 3600 * 1000;
  const ttlShort = 60 * 1000;
  const last = cache[dedupKey];
  if (last && (now - last < ttlShort || now - last < ttl48h)) {
    return { appended: false, reason: 'Duplicate within TTL' };
  }

  await appendRow(settings.sheetId, entry);
  cache[dedupKey] = now;
  await setDedupCache(cache);
  await pushRecentEntry(entry);
  return { appended: true };
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
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});


