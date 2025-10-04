import React from 'react';
import { createRoot } from 'react-dom/client';
import { safeLocalSet, safeLocalGet } from '../lib/storage';
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
    
    // Auto-sync every 30 seconds when popup is open to detect sheet changes
    const autoSyncInterval = setInterval(syncFromSheet, 30000);
    
    const onMsg = (msg: any) => {
      if (msg?.type === 'recent-updated') {
        // Sync from sheet to get the latest data
        syncFromSheet();
      } else if (msg?.type === 'sheet-update-error') {
        // Handle background save errors
        toast('Save failed — try again.');
        // Reset saving state for the failed record
        if (msg.recordId) {
          setSaving((s) => ({ ...s, [msg.recordId]: 'error' }));
          setTimeout(() => {
            setSaving((s) => ({ ...s, [msg.recordId]: 'idle' }));
          }, 3000);
        }
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
    // Send message without waiting for response (fire-and-forget)
    chrome.runtime.sendMessage({ type: 'sheet-update', recordId, patch });
    
    // Show optimistic success feedback
    toast('Saving...');
    
    // Set a timeout to show success after a reasonable delay
    setTimeout(() => {
      setSaving((s) => ({ ...s, [recordId]: 'saved' }));
      setTimeout(() => {
        setSaving((s) => ({ ...s, [recordId]: 'idle' }));
      }, 2000);
    }, 1000);
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
      // Set saving state immediately for optimistic UI
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
    
    // Optimistic UI: Remove from UI immediately
    const currentList = [...recent];
    const filtered = currentList.filter((e) => (e.record_id || '') !== (rec.record_id || ''));
    setRecent(filtered);
    toast('Deleted from log and sheet.');
    
    // Update local storage optimistically
    chrome.storage.local.get(['recentEntries'], async (store) => {
      const list: Entry[] = store.recentEntries || [];
      const filteredStorage = list.filter((e) => (e.record_id || '') !== (rec.record_id || ''));
      chrome.storage.local.set({ recentEntries: filteredStorage });
    });
    
    // Do background deletion
    chrome.runtime.sendMessage({ type: 'delete-record', recordId: rec.record_id }, (res) => {
      if (!res?.ok) {
        // If deletion failed, restore the entry
        setRecent(currentList);
        toast(res?.error || 'Delete failed — entry restored.');
      }
      if (btn) btn.disabled = false;
    });
  };
  const toggleExpand = (rid?: string) => setExpandedId((cur) => (cur === rid ? null : (rid || null)));

  // Format location to show only "City, ST/Province"
  const formatLocation = (location: string): string => {
    if (!location) return '—';
    // Remove country names, postal codes, and extra text
    const cleaned = location
      .replace(/\b(Canada|USA|United States|US|CA|ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b/gi, '')
      .replace(/\b\d{5}(-\d{4})?\b/g, '') // Remove US postal codes
      .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/g, '') // Remove Canadian postal codes
      .replace(/[,\s]+/g, ' ') // Normalize spaces
      .trim();
    
    // Extract city and state/province if present
    const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}, ${parts[1]}`;
    }
    return parts[0] || location;
  };

  return (
    <div className="p-3 space-y-2 w-96">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Job Tracker</h1>
        <button onClick={openOptions} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" aria-label="Open settings">Settings</button>
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
        <div className="space-y-1 max-h-96 overflow-auto">
          {recent.length === 0 && <div className="text-xs text-gray-400">No entries yet</div>}
          {recent.map((e, i) => {
            const rid = e.record_id || String(i);
            const isOpen = expandedId === rid;
            return (
              <div 
                key={rid}
                role="button" 
                tabIndex={0}
                onClick={() => { 
                  if (e.job_posting_url) { 
                    const href = /^https?:\/\//i.test(e.job_posting_url) ? e.job_posting_url : `https://${e.job_posting_url}`; 
                    chrome.tabs.create({ url: href }); 
                  }
                }}
                onKeyDown={(ev) => { 
                  if ((ev.key === 'Enter' || ev.key === ' ') && e.job_posting_url) { 
                    ev.preventDefault(); 
                    const href = /^https?:\/\//i.test(e.job_posting_url) ? e.job_posting_url : `https://${e.job_posting_url}`; 
                    chrome.tabs.create({ url: href }); 
                  } 
                }}
                className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700/80 shadow-sm transition-colors cursor-pointer outline-none focus:ring-2 focus:ring-sky-400"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold leading-tight ${isOpen ? '' : 'truncate'}`} title={isOpen ? '' : (e.job_title || '—')}>{e.job_title || '—'}</div>
                        <div className={`text-xs text-gray-300 ${isOpen ? '' : 'truncate'}`} title={isOpen ? '' : (e.company || '—')}>{e.company || '—'}</div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button 
                          aria-label="Toggle details" 
                          className={`px-2 py-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-all duration-200 focus:ring-2 focus:ring-sky-400 focus:outline-none ${isOpen ? 'rotate-180 bg-gray-700' : ''}`} 
                          onClick={(ev) => { ev.stopPropagation(); toggleExpand(rid); }}
                        >
                          ⌄
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gray-400">
                      <span className={isOpen ? '' : 'truncate'} title={isOpen ? '' : formatLocation(e.location || '')}>{formatLocation(e.location || '')}</span>
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-2 border-t border-white/5 pt-2 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <input className="bg-gray-900 text-xs px-2 h-8 rounded" value={e.company}
                        onChange={(ev) => onFieldChange(i, 'company', ev.target.value)} 
                        onClick={(ev) => ev.stopPropagation()}
                        placeholder="Company" />
                      <input className="bg-gray-900 text-xs px-2 h-8 rounded" value={e.job_title}
                        onChange={(ev) => onFieldChange(i, 'job_title', ev.target.value)} 
                        onClick={(ev) => ev.stopPropagation()}
                        placeholder="Job Title" />
                      <input className="bg-gray-900 text-xs px-2 h-8 rounded" value={e.location}
                        onChange={(ev) => onFieldChange(i, 'location', ev.target.value)} 
                        onClick={(ev) => ev.stopPropagation()}
                        placeholder="Location" />
                      <select className="h-8 px-2 pr-6 rounded bg-slate-900/70 border border-slate-700 text-slate-100 appearance-none cursor-pointer text-xs" value={e.status || 'Applied'}
                        onChange={(ev) => onFieldChange(i, 'status', ev.target.value)}
                        onClick={(ev) => ev.stopPropagation()}>
                        {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                    
                    {/* Status and Dates Section with Headings */}
                    <div className="space-y-2">
                      <div className="text-xs text-gray-300 font-medium">Status & Dates</div>
                      <div className="grid grid-cols-1 gap-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-400">Status:</span>
                          <span className="text-gray-200">{e.status || 'Applied'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-400">Date posted:</span>
                          <span className="text-gray-200">{e.listing_posted_date || '—'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-400">Date applied:</span>
                          <span className="text-gray-200">{e.date_applied || '—'}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="text-[10px] text-gray-400">
                      {saving[rid] === 'saving' && 'Saving…'}
                      {saving[rid] === 'saved' && 'Saved'}
                      {saving[rid] === 'error' && <span className="text-rose-300">Save failed — try again.</span>}
                    </div>
                    <div className="border-t border-white/10 pt-2">
                      <button 
                        onClick={(ev) => { 
                          ev.stopPropagation(); 
                          if (confirm('Are you sure you want to delete this job entry?')) {
                            deleteEntry(e, i); 
                          }
                        }} 
                        className="w-full text-xs px-3 py-2 rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                        aria-label="Delete job entry"
                      >
                        Delete
                      </button>
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


