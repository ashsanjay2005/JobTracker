import { CaptureEntry, getSettings } from './storage';

// Use OAuth v2 endpoint
const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

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
    // Prefer ID from Options → settings.oauthClientId; fallback to manifest oauth2.client_id
    const settingsWrap = await chrome.storage.sync.get(['settings']);
    const settings = settingsWrap?.settings || {};
    const manifest = chrome.runtime.getManifest();
    const clientId = (settings.oauthClientId || (manifest as any).oauth2?.client_id || '').trim();
    if (!clientId) throw new Error('Missing Google OAuth Client ID. Set it in Options.');

    const redirectUri = chrome.identity.getRedirectURL('oauth2');
    try {
      console.debug('[JT][Auth] Using redirect_uri:', redirectUri, 'extId:', chrome.runtime.id);
      console.debug('[JT][Auth] Using client_id:', clientId);
    } catch {}

    const authUrl = new URL(GOOGLE_AUTH_BASE);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/spreadsheets');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    try { console.debug('[JT][Auth] Auth URL:', authUrl.toString()); } catch {}

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

export async function createNewSpreadsheet(): Promise<string> {
  const token = await ensureAuthToken();
  const title = `Job Tracker - ${new Date().toLocaleDateString()}`;
  
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title: title,
      },
      sheets: [{
        properties: {
          title: 'Sheet1',
          gridProperties: {
            rowCount: 1000,
            columnCount: 10,
          },
        },
      }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create spreadsheet: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const sheetId = data.spreadsheetId;
  
  // Set up the header row and formatting
  await setupNewSpreadsheet(sheetId);
  
  return sheetId;
}

async function setupNewSpreadsheet(sheetId: string): Promise<void> {
  const token = await ensureAuthToken();
  
  // Add header row
  const headerValues = [
    ['Job Title', 'Date Applied', 'Company', 'Location', 'Date Posted', 'Job Timeline', 'Cover Letter', 'Status', 'Record ID']
  ];
  
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:I1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      values: headerValues,
    }),
  });

  // Format header row (bold, freeze, etc.)
  const formatRequests = [
    {
      repeatCell: {
        range: {
          sheetId: 0,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 9,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 200 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 1,
          endIndex: 2,
        },
        properties: { pixelSize: 120 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 2,
          endIndex: 3,
        },
        properties: { pixelSize: 150 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 3,
          endIndex: 4,
        },
        properties: { pixelSize: 120 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 4,
          endIndex: 5,
        },
        properties: { pixelSize: 100 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 5,
          endIndex: 6,
        },
        properties: { pixelSize: 120 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 6,
          endIndex: 7,
        },
        properties: { pixelSize: 100 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 7,
          endIndex: 8,
        },
        properties: { pixelSize: 100 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: 0,
          dimension: 'COLUMNS',
          startIndex: 8,
          endIndex: 9,
        },
        properties: { pixelSize: 120 },
        fields: 'pixelSize',
      },
    },
  ];

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: formatRequests,
    }),
  });
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

// --- Editable sync helpers ---

export async function findRowByRecordId(recordId: string, sheetName = 'Sheet1'): Promise<number | null> {
  const hdrRes = await sheetsFetch(`spreadsheets/${await getSpreadsheetId()}` as any, { method: 'GET' });
  return readRowIndex(recordId, sheetName);
}

async function getSpreadsheetId(): Promise<string> {
  // This function exists only to make TS happy when composing URLs dynamically elsewhere.
  // Callers always pass sheetId directly to other helpers; we won't use this in practice.
  throw new Error('getSpreadsheetId should not be called');
}

async function readHeader(sheetId: string, sheetName: string): Promise<string[]> {
  const range = encodeURIComponent(`${sheetName}!1:1`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`, { method: 'GET' });
  const json = await res.json();
  return (json?.values?.[0] || []).map((v: any) => String(v));
}

async function readRowIndex(recordId: string, sheetName = 'Sheet1'): Promise<number | null> {
  // Note: we need sheetId; callers should use findRowByRecordId on background where sheetId is known.
  return null;
}

export async function readAllRows(sheetId?: string, sheetName = 'Sheet1'): Promise<{ version: string; rows: CaptureEntry[] }> {
  if (!sheetId) throw new Error('sheetId required');
  const header = await readHeader(sheetId, sheetName);
  const endCol = toA1Col(header.length);
  const range = encodeURIComponent(`${sheetName}!A2:${endCol}`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`, { method: 'GET' });
  const etag = (res.headers as any).get?.('ETag') || '';
  const json = await res.json();
  const values: any[][] = json.values || [];
  const rows: CaptureEntry[] = values.map((row) => mapRowToEntry(header, row));
  const version = etag || shaVersion(values);
  return { version, rows };
}

