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

type Tab = 'overview' | 'dashboard' | 'settings';

// Helper Components
const Card: React.FC<{ title: string; value: string; className?: string }> = ({ title, value, className = '' }) => (
  <div className={`bg-gray-800 rounded-lg p-4 ${className}`} role="region" aria-label={`${title}: ${value}`}>
    <div className="text-sm text-gray-400">{title}</div>
    <div className="text-2xl font-semibold mt-1">{value}</div>
  </div>
);

// Utility functions
const formatDomain = (url: string): string => {
  try {
    const domain = new URL(url).hostname;
    return domain.replace('www.', '');
  } catch {
    return 'Unknown';
  }
};

const isInLastDays = (dateStr: string, days: number): boolean => {
  try {
    if (!dateStr || dateStr.trim() === '') return false;
    
    // Handle the format "Dec 25th 2024" by removing ordinal suffixes
    const cleanDateStr = dateStr.replace(/(\d+)(st|nd|rd|th)/g, '$1');
    const date = new Date(cleanDateStr);
    
    // Check if date is valid
    if (isNaN(date.getTime())) return false;
    
    const now = new Date();
    const diffTime = now.getTime() - date.getTime();
    const diffDays = diffTime / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= days;
  } catch {
    return false;
  }
};

const normalizeStatus = (status: string | undefined): string => {
  if (!status) return 'Applied';
  const normalized = status.toLowerCase().trim();
  const statusMap: Record<string, string> = {
    'applied': 'Applied',
    'interviewing': 'Interviewing',
    'accepted': 'Accepted',
    'rejected': 'Rejected',
    'withdrawn': 'Withdrawn'
  };
  return statusMap[normalized] || 'Applied';
};

// Favicon utility functions
const getFaviconUrl = (domain: string): string => {
  try {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return `https://${cleanDomain}/favicon.ico`;
  } catch {
    return '';
  }
};

const getGoogleFaviconUrl = (domain: string): string => {
  try {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return `https://www.google.com/s2/favicons?domain=${cleanDomain}&sz=64`;
  } catch {
    return '';
  }
};

// Favicon component with fallback chain
const FaviconIcon: React.FC<{ domain: string; className?: string }> = ({ domain, className = '' }) => {
  const [currentSrc, setCurrentSrc] = React.useState(getFaviconUrl(domain));
  const [fallbackUsed, setFallbackUsed] = React.useState(false);

  const handleError = () => {
    if (!fallbackUsed) {
      setFallbackUsed(true);
      setCurrentSrc(getGoogleFaviconUrl(domain));
    }
  };

  // Reset when domain changes
  React.useEffect(() => {
    setCurrentSrc(getFaviconUrl(domain));
    setFallbackUsed(false);
  }, [domain]);

  return (
    <div className={`w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center text-xs font-medium ${className}`}>
      {fallbackUsed ? (
        // Final fallback: letter monogram
        <span>{domain.charAt(0).toUpperCase()}</span>
      ) : (
        // Try favicon image
        <img
          src={currentSrc}
          alt={`${domain} icon`}
          className="w-6 h-6 rounded-full"
          onError={handleError}
          onLoad={() => {
            // Success - keep the image
          }}
        />
      )}
    </div>
  );
};

// Custom hook for application statistics
const useApplicationStats = (allEntries: Entry[]) => {
  return React.useMemo(() => {
    const totals = {
      total: allEntries.length,
      applied: 0,
      interviewing: 0,
      accepted: 0,
      rejected: 0,
      withdrawn: 0
    };

    const activity = {
      last7: 0,
      last30: 0,
      last90: 0
    };

    const sourceCounts: Record<string, number> = {};

    allEntries.forEach(entry => {
      // Count by status
      const status = normalizeStatus(entry.status);
      totals[status.toLowerCase() as keyof typeof totals]++;

      // Count by activity
      if (entry.date_applied) {
        if (isInLastDays(entry.date_applied, 7)) activity.last7++;
        if (isInLastDays(entry.date_applied, 30)) activity.last30++;
        if (isInLastDays(entry.date_applied, 90)) activity.last90++;
      }

      // Count by source
      if (entry.job_posting_url) {
        const domain = formatDomain(entry.job_posting_url);
        sourceCounts[domain] = (sourceCounts[domain] || 0) + 1;
      }
    });

    const topSources = Object.entries(sourceCounts)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      totals,
      funnel: totals, // Same data for funnel
      activity,
      topSources,
      loading: false
    };
  }, [allEntries]);
};

