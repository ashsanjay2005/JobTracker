## Job Tracker (Chrome Extension - MV3)

Track job applications on LinkedIn, Workday, and Oracle/Taleo. Each application append is written to your Google Sheet.

### Features
- React (Vite + Tailwind) popup and options
- MV3 background service worker for Google Sheets writes
- Google OAuth via `chrome.identity.launchWebAuthFlow`
- Content scripts for LinkedIn, Workday, Oracle/Taleo
- De-dup with 48h TTL using sha256(job_url + company + title)

### Data Columns (exact order)
`date_applied`, `job_title`, `company`, `location`, `job_posting_url`, `salary_text`, `listing_posted_date`, `job_timeline`

### Setup
1. Install deps:
   ```bash
   npm install
   ```
2. Configure Google OAuth Client ID
   - Create an OAuth client in Google Cloud Console. For extensions, implicit flow works with `chrome.identity`.
   - Paste your Client ID in Options under “Google OAuth Client ID” or set `oauth2.client_id` in `manifest.json`.
3. Enter your Google Sheet ID in Options.

### Build
- Dev (watch build):
  ```bash
  npm run dev
  ```
- Production build:
  ```bash
  npm run build
  ```
- Package zip:
  ```bash
  npm run zip
  ```

Load in Chrome:
- Open `chrome://extensions` → enable Developer mode → Load unpacked → select the `dist` folder

### Usage
- On supported job pages, clicking Apply/Easy Apply/Submit/Next/Continue triggers capture and append.
- Popup shows last 10 captures and a “View Your Job Log” button.

### Permissions
- `identity`, `storage`, `scripting`, `activeTab`
- Host permissions for LinkedIn, Workday, Oracle/Taleo

### OAuth notes
- Token cached in `chrome.storage.local` with expiry. On 401, re-auth is triggered.
- Scope: `https://www.googleapis.com/auth/spreadsheets`

### Post-install checklist
- Open Options and paste your Google Sheet ID
- (Optional) Paste Google OAuth Client ID if not set in `manifest.json`
- Click “Test connection” to ensure header row is created
- Ensure toggles for LinkedIn/Workday/Oracle-Taleo are on

### Development entry points
- Popup: `src/popup/index.html`, `src/popup/main.tsx`
- Options: `src/options/index.html`, `src/options/main.tsx`
- Background: `src/background/index.ts` → `dist/background.js`
- Content: `src/content/*.ts` → `dist/content-*.js` (referenced by `manifest.json`)


