# Job Tracker Chrome Extension

This extension helps you track job applications from LinkedIn, Workday, and Oracle/Taleo, appending them to a Google Sheet.

## Testing the OAuth Client ID changes

1.  Build and load the extension: `npm run build`
2.  Open the extension's options page and confirm the "Google OAuth Client ID" field is gone.
3.  Open the extension's popup.
4.  If you had previously saved a custom ID, verify it’s no longer used.
5.  Click the "Test connection" button on the options page and confirm that the OAuth flow still works as expected.