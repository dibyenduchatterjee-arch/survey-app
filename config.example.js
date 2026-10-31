// Copy this file to config.js and fill it in. config.js is read by googleauth.js.
//
// Nothing here is a secret. The OAuth client id identifies the app to Google and is
// visible to anyone who opens it. Do NOT add a client secret or refresh token
// (the Picker key below is restricted and harmless) anywhere in the app: every user signs in as himself.
//
// Created in Google Cloud Console (see the task report for the exact steps).
export const config = {
  googleClientId: 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com',
  // Browser API key for the Google Picker only. Restrict it in Cloud Console to this site's
  // address and to the Picker API; it cannot read or write anyone's data.
  googleApiKey: 'PASTE-THE-RESTRICTED-BROWSER-API-KEY',
  // Cloud project number (Project info on the Cloud Console dashboard).
  googleAppId: 'PASTE-THE-PROJECT-NUMBER',
};
