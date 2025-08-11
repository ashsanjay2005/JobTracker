import React from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';

type Settings = {
  sheetId: string;
  enableLinkedIn: boolean;
  enableWorkday: boolean;
  enableOracleTaleo: boolean;
  enableGeneric: boolean;
  showToast: boolean;
  oauthClientId?: string;
};

function App() {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
      if (res?.ok) setSettings(res.settings);
    });
  }, []);

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
      setStatus(res?.ok ? 'Connection OK' : `Failed: ${res?.error || 'unknown'}`);
      setTimeout(() => setStatus(null), 2500);
    });
  };

  if (!settings) return <div className="p-6">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Job Tracker Settings</h1>
      {status && <div className="text-sm text-emerald-700">{status}</div>}
      <div className="space-y-2">
        <label className="block text-sm font-medium">Google Sheet ID</label>
        <input value={settings.sheetId} onChange={(e) => setSettings({ ...settings, sheetId: e.target.value })} className="w-full border rounded px-3 py-2" placeholder="1abcDEF..." />
        <p className="text-xs text-gray-600">The ID in `https://docs.google.com/spreadsheets/d/ID/edit`</p>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">Google OAuth Client ID (optional)</label>
        <input value={settings.oauthClientId || ''} onChange={(e) => setSettings({ ...settings, oauthClientId: e.target.value })} className="w-full border rounded px-3 py-2" placeholder="1234567890-abcdef.apps.googleusercontent.com" />
        <p className="text-xs text-gray-600">If empty, uses the `oauth2.client_id` in `manifest.json`.</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex items-center space-x-2"><input type="checkbox" checked={settings.enableLinkedIn} onChange={(e) => setSettings({ ...settings, enableLinkedIn: e.target.checked })} /><span>LinkedIn</span></label>
        <label className="flex items-center space-x-2"><input type="checkbox" checked={settings.enableWorkday} onChange={(e) => setSettings({ ...settings, enableWorkday: e.target.checked })} /><span>Workday</span></label>
        <label className="flex items-center space-x-2"><input type="checkbox" checked={settings.enableOracleTaleo} onChange={(e) => setSettings({ ...settings, enableOracleTaleo: e.target.checked })} /><span>Oracle-Taleo</span></label>
        <label className="flex items-center space-x-2"><input type="checkbox" checked={settings.enableGeneric} onChange={(e) => setSettings({ ...settings, enableGeneric: e.target.checked })} /><span>Any site (generic)</span></label>
        <label className="flex items-center space-x-2"><input type="checkbox" checked={settings.showToast} onChange={(e) => setSettings({ ...settings, showToast: e.target.checked })} /><span>Show success toast</span></label>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="px-4 py-2 bg-gray-900 text-white rounded disabled:opacity-50">Save</button>
        <button onClick={testConnection} disabled={testing} className="px-4 py-2 bg-emerald-600 text-white rounded disabled:opacity-50">Test connection</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);


