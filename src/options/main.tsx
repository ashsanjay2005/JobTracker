import React from 'react';
import { createRoot } from 'react-dom/client';

type Settings = {
  sheetId: string;
  enableLinkedIn: boolean;
  enableWorkday: boolean;
  enableOracleTaleo: boolean;
  enableGeneric: boolean;
  showToast: boolean;
};

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
  _rowIndex?: number;
};

type Tab = 'dashboard' | 'captures' | 'sites' | 'settings' | 'debug';

// Helper Components
const Card: React.FC<{ title: string; value: string; className?: string }> = ({ title, value, className = '' }) => (
  <div className={`bg-gray-800 rounded-lg p-4 ${className}`}>
    <div className="text-sm text-gray-400">{title}</div>
    <div className="text-2xl font-semibold mt-1">{value}</div>
  </div>
);

const Checkbox: React.FC<{ 
  checked: boolean; 
  onChange: (checked: boolean) => void; 
  label: string; 
  className?: string 
}> = ({ checked, onChange, label, className = '' }) => (
  <label className={`flex items-center space-x-2 cursor-pointer ${className}`}>
    <input 
      type="checkbox" 
      checked={checked} 
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 focus:ring-2"
    />
    <span className="text-sm">{label}</span>
  </label>
);

function App() {
  const [activeTab, setActiveTab] = React.useState<Tab>('dashboard');
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  
  // Dashboard state
  const [allEntries, setAllEntries] = React.useState<Entry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [savingStates, setSavingStates] = React.useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});
  const [sortBy, setSortBy] = React.useState<'newest' | 'oldest'>('newest');
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [searchQuery, setSearchQuery] = React.useState('');

  React.useEffect(() => {
    chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
      if (res?.ok) setSettings(res.settings);
    });
  }, []);

  // Load all entries when dashboard tab is active
  React.useEffect(() => {
    if (activeTab === 'dashboard') {
      loadAllEntries();
    }
  }, [activeTab]);

  const loadAllEntries = React.useCallback(() => {
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'sheet-pull' }, (res) => {
      setLoading(false);
      if (res?.ok && res.rows) {
        // Convert sheet rows back to Entry format using header mapping
        const entries: Entry[] = res.rows.map((row: any[], index: number) => {
          const header = res.header || [];
          
          // Find column indices using header names
          const getCol = (name: string) => {
            const idx = header.findIndex(h => h === name);
            const value = idx >= 0 ? (row[idx] || '') : '';
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
          
          return {
            job_title: cleanTitle,
            date_applied: getCol('Date Applied'),
            company: getCol('Company'),
            location: getCol('Location'),
            listing_posted_date: getCol('Date Posted'),
            job_timeline: getCol('Job Timeline'),
            cover_letter: getCol('Cover Letter'),
            status: getCol('Status'),
            record_id: recordId,
            job_posting_url: jobUrl,
            salary_text: '',
            _rowIndex: index
          };
        }).filter(entry => entry.record_id && entry.record_id.trim() !== '');
        
        setAllEntries(entries);
      } else {
        console.error('Failed to load entries:', res);
        setStatus('Failed to load job history');
        setTimeout(() => setStatus(null), 3000);
      }
    });
  }, []);

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

  const toggleExpand = (rid?: string) => setExpandedId((cur) => (cur === rid ? null : (rid || null)));

  const onFieldChange = (idx: number, field: keyof Entry, value: string) => {
    setAllEntries((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      return copy;
    });
    const rid = (allEntries[idx] && allEntries[idx].record_id) || '';
    if (rid) {
      setSavingStates((s) => ({ ...s, [rid]: 'saving' }));
      // Include identity fields for robust row matching when legacy rows lack Record ID in the sheet
      const identity: Partial<Entry> = {
        job_title: allEntries[idx]?.job_title,
        company: allEntries[idx]?.company,
        date_applied: allEntries[idx]?.date_applied
      };
      queueSave(rid, { ...(identity as any), [field]: value } as any);
    }
  };

  const debounceMap = React.useRef<Record<string, number>>({}).current;
  const queueSave = (rid: string, patch: Partial<Entry>) => {
    const key = `${rid}:${Object.keys(patch).sort().join(',')}`;
    if (debounceMap[key]) window.clearTimeout(debounceMap[key]);
    debounceMap[key] = window.setTimeout(() => {
      savePatch(rid, patch);
      delete debounceMap[key];
    }, 800);
  };

  const savePatch = React.useCallback((recordId: string, patch: Partial<Entry>) => {
    chrome.runtime.sendMessage({ type: 'sheet-update', recordId, patch }, (res) => {
      if ((chrome.runtime as any).lastError) {
        setSavingStates((s) => ({ ...s, [recordId]: 'error' }));
        return;
      }
      
      if (res?.ok) {
        setSavingStates((s) => ({ ...s, [recordId]: 'saved' }));
        setTimeout(() => {
          setSavingStates((s) => ({ ...s, [recordId]: 'idle' }));
        }, 2000);
      } else {
        setSavingStates((s) => ({ ...s, [recordId]: 'error' }));
      }
    });
  }, []);

  const deleteEntry = async (rec: Entry, idx: number) => {
    const btn = document.activeElement as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    
    chrome.runtime.sendMessage({ type: 'delete-record', recordId: rec.record_id }, (res) => {
      if (res?.ok) {
        setAllEntries((prev) => prev.filter((e) => (e.record_id || '') !== (rec.record_id || '')));
        setStatus('Entry deleted successfully');
        setTimeout(() => setStatus(null), 2000);
      } else {
        setStatus('Delete failed — try again');
        setTimeout(() => setStatus(null), 3000);
      }
      if (btn) btn.disabled = false;
    });
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    await chrome.runtime.sendMessage({ type: 'save-settings', settings });
    setSaving(false);
    setStatus('Saved.');
    setTimeout(() => setStatus(null), 1500);
  };

  const testConnection = async () => {
    setTesting(true);
    chrome.runtime.sendMessage({ type: 'test-connection' }, (res) => {
      setTesting(false);
      const message = res?.ok ? 'Connection OK' : `Failed: ${res?.error || 'unknown'}`;
      setStatus(message);
      setTimeout(() => setStatus(null), 2500);
    });
  };

  const openGoogleSheet = () => {
    if (settings?.sheetId) {
      const url = `https://docs.google.com/spreadsheets/d/${settings.sheetId}/edit`;
      chrome.tabs.create({ url });
    }
  };

  const getOAuthClientId = () => {
    const manifest = chrome.runtime.getManifest() as any;
    const clientId = manifest?.oauth2?.client_id || '';
    return clientId.length > 6 ? `...${clientId.slice(-6)}` : clientId;
  };

  // Filter and sort entries
  const filteredAndSortedEntries = React.useMemo(() => {
    let filtered = allEntries.filter(entry => {
      // Status filter
      if (statusFilter !== 'all' && entry.status !== statusFilter) {
        return false;
      }
      
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = entry.job_title?.toLowerCase().includes(query);
        const matchesCompany = entry.company?.toLowerCase().includes(query);
        if (!matchesTitle && !matchesCompany) {
          return false;
        }
      }
      
      return true;
    });

    // Sort entries
    filtered.sort((a, b) => {
      const dateA = new Date(a.date_applied || '');
      const dateB = new Date(b.date_applied || '');
      
      if (sortBy === 'newest') {
        return dateB.getTime() - dateA.getTime();
      } else {
        return dateA.getTime() - dateB.getTime();
      }
    });

    return filtered;
  }, [allEntries, statusFilter, searchQuery, sortBy]);

  const STATUS_OPTIONS = ['Applied', 'Interviewing', 'Accepted', 'Rejected', 'Withdrawn'];

  if (!settings) return <div className="p-6">Loading…</div>;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'captures', label: 'Captures' },
    { id: 'sites', label: 'Sites' },
    { id: 'settings', label: 'Settings' },
    { id: 'debug', label: 'Debug' }
  ];

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <h1 className="text-xl font-semibold">Job Tracker Dashboard</h1>
            <div className="flex space-x-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {status && (
          <div className="mb-4 p-3 bg-emerald-900 text-emerald-100 rounded-md text-sm">
            {status}
          </div>
        )}

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">Job Application History</h2>
              <div className="flex items-center space-x-4">
                <span className="text-sm text-gray-400">
                  {filteredAndSortedEntries.length} of {allEntries.length} applications
                </span>
                <button
                  onClick={loadAllEntries}
                  disabled={loading}
                  className="px-3 py-1 text-sm bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-50"
                >
                  {loading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
            </div>

            {/* Filters and Controls */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Search */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Search</label>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Company or job title..."
                    className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Status Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Status</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All Statuses</option>
                    {STATUS_OPTIONS.map(status => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </div>

                {/* Sort */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Sort by</label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as 'newest' | 'oldest')}
                    className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="newest">Newest Applied First</option>
                    <option value="oldest">Oldest Applied First</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Job Entries List */}
            <div className="space-y-3">
              {loading ? (
                <div className="text-center py-8 text-gray-400">Loading job history...</div>
              ) : filteredAndSortedEntries.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  {allEntries.length === 0 ? 'No job applications found' : 'No applications match your filters'}
                </div>
              ) : (
                filteredAndSortedEntries.map((e, i) => {
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
                      className="p-4 rounded-lg bg-gray-800 hover:bg-gray-700/80 shadow-sm transition-colors cursor-pointer outline-none focus:ring-2 focus:ring-sky-400"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className={`text-base font-semibold leading-tight ${isOpen ? '' : 'truncate'}`} title={isOpen ? '' : (e.job_title || '—')}>
                                {e.job_title || '—'}
                              </div>
                              <div className={`text-sm text-gray-300 ${isOpen ? '' : 'truncate'}`} title={isOpen ? '' : (e.company || '—')}>
                                {e.company || '—'}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button 
                                aria-label="Toggle details" 
                                className={`px-2 py-1 rounded text-gray-400 hover:text-white hover:bg-gray-600 transition-all duration-200 focus:ring-2 focus:ring-sky-400 focus:outline-none ${isOpen ? 'rotate-180 bg-gray-600' : ''}`} 
                                onClick={(ev) => { ev.stopPropagation(); toggleExpand(rid); }}
                              >
                                ⌄
                              </button>
                            </div>
                          </div>
                          <div className="mt-1 text-sm text-gray-400">
                            <span className={isOpen ? '' : 'truncate'} title={isOpen ? '' : formatLocation(e.location || '')}>
                              {formatLocation(e.location || '')}
                            </span>
                          </div>
                        </div>
                      </div>
                      
                      {isOpen && (
                        <div className="mt-4 border-t border-white/5 pt-4 space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            <input 
                              className="bg-gray-900 text-sm px-3 h-9 rounded" 
                              value={e.company}
                              onChange={(ev) => onFieldChange(i, 'company', ev.target.value)} 
                              onClick={(ev) => ev.stopPropagation()}
                              placeholder="Company" 
                            />
                            <input 
                              className="bg-gray-900 text-sm px-3 h-9 rounded" 
                              value={e.job_title}
                              onChange={(ev) => onFieldChange(i, 'job_title', ev.target.value)} 
                              onClick={(ev) => ev.stopPropagation()}
                              placeholder="Job Title" 
                            />
                            <input 
                              className="bg-gray-900 text-sm px-3 h-9 rounded" 
                              value={e.location}
                              onChange={(ev) => onFieldChange(i, 'location', ev.target.value)} 
                              onClick={(ev) => ev.stopPropagation()}
                              placeholder="Location" 
                            />
                            <select 
                              className="h-9 px-3 pr-8 rounded bg-slate-900/70 border border-slate-700 text-slate-100 appearance-none cursor-pointer text-sm" 
                              value={e.status || 'Applied'}
                              onChange={(ev) => onFieldChange(i, 'status', ev.target.value)}
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </div>
                          
                          {/* Status and Dates Section with Headings */}
                          <div className="space-y-2">
                            <div className="text-sm text-gray-300 font-medium">Status & Dates</div>
                            <div className="grid grid-cols-1 gap-2 text-sm">
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
                          
                          <div className="text-xs text-gray-400">
                            {savingStates[rid] === 'saving' && 'Saving…'}
                            {savingStates[rid] === 'saved' && 'Saved'}
                            {savingStates[rid] === 'error' && <span className="text-rose-300">Save failed — try again.</span>}
                          </div>
                          
                          <div className="border-t border-white/10 pt-3">
                            <button 
                              onClick={() => { 
                                if (confirm('Are you sure you want to delete this job entry?')) {
                                  deleteEntry(e, i); 
                                }
                              }} 
                              className="w-full text-sm px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                              aria-label="Delete job entry"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Captures Tab */}
        {activeTab === 'captures' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Captures</h2>
            <div className="bg-gray-800 rounded-lg p-6">
              <p className="text-gray-300">Captures log coming soon</p>
            </div>
          </div>
        )}

        {/* Sites Tab */}
        {activeTab === 'sites' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Sites</h2>
            <div className="bg-gray-800 rounded-lg p-6">
              <p className="text-gray-300">Per-site toggles and allow/block lists coming soon</p>
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Settings</h2>
            
            <div className="bg-gray-800 rounded-lg p-6 space-y-6">
              {/* Google Sheet ID */}
      <div className="space-y-2">
        <label className="block text-sm font-medium">Google Sheet ID</label>
                <input
                  value={settings.sheetId}
                  onChange={(e) => setSettings({ ...settings, sheetId: e.target.value })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="1abcDEF..."
                />
                <p className="text-xs text-gray-400">The ID in `https://docs.google.com/spreadsheets/d/ID/edit`</p>
              </div>

              {/* Checkboxes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Checkbox
                  checked={settings.enableLinkedIn}
                  onChange={(checked) => setSettings({ ...settings, enableLinkedIn: checked })}
                  label="LinkedIn"
                />
                <Checkbox
                  checked={settings.enableWorkday}
                  onChange={(checked) => setSettings({ ...settings, enableWorkday: checked })}
                  label="Workday"
                />
                <Checkbox
                  checked={settings.enableOracleTaleo}
                  onChange={(checked) => setSettings({ ...settings, enableOracleTaleo: checked })}
                  label="Oracle-Taleo"
                />
                <Checkbox
                  checked={settings.enableGeneric}
                  onChange={(checked) => setSettings({ ...settings, enableGeneric: checked })}
                  label="Any site (generic)"
                />
                <Checkbox
                  checked={settings.showToast}
                  onChange={(checked) => setSettings({ ...settings, showToast: checked })}
                  label="Show success toast"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-4">
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={testConnection}
                  disabled={testing}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50"
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Debug Tab */}
        {activeTab === 'debug' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Debug</h2>
            
            <div className="bg-gray-800 rounded-lg p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">OAuth Client ID</label>
                <input
                  value={getOAuthClientId()}
                  readOnly
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white"
                />
      </div>
      
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Sheet ID</label>
                <input
                  value={settings.sheetId || 'Not set'}
                  readOnly
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white"
                />
              </div>
            </div>
      </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


