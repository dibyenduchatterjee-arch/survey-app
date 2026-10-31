// Copy this file to config.js and fill it in. config.js is read by googleauth.js.
//
// Nothing here is a secret. The OAuth client id identifies the app to Google and is
// visible to anyone who opens it. Do NOT add a client secret, API key or refresh token
// to this file or anywhere else in the app: every user signs in as himself.
//
// Created in Google Cloud Console (see the task report for the exact steps).
export const config = {
  googleClientId: 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com',
  // Must match an "Authorised redirect URI" on the OAuth client exactly.
  // Any page of this app served from that address works as the callback.
  redirectUri: 'https://YOUR-HOST/index.html',
  // The Drive folder that holds one sub-folder per project.
  rootFolderId: 'PASTE-THE-MAIN-FOLDER-ID',
};
