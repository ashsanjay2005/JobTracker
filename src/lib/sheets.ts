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

let AUTH_IN_FLIGHT: Promise<string> | null = null;

export async function ensureAuthToken(interactive = true): Promise<string> {
  const existing = await getToken();
  if (existing) return existing.accessToken;
  if (AUTH_IN_FLIGHT) return AUTH_IN_FLIGHT;
  AUTH_IN_FLIGHT = (async () => {
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
  })();
  try {
    return await AUTH_IN_FLIGHT;
  } finally {
    AUTH_IN_FLIGHT = null;
  }
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

// Final, user-specified header order and labels (no underscores)
const DEFAULT_HEADER = [
  'Job Title',
  'Date Applied',
  'Company',
  'Location',
  'Date Posted',
  'Job Timeline',
  'Cover Letter',
  'Status',
  'Record ID'
];
const STATUS_OPTIONS = ['Applied', 'Interviewing', 'Accepted', 'Rejected', 'Withdrawn'];
const COVER_OPTIONS = ['Not set', 'Yes', 'No'];

export async function ensureHeaderRow(sheetId: string, sheetName = 'Sheet1'): Promise<void> {
  const header = [...DEFAULT_HEADER];
  // Overwrite header row with the exact required labels and order
  await sheetsFetch(`spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!A1`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ range: `${sheetName}!A1`, values: [header] })
  });
  // Remove duplicate older columns for these labels if they exist to the right
  await removeDuplicateColumnsByLabels(sheetId, sheetName, ['Cover Letter', 'Status']);
  // Styling, dropdowns, and conditional formatting
  await applyHeaderStyling(sheetId, sheetName, header);
  await applyDataValidationAndFormatting(sheetId, sheetName, header);
}

