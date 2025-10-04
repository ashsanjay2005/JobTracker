export type Settings = {
  sheetId: string;
  enableLinkedIn: boolean;
  enableWorkday: boolean;
  enableOracleTaleo: boolean;
  enableGeneric: boolean;
  showToast: boolean;
};

// Safe storage functions to prevent sync errors
export async function safeSyncSet(data: any) {
  try { 
    await chrome.storage.sync.set(data); 
  } catch (e) { 
    console.error("sync set failed", e); 
  }
}

export async function safeSyncGet(keys: any) {
  try { 
    return await chrome.storage.sync.get(keys); 
  } catch (e) { 
    console.error("sync get failed", e); 
    return {}; 
  }
}

export async function safeLocalSet(data: any) {
  try { 
    await chrome.storage.local.set(data); 
  } catch (e) { 
    console.error("local set failed", e); 
  }
}

export async function safeLocalGet(keys: any) {
  try { 
    return await chrome.storage.local.get(keys); 
  } catch (e) { 
    console.error("local get failed", e); 
    return {}; 
  }
}

export type CaptureEntry = {
  date_applied: string;
  job_title: string;
  company: string;
  // New optional fields for robust Sheets mapping; keep legacy fields for compatibility
  location?: string;
  job_posting_url: string;
  salary_text: string;
  // Legacy name kept for backwards compatibility
  listing_posted_date: string;
  // New normalized relative posted text (e.g., "2 days ago")
  posted_relative?: string;
  job_timeline: string;
  // Stable record identifier for dedup/delete operations
  record_id?: string;
  // User-editable fields mirrored from Sheet
  cover_letter?: string; // 'Not set' | 'Yes' | 'No'
  status?: string; // 'Applied' | 'Interviewing' | 'Accepted' | 'Rejected' | 'Withdrawn'
};

export const DEFAULT_SETTINGS: Settings = {
  sheetId: '',
  enableLinkedIn: true,
  enableWorkday: true,
  enableOracleTaleo: true,
  enableGeneric: true,
  showToast: true
};

export async function getSettings(): Promise<Settings> {
  const res = await safeSyncGet(['settings']);
  const settings = res.settings || {};
  // Migration: remove old oauthClientId if it exists
  if (settings.oauthClientId) {
    delete settings.oauthClientId;
    safeSyncSet({ settings });
  }
  return { ...DEFAULT_SETTINGS, ...settings } as Settings;
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  const merged = { ...current, ...settings } as Settings;
  await safeSyncSet({ settings: merged });
}

export async function getRecentEntries(limit = 10): Promise<CaptureEntry[]> {
  const res = await chrome.storage.local.get(['recentEntries']);
  const list: CaptureEntry[] = res.recentEntries || [];
  return list.slice(0, limit);
}

export async function pushRecentEntry(entry: CaptureEntry): Promise<void> {
  const res = await chrome.storage.local.get(['recentEntries']);
  const list: CaptureEntry[] = res.recentEntries || [];
  list.unshift(entry);
  const trimmed = list.slice(0, 50);
  await chrome.storage.local.set({ recentEntries: trimmed });
}

export async function getDedupCache(): Promise<Record<string, number>> {
  const res = await chrome.storage.local.get(['dedupCache']);
  return res.dedupCache || {};
}

export async function setDedupCache(cache: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ dedupCache: cache });
}


