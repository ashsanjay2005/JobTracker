import React from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';

type Entry = {
  date_applied: string;
  job_title: string;
  company: string;
  location: string;
  job_posting_url: string;
  salary_text: string;
  listing_posted_date: string;
  job_timeline: string;
  record_id?: string;
  cover_letter?: string;
  status?: string;
  _rowIndex?: number; // Added for original row index
};

function App() {
  const [recent, setRecent] = React.useState<Entry[]>([]);
  const [sheetId, setSheetId] = React.useState('');
  const [saving, setSaving] = React.useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [lastSync, setLastSync] = React.useState<Date | null>(null);

  const syncFromSheet = React.useCallback(() => {
    setSyncing(true);
    chrome.runtime.sendMessage({ type: 'sheet-pull' }, (res) => {
      setSyncing(false);
      if (res?.ok && res.rows) {
        console.debug('[popup][sync] raw sheet data:', res.rows.length, 'rows:', res.rows);
        console.debug('[popup][sync] header:', res.header);
        
        // Debug: Show first few rows in detail
        if (res.rows.length > 0) {
          console.debug('[popup][sync] first row sample:', {
            row: res.rows[0],
            header: res.header,
            jobTitle: res.rows[0][0],
            jobTimeline: res.rows[0][5], // Assuming Job Timeline is at index 5
            company: res.rows[0][2],
            location: res.rows[0][3]
          });
        }
        
        // Convert sheet rows back to Entry format using header mapping
        const entries: Entry[] = res.rows.map((row: any[], index: number) => {
          const header = res.header || [];
          
          // Find column indices using header names
          const getCol = (name: string) => {
            const idx = header.findIndex(h => h === name);
            const value = idx >= 0 ? (row[idx] || '') : '';
            console.debug(`[popup][sync] getCol(${name}): idx=${idx}, value="${value}"`);
            return value;
          };
          
          const jobTitleCell = getCol('Job Title');
          const recordId = getCol('Record ID');
          
          // Extract URL from HYPERLINK formula if present
          let jobUrl = '';
          if (typeof jobTitleCell === 'string' && jobTitleCell.includes('HYPERLINK')) {
            const urlMatch = jobTitleCell.match(/HYPERLINK\("([^"]+)"/);
            if (urlMatch && urlMatch[1]) {
              jobUrl = urlMatch[1];
            }
          }
          
          // Extract clean title (remove HYPERLINK formula if present)
          let cleanTitle = jobTitleCell;
          if (typeof jobTitleCell === 'string' && jobTitleCell.includes('HYPERLINK')) {
            const titleMatch = jobTitleCell.match(/HYPERLINK\("[^"]+","([^"]+)"/);
            if (titleMatch && titleMatch[1]) {
              cleanTitle = titleMatch[1];
            }
          }
          
          // Get job timeline - this should be the actual value from the sheet
          const jobTimeline = getCol('Job Timeline');
          
          console.debug('[popup][sync] row data:', {
            jobTitleCell,
            cleanTitle,
            jobUrl,
            jobTimeline,
            recordId,
            rowIndex: index
          });
          
          return {
            job_title: cleanTitle,
            date_applied: getCol('Date Applied'),
            company: getCol('Company'),
            location: getCol('Location'),
            listing_posted_date: getCol('Date Posted'),
            job_timeline: jobTimeline,
            cover_letter: getCol('Cover Letter'),
            status: getCol('Status'),
            record_id: recordId,
            job_posting_url: jobUrl,
            salary_text: '',
            _rowIndex: index // Preserve original row order
          };
        }).filter(entry => entry.record_id && entry.record_id.trim() !== ''); // Only include entries with a valid record_id
        
        console.debug('[popup][sync] converted entries:', entries.length, entries);
        
        // Debug: Show all entries with their dates
        console.debug('[popup][sync] all entries with dates:', entries.map(e => ({
          title: e.job_title,
          date: e.date_applied,
          recordId: e.record_id,
          rowIndex: (e as any)._rowIndex
        })));
        
        // Take the last 10 entries (most recent are at the bottom of the sheet) and reverse them
        const recentEntries = entries.slice(-10).reverse();
        
        console.debug('[popup][sync] final entries (last 10, reversed):', recentEntries.length, recentEntries);
        
        // Update both local storage and UI
        chrome.storage.local.set({ recentEntries }, () => {
          setRecent(recentEntries);
          setLastSync(new Date());
          toast(`Synced ${recentEntries.length} recent entries from sheet`);
        });
      } else {
        console.error('[popup][sync] failed:', res);
        toast(res?.error || 'Sync failed — try again.');
      }
    });
  }, []);

  React.useEffect(() => {
    chrome.runtime.sendMessage({ type: 'get-recent' }, (res) => {
      if (res?.ok) setRecent(res.recent || []);
    });
    chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
      if (res?.ok) setSheetId(res.settings?.sheetId || '');
    });
    
    // Auto-sync every 2 minutes when popup is open (less frequent to avoid API limits)
    const autoSyncInterval = setInterval(syncFromSheet, 120000);
    
    const onMsg = (msg: any) => {
      if (msg?.type === 'recent-updated') {
        chrome.runtime.sendMessage({ type: 'get-recent' }, (res) => {
          if (res?.ok) setRecent(res.recent || []);
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    
    return () => {
      clearInterval(autoSyncInterval);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, [syncFromSheet]);

  const openOptions = () => chrome.runtime.openOptionsPage();
  const openSheet = () => {
    if (!sheetId) return openOptions();
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    chrome.tabs.create({ url });
  };

  const STATUS_OPTIONS = ['Applied', 'Interviewing', 'Accepted', 'Rejected', 'Withdrawn'];
  const COVER_OPTIONS = ['Not set', 'Yes', 'No'];

  const savePatch = React.useCallback((recordId: string, patch: Partial<Entry>) => {
    chrome.runtime.sendMessage({ type: 'sheet-update', recordId, patch }, (res) => {
      if ((chrome.runtime as any).lastError) {
        try { console.debug('[popup][sheet-update] lastError', (chrome.runtime as any).lastError.message); } catch {}
        toast('Save failed — try again.');
        return;
      }
      try { console.debug('[popup][sheet-update] resp', res); } catch {}
      
      if (res?.ok) {
        toast('Saved');
      } else {
        const error = res?.error || 'Unknown error';
        if (error === 'NO_SHEET_ID') {
          toast('No sheet configured — set it in Options.');
        } else if (error.includes('Record ID not found') || error.includes('Row not found')) {
          toast('Row not found — tap Sync, then try again.');
        } else {
          toast('Save failed — try again.');
        }
      }
    });
  }, []);

  const debounceMap = React.useRef<Record<string, number>>({}).current;
  const queueSave = (rid: string, patch: Partial<Entry>) => {
    const key = `${rid}:${Object.keys(patch).sort().join(',')}`;
    if (debounceMap[key]) window.clearTimeout(debounceMap[key]);
    debounceMap[key] = window.setTimeout(() => {
      savePatch(rid, patch);
      delete debounceMap[key];
    }, 800);
  };

  const onFieldChange = (idx: number, field: keyof Entry, value: string) => {
    setRecent((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      return copy;
    });
    const rid = (recent[idx] && recent[idx].record_id) || '';
    if (rid) {
      setSaving((s) => ({ ...s, [rid]: 'saving' }));
      // Include identity fields for robust row matching when legacy rows lack Record ID in the sheet
      const identity: Partial<Entry> = {
        job_title: recent[idx]?.job_title,
        company: recent[idx]?.company,
        date_applied: recent[idx]?.date_applied
      };
      queueSave(rid, { ...(identity as any), [field]: value } as any);
    }
  };

  const toast = (msg: string) => {
    const id = 'jt-pop-toast';
    let d = document.getElementById(id);
    if (!d) {
      d = document.createElement('div');
      d.id = id;
      d.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111827;color:#e5e7eb;padding:10px 14px;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;');
      document.body.appendChild(d);
    }
    d!.textContent = msg;
    setTimeout(() => d && d.remove(), 2000);
  };

  const deleteEntry = async (rec: Entry, idx: number) => {
    // Disable button by marking a transient state
    const btn = document.activeElement as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    // Load current list from storage, filter, save, then update UI if sheet delete succeeds
    chrome.storage.local.get(['recentEntries'], async (store) => {
      const list: Entry[] = store.recentEntries || [];
      const before = list.length;
      const filtered = list.filter((e) => (e.record_id || '') !== (rec.record_id || ''));
      console.log('popup delete: before', before, 'after', filtered.length);
      chrome.runtime.sendMessage({ type: 'delete-record', recordId: rec.record_id }, (res) => {
        if (res?.ok) {
          chrome.storage.local.set({ recentEntries: filtered }, () => {
            setRecent(filtered.slice(0, 10));
            toast('Deleted from log and sheet.');
            if (btn) btn.disabled = false;
          });
        } else {
          toast(res?.error || 'Delete failed — try again.');
          if (btn) btn.disabled = false;
        }
      });
    });
  };
  const toggleExpand = (rid?: string) => setExpandedId((cur) => (cur === rid ? null : (rid || null)));

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Job Tracker</h1>
        <button onClick={openOptions} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600">Options</button>
      </div>
      <button onClick={openSheet} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded text-sm">View Your Job Log</button>
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm text-gray-300">Last 10 captured</h2>
            {lastSync && (
              <div className="text-xs text-gray-500">
                Last synced: {lastSync.toLocaleTimeString()}
              </div>
            )}
          </div>
          <button 
            className={`text-xs px-2 py-1 rounded ${syncing ? 'bg-gray-600 cursor-not-allowed' : 'bg-gray-700 hover:bg-gray-600'}`} 
            onClick={syncFromSheet}
            disabled={syncing}
          >
            {syncing ? 'Syncing...' : 'Sync from Sheet'}
          </button>
        </div>
        <div className="space-y-2 max-h-80 overflow-auto pr-1">
          {recent.length === 0 && <div className="text-xs text-gray-400">No entries yet</div>}
          {recent.map((e, i) => {
            const rid = e.record_id || String(i);
            const isOpen = expandedId === rid;
            return (
              <div key={rid}
                role="button" tabIndex={0}
                onClick={() => { if (!isOpen && e.job_posting_url) { const href = /^https?:\/\//i.test(e.job_posting_url) ? e.job_posting_url : `https://${e.job_posting_url}`; chrome.tabs.create({ url: href }); } }}
                onKeyDown={(ev) => { if (!isOpen && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); if (e.job_posting_url) { const href = /^https?:\/\//i.test(e.job_posting_url) ? e.job_posting_url : `https://${e.job_posting_url}`; chrome.tabs.create({ url: href }); } } }}
                className="p-3 rounded-2xl bg-gray-800 hover:bg-gray-700/80 shadow-sm transition-colors outline-none focus:ring-2 focus:ring-sky-400">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-base font-semibold leading-tight">{e.job_title || '—'}</div>
                        <div className="text-xs text-gray-300">{e.company || '—'}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="hidden sm:inline text-[10px] text-gray-400">{e.date_applied || '—'}</span>
                        <span className="hidden sm:inline text-[10px] text-gray-400">{e.listing_posted_date || '—'}</span>
                        <span className="hidden sm:inline text-[10px] text-gray-400">{e.job_timeline || '—'}</span>
                        <span className="hidden sm:inline text-gray-400">{e.location || '—'}</span>
                        <span className="hidden sm:inline"><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span><span className="mr-1"/><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <span className="mr-1"><span /></span>
                        <button aria-label="Toggle details" className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} onClick={(ev) => { ev.stopPropagation(); toggleExpand(rid); }}>⌄</button>
                        <button aria-label="Delete" onClick={(ev) => { ev.stopPropagation(); deleteEntry(e, i); }} className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500">✕</button>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                      <span>{e.location || '—'}</span>
                      <span>{e.job_timeline || '—'}</span>
                      <span>{e.date_applied || '—'}</span>
                      <span>{e.listing_posted_date || '—'}</span>
                      <span className="ml-auto"><span className="mr-2"/><span /></span>
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 border-t border-white/5 pt-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.job_title}
                        onChange={(ev) => onFieldChange(i, 'job_title', ev.target.value)} placeholder="Job Title" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.job_posting_url}
                        onChange={(ev) => onFieldChange(i, 'job_posting_url', ev.target.value)} placeholder="Link URL" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.company}
                        onChange={(ev) => onFieldChange(i, 'company', ev.target.value)} placeholder="Company" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.location}
                        onChange={(ev) => onFieldChange(i, 'location', ev.target.value)} placeholder="Location" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.job_timeline}
                        onChange={(ev) => onFieldChange(i, 'job_timeline', ev.target.value)} placeholder="Job Timeline" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.date_applied}
                        onChange={(ev) => onFieldChange(i, 'date_applied', ev.target.value)} placeholder="Date Applied" />
                      <input className="bg-gray-900 text-xs px-2 h-10 rounded" value={e.listing_posted_date}
                        onChange={(ev) => onFieldChange(i, 'listing_posted_date', ev.target.value)} placeholder="Date Posted" />
                      <select className="h-10 px-3 pr-8 rounded-lg bg-slate-900/70 border border-slate-700 text-slate-100 appearance-none cursor-pointer text-[0.95rem]" value={e.cover_letter || 'Not set'}
                        onChange={(ev) => onFieldChange(i, 'cover_letter', ev.target.value)}>
                        {COVER_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <select className="h-10 px-3 pr-8 rounded-lg bg-slate-900/70 border border-slate-700 text-slate-100 appearance-none cursor-pointer text-[0.95rem]" value={e.status || 'Applied'}
                        onChange={(ev) => onFieldChange(i, 'status', ev.target.value)}>
                        {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {saving[rid] === 'saving' && 'Saving…'}
                      {saving[rid] === 'saved' && 'Saved'}
                      {saving[rid] === 'error' && <span className="text-rose-300">Save failed — try again.</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