async function getSheetGridId(sheetId: string, sheetName: string): Promise<number> {
  const res = await sheetsFetch(`spreadsheets/${sheetId}?fields=sheets(properties(sheetId,title))`, { method: 'GET' });
  if (!res.ok) throw new Error('Failed to fetch spreadsheet metadata');
  const data = await res.json();
  const sheet = (data.sheets || []).find((s: any) => s.properties?.title === sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  return sheet.properties.sheetId as number;
}

async function applyDataValidationAndFormatting(sheetId: string, sheetName: string, header: string[]): Promise<void> {
  try {
    const gridId = await getSheetGridId(sheetId, sheetName);
    const coverIdx = header.indexOf('Cover Letter');
    const statusIdx = header.indexOf('Status');
    if (coverIdx === -1 && statusIdx === -1) return;
    const maxRows = 5000;
    const requests: any[] = [];
    const buildRange = (colIdx: number) => ({
      sheetId: gridId,
      startRowIndex: 1,
      endRowIndex: maxRows,
      startColumnIndex: colIdx,
      endColumnIndex: colIdx + 1
    });
    if (coverIdx !== -1) {
      requests.push({
        setDataValidation: {
          range: buildRange(coverIdx),
          rule: {
            condition: { type: 'ONE_OF_LIST', values: COVER_OPTIONS.map((v) => ({ userEnteredValue: v })) },
            strict: true,
            showCustomUi: true
          }
        }
      });
    }
    if (statusIdx !== -1) {
      requests.push({
        setDataValidation: {
          range: buildRange(statusIdx),
          rule: {
            condition: { type: 'ONE_OF_LIST', values: STATUS_OPTIONS.map((v) => ({ userEnteredValue: v })) },
            strict: true,
            showCustomUi: true
          }
        }
      });
      const colors: Record<string, { bg: { red: number; green: number; blue: number }; whiteText?: boolean }> = {
        'Applied': { bg: { red: 0.85, green: 0.85, blue: 0.85 } },
        'Interviewing': { bg: { red: 1.0, green: 0.95, blue: 0.6 } },
        'Accepted': { bg: { red: 0.75, green: 0.93, blue: 0.76 } },
        'Rejected': { bg: { red: 0.97, green: 0.73, blue: 0.73 } },
        'Withdrawn': { bg: { red: 0, green: 0, blue: 0 }, whiteText: true }
      };
      for (const key of Object.keys(colors)) {
        const c = colors[key];
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [buildRange(statusIdx)],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: key }] },
                format: {
                  backgroundColor: c.bg,
                  textFormat: c.whiteText ? { foregroundColor: { red: 1, green: 1, blue: 1 } } : undefined
                }
              }
            },
            index: 0
          }
        });
      }
    }
    if (requests.length > 0) {
      await sheetsFetch(`spreadsheets/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    }
  } catch (e) {
    console.warn('Failed to apply validation/formatting:', e);
  }
}

async function applyHeaderStyling(sheetId: string, sheetName: string, header: string[]): Promise<void> {
  const gridId = await getSheetGridId(sheetId, sheetName);
  const requests: any[] = [];
  // Bold header row
  requests.push({
    repeatCell: {
      range: { sheetId: gridId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: header.length },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold'
    }
  });
  // Freeze header row
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: gridId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });
  // Column widths (moderate widths matching screenshot style)
  const widths = [320, 140, 220, 220, 140, 180, 120, 140, 160];
  for (let i = 0; i < header.length && i < widths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: gridId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: widths[i] },
        fields: 'pixelSize'
      }
    });
  }
  if (requests.length) {
    await sheetsFetch(`spreadsheets/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
}

async function getHeaderValues(sheetId: string, sheetName: string): Promise<string[]> {
  const range = encodeURIComponent(`${sheetName}!1:1`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`, { method: 'GET' });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.values?.[0] || []).map((v: any) => String(v).trim());
}

async function removeDuplicateColumnsByLabels(sheetId: string, sheetName: string, labels: string[]): Promise<void> {
  const header = await getHeaderValues(sheetId, sheetName);
  if (header.length === 0) return;
  const gridId = await getSheetGridId(sheetId, sheetName);
  const toDelete: number[] = [];
  for (const label of labels) {
    const matches: number[] = [];
    for (let i = 0; i < header.length; i++) {
      if ((header[i] || '').toLowerCase() === label.toLowerCase()) matches.push(i);
    }
    if (matches.length > 1) {
      // Keep the left-most occurrence, delete others
      const keep = matches[0];
      for (const idx of matches.slice(1)) toDelete.push(idx);
    }
  }
  if (toDelete.length === 0) return;
  // Delete from right-most to left-most so indices remain valid
  toDelete.sort((a, b) => b - a);
  const requests = toDelete.map((colIdx) => ({
    deleteDimension: {
      range: { sheetId: gridId, dimension: 'COLUMNS', startIndex: colIdx, endIndex: colIdx + 1 }
    }
  }));
  await sheetsFetch(`spreadsheets/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
}

// Format a date as e.g., "Aug 14th 2025" to match other displayed dates
function formatCalendarDate(d: Date): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short' };
  const mon = new Intl.DateTimeFormat('en-US', options).format(d);
  const day = d.getDate();
  const year = d.getFullYear();
  const suffix = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `${mon} ${day}${suffix(day)} ${year}`;
}

// Convert relative text like "2 days ago" to a calendar date string using local time
function relativeTextToDateString(relative: string): string {
  if (!relative) return '';
  const t = relative.trim().toLowerCase();
  const now = new Date();
  if (/^(just\s*now|\d+\s*minute|\d+\s*hour)/i.test(t)) {
    return formatCalendarDate(now);
  }
  // Accept optional leading words like "reposted"
  const m = t.match(/(\d+)\s*(day|week|month|year)s?\s*ago/);
  if (!m) return '';
  const qty = parseInt(m[1], 10);
  const unit = m[2];
  let days = 0;
  switch (unit) {
    case 'day': days = qty; break;
    case 'week': days = qty * 7; break;
    case 'month': days = qty * 30; break;
    case 'year': days = qty * 365; break;
  }
  const d = new Date(now);
  d.setDate(now.getDate() - days);
  return formatCalendarDate(d);
}

export async function appendRow(sheetId: string, entry: CaptureEntry, sheetName = 'Sheet1'): Promise<void> {
  const postedRelative = (entry.posted_relative || entry.listing_posted_date || '').trim();
  const postedDate = relativeTextToDateString(postedRelative);

  // Use a HYPERLINK formula so the job title cell is clickable to the posting
  const titleText = entry.job_title || '';
  const safeTitle = titleText.replace(/"/g, '""');
  const hyperlinkTitle = entry.job_posting_url
    ? `=HYPERLINK("${entry.job_posting_url}","${safeTitle}")`
    : safeTitle;

  // Fetch header to know if extra columns exist; build row in that order
  const hdrRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!1:1`)}?majorDimension=ROWS`, { method: 'GET' });
  let header: string[] = [];
  if (hdrRes.status === 200) {
    const data = await hdrRes.json();
    header = (data.values?.[0] || []).map((v: any) => String(v));
  }
  if (header.length === 0) header = [...DEFAULT_HEADER];

  const rowMap: Record<string, string> = {
    'Job Title': hyperlinkTitle,
    'Date Applied': entry.date_applied,
    'Company': entry.company,
    'Location': entry.location ?? '',
    'Date Posted': postedDate,
    'Job Timeline': entry.job_timeline,
    'Cover Letter': 'Not set',
    'Status': 'Applied',
    'Record ID': entry.record_id || ''
  };
  const values = [[...header.map((h) => rowMap[h] ?? '')]];

  // Debug log
  console.log("Appending row to Sheets:", values, "from entry:", entry);

  // Determine range width dynamically
  const endCol = toA1Col(header.length);
  const range = encodeURIComponent(`${sheetName}!A1:${endCol}1`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    body: JSON.stringify({ values })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${txt}`);
  }
}

// Convert column index (1-based) to A1 letter(s)
function toA1Col(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function deleteRowByRecordId(sheetId: string, recordId: string, sheetName = 'Sheet1'): Promise<void> {
  if (!recordId) throw new Error('Missing recordId');
  // Ensure header has Record ID, but do NOT reorder others.
  await ensureHeaderRow(sheetId, sheetName);
  // Find header and record id column index
  const hdrRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!1:1`)}?majorDimension=ROWS`, { method: 'GET' });
  const hdrJson = await hdrRes.json();
  const header: string[] = (hdrJson?.values?.[0] || []).map((v: any) => String(v));
  const idx = header.indexOf('Record ID');
  if (idx === -1) throw new Error('Record ID column missing');
  console.log('delete: searching column index', idx);
  const startCol = toA1Col(idx + 1);
  const range = encodeURIComponent(`${sheetName}!${startCol}2:${startCol}20000`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=COLUMNS`, { method: 'GET' });
  const data = await res.json();
  const col: string[] = (data.values?.[0] || []).map((v: any) => String(v));
  // Find the row number (offset + 2)
  let rowIndex = -1;
  for (let i = 0; i < col.length; i++) {
    if (col[i] === recordId) { rowIndex = i + 2; break; }
  }
  if (rowIndex === -1) throw new Error('Row not found');
  console.log('delete: found row', rowIndex);
  // Delete the row via batchUpdate
  const gridId = await getSheetGridId(sheetId, sheetName);
  await sheetsFetch(`spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: gridId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex }
        }
      }]
    })
  });
  console.log('delete: batchUpdate OK');
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


