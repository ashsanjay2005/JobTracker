import { CaptureEntry, getSettings } from './storage';

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/auth';

type TokenBundle = {
  accessToken: string;
  expiry: number; // epoch ms
};

async function getToken(): Promise<TokenBundle | null> {
  const { token } = await chrome.storage.local.get(['token']);
  if (!token) return null;
  const now = Date.now();
  if (token.expiry && token.expiry > now + 60_000) {
    return token as TokenBundle;
  }
  return null;
}

async function saveToken(tb: TokenBundle) {
  await chrome.storage.local.set({ token: tb });
}

export async function ensureAuthToken(interactive = true): Promise<string> {
  const existing = await getToken();
  if (existing) return existing.accessToken;

  const clientId = await getOAuthClientId();
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  console.log('OAuth client_id in use:', clientId);
  console.log('Using redirect_uri:', redirectUri);
  const expected = `https://${chrome.runtime.id}.chromiumapp.org/oauth2`;
  if (redirectUri !== expected) {
    console.error('Redirect mismatch at runtime:', { redirectUri, expected });
    throw new Error('Redirect URI mismatch at runtime');
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    console.warn('Suspicious client_id (does not look like a Google OAuth client):', clientId);
  }

  const authUrl = new URL(GOOGLE_AUTH_BASE);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/spreadsheets');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  console.log('Auth URL:', authUrl.toString());

  const redirectResult = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive });
  const fragment = redirectResult.split('#')[1] || '';
  const fragParams = new URLSearchParams(fragment);
  const accessToken = fragParams.get('access_token');
  const expiresIn = Number(fragParams.get('expires_in') || '3600');
  if (!accessToken) throw new Error('Failed to obtain access token');
  const expiry = Date.now() + expiresIn * 1000;
  await saveToken({ accessToken, expiry });
  return accessToken;
}

async function sheetsFetch(path: string, init: RequestInit, retry = 2): Promise<Response> {
  let token = await ensureAuthToken(true);
  const resp = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (resp.status === 401 && retry > 0) {
    // invalidate token and retry once
    await chrome.storage.local.remove('token');
    token = await ensureAuthToken(true);
    return sheetsFetch(path, init, retry - 1);
  }
  return resp;
}

const HEADER = [
  'date_applied',
  'job_title',
  'company',
  'location',
  'job_posting_url',
  'salary_text',
  'listing_posted_date',
  'job_timeline'
];

export async function ensureHeaderRow(sheetId: string, sheetName = 'Sheet1'): Promise<void> {
  const range = encodeURIComponent(`${sheetName}!1:1`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`, { method: 'GET' });
  if (res.status === 200) {
    const data = await res.json();
    const values: any[] = data.values || [];
    const first = values[0] || [];
    const matches = HEADER.join('|') === (first || []).join('|');
    if (matches) return;
  }
  // overwrite header row
  await sheetsFetch(`spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!A1`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ range: `${sheetName}!A1`, values: [HEADER] })
  });
}

export async function appendRow(sheetId: string, entry: CaptureEntry, sheetName = 'Sheet1'): Promise<void> {
  const values = [[
    entry.date_applied,
    entry.job_title,
    entry.company,
    entry.location,
    entry.job_posting_url,
    entry.salary_text,
    entry.listing_posted_date,
    entry.job_timeline
  ]];
  const range = encodeURIComponent(`${sheetName}!A1:H1`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    body: JSON.stringify({ values })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${txt}`);
  }
}

// Helper: get OAuth Client ID from storage or manifest
export async function getOAuthClientId(): Promise<string> {
  // 1) From saved settings (Options page stores under `settings`)
  try {
    const settings = await getSettings();
    if (settings?.oauthClientId && settings.oauthClientId.trim()) {
      return settings.oauthClientId.trim();
    }
  } catch {}
  // 2) Legacy: top-level key (if any)
  const fromStorage = await new Promise<string | undefined>((resolve) => {
    chrome.storage.sync.get(['oauthClientId'], (res) => resolve((res as any)?.oauthClientId));
  });
  if (fromStorage && fromStorage.trim()) return fromStorage.trim();
  // 3) Manifest fallback
  const manifest = chrome.runtime.getManifest() as any;
  const fromManifest = manifest?.oauth2?.client_id;
  return (fromManifest || '').trim();
}


