export type Settings = {
  sheetId: string;
  enableLinkedIn: boolean;
  enableWorkday: boolean;
  enableOracleTaleo: boolean;
  enableGeneric: boolean;
  showToast: boolean;
  oauthClientId?: string; // optional override if not using manifest oauth2.client_id
};

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
  const res = await chrome.storage.sync.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(res.settings || {}) } as Settings;
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  const merged = { ...current, ...settings } as Settings;
  await chrome.storage.sync.set({ settings: merged });
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


