/**
 * Google Identity Services, token model (no backend, no client secret).
 *
 * Access tokens last ~1 hour and the token model has no refresh token, so a
 * Google import is designed as one bounded session: we show the remaining
 * time and pause/resume with a fresh sign-in if it runs out. Tokens are kept
 * in memory only — never persisted.
 *
 * The GIS script is loaded lazily (on first hover/focus/click of "Add from
 * Google Photos"), so no Google code runs for users who don't use it.
 */
import { GOOGLE_CLIENT_ID, PICKER_SCOPE } from './config';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

export interface GoogleToken {
  accessToken: string;
  /** ms since epoch. */
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(cfg: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
  }): TokenClient;
  revoke(token: string, done?: () => void): void;
  hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

let gisPromise: Promise<GoogleOAuth2> | undefined;

export function loadGis(): Promise<GoogleOAuth2> {
  gisPromise ??= new Promise<GoogleOAuth2>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => {
      const o = window.google?.accounts?.oauth2;
      if (o) resolve(o);
      else reject(new Error('Google sign-in failed to initialise'));
    };
    s.onerror = () => {
      gisPromise = undefined;
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function isGisLoaded() {
  return !!window.google?.accounts?.oauth2;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public code: 'popup_closed' | 'popup_blocked' | 'access_denied' | 'scope_denied' | 'config' | 'unknown',
  ) {
    super(message);
  }
}

/**
 * Open Google's consent popup and resolve with an access token. Call this
 * synchronously inside a click handler when GIS is already loaded, otherwise
 * browsers may block the popup.
 */
export function requestToken(oauth2: GoogleOAuth2, opts: { prompt?: '' | 'consent' | 'select_account' } = {}): Promise<GoogleToken> {
  if (!GOOGLE_CLIENT_ID) {
    return Promise.reject(
      new GoogleAuthError('Google Photos is not configured for this site (missing PUBLIC_GOOGLE_CLIENT_ID).', 'config'),
    );
  }
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: PICKER_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          return reject(
            new GoogleAuthError(
              r.error === 'access_denied' ? 'Google access was not granted.' : (r.error_description ?? r.error ?? 'Sign-in failed'),
              r.error === 'access_denied' ? 'access_denied' : 'unknown',
            ),
          );
        }
        if (!oauth2.hasGrantedAllScopes(r, PICKER_SCOPE)) {
          return reject(new GoogleAuthError('Permission to read picked photos was not granted.', 'scope_denied'));
        }
        // Subtract a safety margin so we never start a download with a token about to expire.
        const ttl = Number(r.expires_in ?? 3600) * 1000;
        resolve({ accessToken: r.access_token, expiresAt: Date.now() + ttl - 60_000 });
      },
      error_callback: (e) => {
        if (e.type === 'popup_closed') reject(new GoogleAuthError('The Google sign-in window was closed.', 'popup_closed'));
        else if (e.type === 'popup_failed_to_open')
          reject(new GoogleAuthError('Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.', 'popup_blocked'));
        else reject(new GoogleAuthError(e.message ?? 'Sign-in failed', 'unknown'));
      },
    });
    client.requestAccessToken({ prompt: opts.prompt ?? '' });
  });
}

export async function revokeToken(token: GoogleToken | undefined) {
  if (!token) return;
  const o = window.google?.accounts?.oauth2;
  await new Promise<void>((r) => (o ? o.revoke(token.accessToken, r) : r()));
}