export async function readRowByRecordId(sheetId: string, recordId: string, sheetName = 'Sheet1'): Promise<{ version: string; row: CaptureEntry } | null> {
  const header = await readHeader(sheetId, sheetName);
  const idx = header.indexOf('Record ID');
  if (idx === -1) return null;
  const col = toA1Col(idx + 1);
  const range = encodeURIComponent(`${sheetName}!${col}2:${col}20000`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=COLUMNS`, { method: 'GET' });
  const json = await res.json();
  const list: string[] = (json?.values?.[0] || []).map((v: any) => String(v));
  let rowIndex = -1;
  for (let i = 0; i < list.length; i++) if (list[i] === recordId) { rowIndex = i + 2; break; }
  if (rowIndex === -1) return null;
  const endCol = toA1Col(header.length);
  const rowRange = encodeURIComponent(`${sheetName}!A${rowIndex}:${endCol}${rowIndex}`);
  const res2 = await sheetsFetch(`spreadsheets/${sheetId}/values/${rowRange}?majorDimension=ROWS`, { method: 'GET' });
  const etag = (res2.headers as any).get?.('ETag') || '';
  const json2 = await res2.json();
  const rowVals: any[] = (json2?.values?.[0] || []);
  const row = mapRowToEntry(header, rowVals);
  const version = etag || shaVersion([rowVals]);
  return { version, row };
}

export async function getRawSheetData(sheetId: string, sheetName = 'Sheet1'): Promise<{ header: string[]; rows: any[][] }> {
  if (!sheetId) throw new Error('sheetId required');
  const header = await readHeader(sheetId, sheetName);
  const endCol = toA1Col(header.length);
  const range = encodeURIComponent(`${sheetName}!A2:${endCol}`);
  
  // Get both rendered values and raw formulas
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, { method: 'GET' });
  const json = await res.json();
  const rows: any[][] = json.values || [];
  
  // Also get raw formulas for Job Title column to extract URLs
  const jobTitleCol = 'A';
  const jobTitleRange = encodeURIComponent(`${sheetName}!${jobTitleCol}2:${jobTitleCol}20000`);
  const formulaRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${jobTitleRange}?majorDimension=COLUMNS&valueRenderOption=FORMULA`, { method: 'GET' });
  const formulaJson = await formulaRes.json();
  const formulas: string[] = (formulaJson?.values?.[0] || []).map((v: any) => String(v));
  
  // Merge formulas into rows for Job Title column
  for (let i = 0; i < Math.min(rows.length, formulas.length); i++) {
    if (rows[i] && rows[i].length > 0) {
      rows[i][0] = formulas[i] || rows[i][0]; // Use formula if available, otherwise use rendered value
    }
  }
  
  return { header, rows };
}

function mapRowToEntry(header: string[], row: any[]): CaptureEntry {
  const get = (name: string) => row[header.indexOf(name)] || '';
  // Job Title may be a formula; Sheets returns the rendered value, which is fine for the popup.
  const entry: CaptureEntry = {
    date_applied: String(get('Date Applied') || ''),
    job_title: String(get('Job Title') || ''),
    company: String(get('Company') || ''),
    location: String(get('Location') || ''),
    job_posting_url: '',
    salary_text: '',
    listing_posted_date: String(get('Date Posted') || ''),
    job_timeline: String(get('Job Timeline') || ''),
    record_id: String(get('Record ID') || ''),
    cover_letter: String(get('Cover Letter') || ''),
    status: String(get('Status') || '')
  };
  return entry;
}

function shaVersion(values: any[][]): string {
  try {
    const s = JSON.stringify(values);
    let h = 0, i = 0, len = s.length;
    while (i < len) { h = (h << 5) - h + s.charCodeAt(i++) | 0; }
    return `v${h}`;
  } catch { return `v${Date.now()}`; }
}

