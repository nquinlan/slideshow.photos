export {};
/**
 * Milestone 0 spike: can a static page download Google Photos Picker media?
 *
 * Strategies tried on the first picked photo (rendition =w1024-h1024):
 *  A. fetch + Authorization: Bearer   (the documented method; needs a CORS preflight)
 *  B. fetch + ?access_token=          (simple request, no preflight)
 *  C. fetch, no credentials           (works only if baseUrls are capability URLs)
 *  D. <img crossorigin=anonymous> + canvas export, no credentials
 * The page reports which ones return readable bytes.
 */
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>('log');
const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ');
  logEl.textContent += `[${new Date().toISOString().slice(11, 19)}] ${line}\n`;
  console.log(...a);
};

const clientInput = $<HTMLInputElement>('clientId');
clientInput.value = localStorage.getItem('spike.clientId') ?? '';
clientInput.addEventListener('change', () => localStorage.setItem('spike.clientId', clientInput.value.trim()));
$('origin').textContent = location.origin;

let token = '';
let sessionId = '';

function loadGis(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).google?.accounts?.oauth2) return resolve((window as any).google.accounts.oauth2);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve((window as any).google.accounts.oauth2);
    s.onerror = () => reject(new Error('GIS failed to load'));
    document.head.appendChild(s);
  });
}
void loadGis(); // preload so the popup opens inside the click

$('signin').onclick = async () => {
  const oauth2 = await loadGis();
  oauth2
    .initTokenClient({
      client_id: clientInput.value.trim(),
      scope: SCOPE,
      callback: (r: any) => {
        if (r.error) return log('Sign-in error', r);
        token = r.access_token;
        log(`Signed in. expires_in=${r.expires_in}s scope=${r.scope}`);
        ($('create') as HTMLButtonElement).disabled = false;
      },
      error_callback: (e: any) => log('Sign-in popup error', e),
    })
    .requestAccessToken({ prompt: '' });
};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

$('create').onclick = async () => {
  // Open the window synchronously (user activation), navigate it once we have the URI.
  const win = window.open('', 'picker');
  try {
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ pickingConfig: { maxItemCount: '5' } }) });
    sessionId = s.id;
    log('Session created', { id: s.id, expireTime: s.expireTime, pollingConfig: s.pollingConfig });
    const url = s.pickerUri + '/autoclose';
    const link = $<HTMLAnchorElement>('pickerLink');
    link.href = url;
    link.hidden = false;
    if (win) win.location.href = url;
    log('Pick 1–5 photos in the Google Photos window, then press Done. Polling…');
    let cur = s;
    const timeoutMs = parseFloat(s.pollingConfig?.timeoutIn ?? '600') * 1000;
    const start = Date.now();
    while (!cur.mediaItemsSet) {
      if (Date.now() - start > timeoutMs) throw new Error('Polling timed out');
      await new Promise((r) => setTimeout(r, parseFloat(cur.pollingConfig?.pollInterval ?? '3') * 1000));
      cur = await api(`/sessions/${sessionId}`);
    }
    log('mediaItemsSet = true');
    ($('download') as HTMLButtonElement).disabled = false;
  } catch (e) {
    log('Session error', String(e));
  }
};

const results = $('results').querySelector('tbody')!;
function row(name: string, ok: boolean, detail: string) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${name}</td><td class="${ok ? 'ok' : 'fail'}">${ok ? 'WORKS' : 'BLOCKED'}</td><td></td>`;
  tr.lastElementChild!.textContent = detail;
  results.appendChild(tr);
  log(`${name}: ${ok ? 'WORKS' : 'BLOCKED'} — ${detail}`);
}

async function tryFetch(name: string, url: string, init: RequestInit) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, init);
    if (!res.ok) return row(name, false, `HTTP ${res.status} ${res.statusText}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    row(name, true, `${blob.size} bytes, ${blob.type}, decoded ${bmp.width}×${bmp.height}, ${Math.round(performance.now() - t0)} ms`);
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    $('preview').replaceChildren(img);
  } catch (e) {
    row(name, false, `${(e as Error).name}: ${(e as Error).message} (TypeError here = CORS/network; see DevTools console)`);
  }
}

function tryImg(name: string, url: string) {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        c.toBlob((b) => {
          row(name, !!b, b ? `canvas export ok, ${img.naturalWidth}×${img.naturalHeight}` : 'toBlob returned null');
          resolve();
        }, 'image/webp');
      } catch (e) {
        row(name, false, `loaded but canvas tainted: ${(e as Error).message}`);
        resolve();
      }
    };
    img.onerror = () => {
      row(name, false, 'image failed to load (401/403 or CORS)');
      resolve();
    };
    img.src = url;
  });
}

$('download').onclick = async () => {
  results.replaceChildren();
  try {
    const list = await api(`/mediaItems?sessionId=${encodeURIComponent(sessionId)}&pageSize=100`);
    const items = list.mediaItems ?? [];
    log(`Listed ${items.length} item(s)`, items.map((i: any) => ({ type: i.type, mime: i.mediaFile?.mimeType, w: i.mediaFile?.mediaFileMetadata?.width, h: i.mediaFile?.mediaFileMetadata?.height, host: new URL(i.mediaFile.baseUrl).host })));
    const item = items.find((i: any) => i.type !== 'VIDEO') ?? items[0];
    if (!item) return log('No items picked');
    const base = item.mediaFile.baseUrl;
    const url = `${base}=w1024-h1024`;
    await tryFetch('A. fetch + Authorization header', url, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' });
    await tryFetch('B. fetch + ?access_token=', `${url}?access_token=${encodeURIComponent(token)}`, { credentials: 'omit' });
    await tryFetch('C. fetch, no credentials', url, { credentials: 'omit' });
    await tryImg('D. <img crossorigin> + canvas, no credentials', url);
    log('Done. Session cleanup…');
    await fetch(`${API}/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  } catch (e) {
    log('List/download error', String(e));
  }
};

$('copy').onclick = () => {
  const text = `UA: ${navigator.userAgent}\nOrigin: ${location.origin}\n\n${logEl.textContent ?? ''}`.replaceAll(token || '\u0000', '<token>');
  void navigator.clipboard.writeText(text);
};
