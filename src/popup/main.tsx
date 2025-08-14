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
};

function App() {
  const [recent, setRecent] = React.useState<Entry[]>([]);
  const [sheetId, setSheetId] = React.useState('');

  React.useEffect(() => {
    chrome.runtime.sendMessage({ type: 'get-recent' }, (res) => {
      if (res?.ok) setRecent(res.recent || []);
    });
    chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
      if (res?.ok) setSheetId(res.settings?.sheetId || '');
    });
  }, []);

  const openOptions = () => chrome.runtime.openOptionsPage();
  const openSheet = () => {
    if (!sheetId) return openOptions();
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    chrome.tabs.create({ url });
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

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Job Tracker</h1>
        <button onClick={openOptions} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600">Options</button>
      </div>
      <button onClick={openSheet} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded text-sm">View Your Job Log</button>
      <div>
        <h2 className="text-sm text-gray-300 mb-2">Last 10 captured</h2>
        <div className="space-y-2 max-h-80 overflow-auto pr-1">
          {recent.length === 0 && <div className="text-xs text-gray-400">No entries yet</div>}
          {recent.map((e, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded bg-gray-800 hover:bg-gray-700">
              <a href={e.job_posting_url} target="_blank" rel="noreferrer" className="flex-1">
              <div className="text-sm font-medium line-clamp-1">{e.job_title}</div>
              <div className="text-xs text-gray-300 line-clamp-1">{e.company} • {e.location}</div>
              <div className="text-[10px] text-gray-400">{e.date_applied}</div>
              </a>
              <button title="Delete" onClick={() => deleteEntry(e, i)} className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500">✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