export async function updateRowByRecordId(sheetId: string, recordId: string, patch: Partial<CaptureEntry>, sheetName = 'Sheet1'): Promise<{ version: string }> {
  const header = await readHeader(sheetId, sheetName);
  const idx = header.indexOf('Record ID');
  if (idx === -1) throw new Error('Record ID column missing');
  
  // find row by Record ID
  const col = toA1Col(idx + 1);
  const range = encodeURIComponent(`${sheetName}!${col}2:${col}20000`);
  const res = await sheetsFetch(`spreadsheets/${sheetId}/values/${range}?majorDimension=COLUMNS`, { method: 'GET' });
  const json = await res.json();
  const list: string[] = (json?.values?.[0] || []).map((v: any) => String(v));
  let rowIndex = -1;
  for (let i = 0; i < list.length; i++) if (list[i] === recordId) { rowIndex = i + 2; break; }
  
  // Fallback: try to find the row by title+company+applied when record ID is missing (older rows), then backfill the Record ID
  if (rowIndex === -1) {
    const endCol = toA1Col(header.length);
    const allRange = encodeURIComponent(`${sheetName}!A2:${endCol}`);
    const allRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${allRange}?majorDimension=ROWS`, { method: 'GET' });
    const allJson = await allRes.json();
    const rows: string[][] = allJson?.values || [];
    const idxTitle = header.indexOf('Job Title');
    const idxCompany = header.indexOf('Company');
    const idxApplied = header.indexOf('Date Applied');
    
    // Use cues from patch if present; otherwise leave empty so we cannot match incorrectly
    const wantTitle = (patch.job_title || '').trim();
    const wantCompany = (patch.company || '').trim();
    const wantApplied = (patch.date_applied || '').trim();
    
    if (wantTitle || wantCompany || wantApplied) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const t = (r[idxTitle] || '').trim();
        const c = (r[idxCompany] || '').trim();
        const a = (r[idxApplied] || '').trim();
        const okT = wantTitle ? (t === wantTitle) : true;
        const okC = wantCompany ? (c === wantCompany) : true;
        const okA = wantApplied ? (a === wantApplied) : true;
        if (okT && okC && okA) { rowIndex = i + 2; break; }
      }
      
      if (rowIndex !== -1) {
        // Backfill the Record ID cell for future updates
        const ridCell = encodeURIComponent(`${sheetName}!${col}${rowIndex}:${col}${rowIndex}`);
        await sheetsFetch(`spreadsheets/${sheetId}/values/${ridCell}?valueInputOption=RAW`, {
          method: 'PUT',
          body: JSON.stringify({ range: `${sheetName}!${col}${rowIndex}`, values: [[recordId]] })
        });
      }
    }
    
    if (rowIndex === -1) throw new Error(`Record ID not found: ${recordId}`);
  }

  // Build row values in header order
  const rowRange = encodeURIComponent(`${sheetName}!A${rowIndex}:${toA1Col(header.length)}${rowIndex}`);
  const currentRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${rowRange}?majorDimension=ROWS`, { method: 'GET' });
  const currentJson = await currentRes.json();
  const current: any[] = (currentJson?.values?.[0] || []);

  // Ensure the current array has the same length as the header
  while (current.length < header.length) {
    current.push('');
  }

  const get = (name: string) => current[header.indexOf(name)] || '';
  const set = (name: string, val: string) => { 
    const i = header.indexOf(name); 
    if (i >= 0) current[i] = val; 
  };

  // Apply patch
  if (patch.job_title !== undefined || patch.job_posting_url !== undefined) {
    const title = patch.job_title !== undefined ? patch.job_title : String(get('Job Title'));
    // Attempt to extract existing URL if the current cell is a HYPERLINK
    let existingUrl = '';
    try {
      const m = String(get('Job Title')).match(/HYPERLINK\("([^"]+)/);
      if (m && m[1]) existingUrl = m[1];
  } catch {}
    const url = patch.job_posting_url !== undefined ? patch.job_posting_url : existingUrl;
    const cell = url ? `=HYPERLINK("${url}","${(title || '').replace(/"/g, '""')}")` : title;
    set('Job Title', cell);
  }
  if (patch.date_applied !== undefined) set('Date Applied', patch.date_applied || '');
  if (patch.company !== undefined) set('Company', patch.company || '');
  if (patch.location !== undefined) set('Location', patch.location || '');
  if (patch.listing_posted_date !== undefined) set('Date Posted', patch.listing_posted_date || '');
  if (patch.job_timeline !== undefined) set('Job Timeline', patch.job_timeline || '');
  if (patch.cover_letter !== undefined) set('Cover Letter', patch.cover_letter || '');
  if (patch.status !== undefined) set('Status', patch.status || '');

  const updateRes = await sheetsFetch(`spreadsheets/${sheetId}/values/${rowRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ range: `${sheetName}!A${rowIndex}:${toA1Col(header.length)}${rowIndex}`, values: [current] })
  });
  
  if (!updateRes.ok) {
    const txt = await updateRes.text();
    throw new Error(`Sheets update failed: ${updateRes.status} ${txt}`);
  }
  
  const etag = (updateRes.headers as any).get?.('ETag') || '';
  const version = etag || shaVersion([current]);
  return { version };
}