// Overview Tab Component
const OverviewTab: React.FC<{ allEntries: Entry[] }> = ({ allEntries }) => {
  const stats = useApplicationStats(allEntries);

  if (stats.totals.total === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Application Overview</h2>
        <div className="bg-gray-800 rounded-2xl p-6 text-center">
          <p className="text-gray-300">No applications yet—your first one will appear here.</p>
        </div>
      </div>
    );
  }

  const totalCount = stats.totals.total;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Application Overview</h2>
      
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card title="Total" value={stats.totals.total.toString()} />
        <Card title="Applied" value={stats.totals.applied.toString()} />
        <Card title="Interviewing" value={stats.totals.interviewing.toString()} />
        <Card title="Accepted" value={stats.totals.accepted.toString()} />
        <Card title="Rejected" value={stats.totals.rejected.toString()} />
        <Card title="Withdrawn" value={stats.totals.withdrawn.toString()} />
      </div>

      {/* Funnel Visualization */}
      <div className="bg-gray-800 rounded-2xl p-6">
        <h3 className="text-lg font-semibold mb-4">Application Funnel</h3>
        <div className="space-y-3">
          {/* Applied → Interviewing → Accepted */}
          <div className="flex flex-col sm:flex-row sm:items-center space-y-1 sm:space-y-0 sm:space-x-4" aria-label={`Applied: ${stats.totals.applied}`}>
            <div className="w-20 text-sm text-gray-400">Applied</div>
            <div className="flex-1 bg-gray-700 rounded-full h-4">
              <div 
                className="bg-blue-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${totalCount > 0 ? (stats.totals.applied / totalCount) * 100 : 0}%` }}
              />
            </div>
            <div className="w-12 text-right sm:text-right text-sm font-medium text-gray-200">
              {stats.totals.applied}
            </div>
          </div>
          
          <div className="flex flex-col sm:flex-row sm:items-center space-y-1 sm:space-y-0 sm:space-x-4" aria-label={`Interviewing: ${stats.totals.interviewing}`}>
            <div className="w-20 text-sm text-gray-400">Interviewing</div>
            <div className="flex-1 bg-gray-700 rounded-full h-4">
              <div 
                className="bg-yellow-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${totalCount > 0 ? (stats.totals.interviewing / totalCount) * 100 : 0}%` }}
              />
            </div>
            <div className="w-12 text-right text-sm font-medium text-gray-200">
              {stats.totals.interviewing}
            </div>
          </div>
          
          <div className="flex flex-col sm:flex-row sm:items-center space-y-1 sm:space-y-0 sm:space-x-4" aria-label={`Accepted: ${stats.totals.accepted}`}>
            <div className="w-20 text-sm text-gray-400">Accepted</div>
            <div className="flex-1 bg-gray-700 rounded-full h-4">
              <div 
                className="bg-green-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${totalCount > 0 ? (stats.totals.accepted / totalCount) * 100 : 0}%` }}
              />
            </div>
            <div className="w-12 text-right text-sm font-medium text-gray-200">
              {stats.totals.accepted}
            </div>
          </div>
          
          {/* Terminal states */}
          <div className="flex flex-col sm:flex-row sm:items-center space-y-1 sm:space-y-0 sm:space-x-4" aria-label={`Rejected: ${stats.totals.rejected}`}>
            <div className="w-20 text-sm text-gray-400">Rejected</div>
            <div className="flex-1 bg-gray-700 rounded-full h-4">
              <div 
                className="bg-red-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${totalCount > 0 ? (stats.totals.rejected / totalCount) * 100 : 0}%` }}
              />
            </div>
            <div className="w-12 text-right text-sm font-medium text-gray-200">
              {stats.totals.rejected}
            </div>
          </div>
          
          <div className="flex flex-col sm:flex-row sm:items-center space-y-1 sm:space-y-0 sm:space-x-4" aria-label={`Withdrawn: ${stats.totals.withdrawn}`}>
            <div className="w-20 text-sm text-gray-400">Withdrawn</div>
            <div className="flex-1 bg-gray-700 rounded-full h-4">
              <div 
                className="bg-gray-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${totalCount > 0 ? (stats.totals.withdrawn / totalCount) * 100 : 0}%` }}
              />
            </div>
            <div className="w-12 text-right text-sm font-medium text-gray-200">
              {stats.totals.withdrawn}
            </div>
          </div>
        </div>
      </div>

      {/* Activity and Top Sources */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity Cards */}
        <div className="bg-gray-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold mb-4">Recent Activity</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Last 7 days */}
            <section 
              role="group" 
              aria-label={`Recent activity: last 7 days ${stats.activity.last7}`}
              className="relative rounded-2xl p-4 sm:p-5 shadow-sm border border-white/5 bg-white/5 hover:bg-white/10 hover:border-white/10 transition-all duration-200 cursor-default focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-opacity-50"
              tabIndex={0}
            >
              <div className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                7d
              </div>
              <div className="text-3xl sm:text-4xl font-semibold text-white mb-1">
                {stats.activity.last7}
              </div>
              <div className="text-sm text-white/70">
                Last 7 days
              </div>
            </section>

            {/* Last 30 days */}
            <section 
              role="group" 
              aria-label={`Recent activity: last 30 days ${stats.activity.last30}`}
              className="relative rounded-2xl p-4 sm:p-5 shadow-sm border border-white/5 bg-white/5 hover:bg-white/10 hover:border-white/10 transition-all duration-200 cursor-default focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-opacity-50"
              tabIndex={0}
            >
              <div className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                30d
              </div>
              <div className="text-3xl sm:text-4xl font-semibold text-white mb-1">
                {stats.activity.last30}
              </div>
              <div className="text-sm text-white/70">
                Last 30 days
              </div>
            </section>

            {/* Last 90 days */}
            <section 
              role="group" 
              aria-label={`Recent activity: last 90 days ${stats.activity.last90}`}
              className="relative rounded-2xl p-4 sm:p-5 shadow-sm border border-white/5 bg-white/5 hover:bg-white/10 hover:border-white/10 transition-all duration-200 cursor-default focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-opacity-50"
              tabIndex={0}
            >
              <div className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                90d
              </div>
              <div className="text-3xl sm:text-4xl font-semibold text-white mb-1">
                {stats.activity.last90}
              </div>
              <div className="text-sm text-white/70">
                Last 90 days
              </div>
            </section>
          </div>
        </div>

        {/* Top Sources */}
        <div className="bg-gray-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold mb-4">Top Sources</h3>
          {stats.topSources.length > 0 ? (
            <div className="space-y-2">
              {stats.topSources.map((source, index) => (
                <div key={source.domain} className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <FaviconIcon domain={source.domain} />
                    <span className="text-sm">{source.domain}</span>
                  </div>
                  <span className="text-sm text-gray-400">{source.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm">No source data available</p>
          )}
        </div>
      </div>
    </div>
  );
};

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

  // Load all entries when dashboard or overview tab is active
  React.useEffect(() => {
    if (activeTab === 'dashboard' || activeTab === 'overview') {
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
    
    // Optimistic UI: Remove from UI immediately
    const currentList = [...allEntries];
    const filtered = currentList.filter((e) => (e.record_id || '') !== (rec.record_id || ''));
    setAllEntries(filtered);
    setStatus('Entry deleted successfully');
    setTimeout(() => setStatus(null), 2000);
    
    // Do background deletion
    chrome.runtime.sendMessage({ type: 'delete-record', recordId: rec.record_id }, (res) => {
      if (!res?.ok) {
        // If deletion failed, restore the entry
        setAllEntries(currentList);
        setStatus('Delete failed — entry restored');
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


  // Filter and sort entries - use same logic as popup
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

    // Apply sorting based on sortBy option
    if (sortBy === 'newest') {
      // Newest first: reverse the array (same as popup logic)
      filtered = filtered.reverse();
    } else if (sortBy === 'oldest') {
      // Oldest first: keep original order (bottom to top from sheet = oldest to newest)
      // No change needed - filtered is already in oldest to newest order
    }

    return filtered;
  }, [allEntries, statusFilter, searchQuery, sortBy]);

  const STATUS_OPTIONS = ['Applied', 'Interviewing', 'Accepted', 'Rejected', 'Withdrawn'];

  if (!settings) return <div className="p-6">Loading…</div>;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'dashboard', label: 'Captures' },
    { id: 'settings', label: 'Settings' }
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

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <OverviewTab allEntries={allEntries} />
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
                    className="sl-select w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    className="sl-select w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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


        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold">Settings</h2>
            
            <div className="bg-gray-800 rounded-lg p-6 space-y-6">
              {/* Google Sheet Configuration */}
              <div className="space-y-4">
                <label className="block text-sm font-medium">Google Sheet Configuration</label>
                
                {settings.sheetId ? (
                  // Show current sheet info
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 bg-green-900/20 border border-green-700/50 rounded-md">
                      <div className="flex items-center space-x-3">
                        <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                        <div>
                          <div className="text-sm font-medium text-green-200">Sheet Connected</div>
                          <div className="text-xs text-green-300/70">ID: {settings.sheetId}</div>
                        </div>
                      </div>
                      <button
                        onClick={openGoogleSheet}
                        className="px-3 py-1 text-xs bg-green-700 text-green-100 rounded hover:bg-green-600 transition-colors"
                      >
                        Open Sheet
                      </button>
                    </div>
                    
                    <div className="flex space-x-2">
                      <input
                        value={settings.sheetId}
                        onChange={(e) => setSettings({ ...settings, sheetId: e.target.value })}
                        className="flex-1 bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        placeholder="Enter different sheet ID..."
                      />
                      <button
                        onClick={() => setSettings({ ...settings, sheetId: '' })}
                        className="px-3 py-2 text-sm bg-gray-600 text-gray-200 rounded hover:bg-gray-500 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : (
                  // Show create new sheet option
                  <div className="space-y-3">
                    <div className="p-4 bg-blue-900/20 border border-blue-700/50 rounded-md">
                      <div className="flex items-start space-x-3">
                        <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-medium text-blue-200 mb-1">Create New Google Sheet</h3>
                          <p className="text-xs text-blue-300/70 mb-3">
                            We'll automatically create a new Google Sheet with the proper headers and formatting for your job applications.
                          </p>
                          <button
                            onClick={async () => {
                              setStatus('Creating new Google Sheet...');
                              chrome.runtime.sendMessage({ type: 'create-sheet' }, (res) => {
                                if (res?.ok) {
                                  setSettings({ ...settings, sheetId: res.sheetId });
                                  setStatus('Google Sheet created successfully!');
                                  setTimeout(() => setStatus(null), 3000);
                                } else {
                                  setStatus(`Failed to create sheet: ${res?.error || 'Unknown error'}`);
                                  setTimeout(() => setStatus(null), 5000);
                                }
                              });
                            }}
                            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm font-medium"
                          >
                            Create New Sheet
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-600"></div>
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-2 bg-gray-800 text-gray-400">or</span>
                      </div>
                    </div>
                    
      <div className="space-y-2">
                      <label className="block text-xs font-medium text-gray-400">Use Existing Sheet</label>
                      <input
                        value={settings.sheetId}
                        onChange={(e) => setSettings({ ...settings, sheetId: e.target.value })}
                        className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        placeholder="Enter Google Sheet ID..."
                      />
                      <p className="text-xs text-gray-400">The ID from `https://docs.google.com/spreadsheets/d/ID/edit`</p>
                    </div>
                  </div>
                )}
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

      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


