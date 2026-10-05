/**
 * Google Photos Picker configuration (public values only — never put a
 * client secret in a static app; the token flow doesn't use one).
 *
 *   PUBLIC_GOOGLE_CLIENT_ID   OAuth 2.0 "Web application" client id.
 *   PUBLIC_GOOGLE_MEDIA_FETCH How picked photo bytes are downloaded:
 *       'header' (default, documented): Authorization: Bearer header.
 *       'query': ?access_token= on the media URL (avoids a CORS preflight).
 *     Pick whichever the spike (spike/google-picker.html) shows works.
 */
export const GOOGLE_CLIENT_ID: string = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID ?? '';

/** The only scope we request: read access to items the user picks in a Picker session. */
export const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

export type MediaFetchMode = 'header' | 'query';
export const MEDIA_FETCH_MODE: MediaFetchMode =
  import.meta.env.PUBLIC_GOOGLE_MEDIA_FETCH === 'query' ? 'query' : 'header';

export const PICKER_API = 'https://photospicker.googleapis.com/v1';

/** Picker sessions accept at most 2,000 items. */
export const MAX_PICK = 2000;
