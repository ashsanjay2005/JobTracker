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
            <a key={i} href={e.job_posting_url} target="_blank" rel="noreferrer" className="block p-2 rounded bg-gray-800 hover:bg-gray-700">
              <div className="text-sm font-medium line-clamp-1">{e.job_title}</div>
              <div className="text-xs text-gray-300 line-clamp-1">{e.company} • {e.location}</div>
              <div className="text-[10px] text-gray-400">{e.date_applied}</div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


