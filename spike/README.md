# Milestone 0 spike: Google Photos Picker in a browser-only app

## Status: ✅ works browser-only, no backend needed (verified 2026-10-05)

Run in Chrome 154 from `http://localhost:5173`, with a real account and two picked iPhone HEIC photos (5712×4284 and 4284×5712).

| Step | Result |
|---|---|
| Sign in (GIS token model, `photospicker.mediaitems.readonly`) | ✅ Token granted, `expires_in` 3599 s |
| `sessions.create` / `get`, `mediaItems.list` | ✅ CORS works with an `Authorization` header |
| Open picker (`pickerUri` + `/autoclose`, new window) | ✅ `mediaItemsSet` became true about 16 s after opening |
| **A. `fetch` + `Authorization: Bearer`** (documented; the app default) | ✅ **137 KB `image/jpeg`, decoded 1024×768, 330 ms** |
| B. `fetch` + `?access_token=` | ✅ Works too (fallback: `PUBLIC_GOOGLE_MEDIA_FETCH=query`) |
| C, D. No credentials | Reported as working, but **not meaningful**. C took 6 ms on the same URL that A had just fetched, so it was almost certainly a browser-cache hit. Don't rely on unauthenticated access. |

Other things this showed:

- **HEIC originals come back as JPEG.** Requesting `=w1024-h1024` returned a JPEG scaled to fit within the box, 5712×4284 → 1024×768. Google items therefore never need the WASM HEIC decoder, and originals are never downloaded.
- **Sessions last 7 days.** `expireTime` was creation + 7 days. Polling used `pollInterval` 5 s and `timeoutIn` about 30 min. Resuming after the 1-hour token expires can reuse the same session: a fresh sign-in calls `mediaItems.list` again, which returns fresh `baseUrl`s valid for 60 minutes. This is how the app's resume works.

### Why the earlier prediction was wrong

Before this test, I predicted method A would be blocked. That prediction came from a CORS preflight probe against a placeholder `lh3.googleusercontent.com` path. Its response omitted `Access-Control-Allow-Headers`, which would fail an `Authorization` preflight. Real Picker `baseUrl`s evidently answer the preflight correctly. A curl probe against a placeholder path wasn't representative; only the real-account test settles it.

## Run the spike (about 5 minutes)

1. Create an OAuth client. The steps are in the main README under "Google Cloud setup". Add `http://localhost:5173` as an Authorized JavaScript origin.
2. Run `npm run spike` and open http://localhost:5173/. Use `localhost`, not a network address; Google only allows plain http for localhost origins.
3. Paste the client ID, then work through the steps: **Sign in**, then **Create session & open picker**. Pick one or two photos and tap Done. Then click **Test downloads**.
4. The table shows which strategies work:
   - **A.** Fetch with an `Authorization` header (documented)
   - **B.** Fetch with `?access_token=`
   - **C.** Fetch with no credentials
   - **D.** `<img crossorigin>` drawn to a canvas, with no credentials

   Click **Copy report** to grab the log; the token is redacted.

## What each outcome means (kept for reference)

- **A works:** nothing to change. This is the app default (`PUBLIC_GOOGLE_MEDIA_FETCH=header`).
- **Only B works:** set `PUBLIC_GOOGLE_MEDIA_FETCH=query`. Still no backend. The trade-off is that the token appears in request URLs. It is short-lived and only sent to Google, but URLs can end up in the browser's own network logs.
- **Only C or D works:** add a `'none'` mode to `fetchPickedPhoto` (a small change). Still no backend.
- **None work:** browser-only download is impossible. Pick one of these options:
  1. **Minimal serverless proxy.** About 40 lines, for example a Cloudflare Worker or Vercel Edge Function. It is the only option that keeps the current flow.
     - **What it does:** `GET /media?u=<baseUrl>=w2560-h2560` with the user's `Authorization` header. It validates that the host is exactly `lh3.googleusercontent.com` (so it isn't an open proxy or an SSRF hole), forwards the header, streams the response back with `Access-Control-Allow-Origin: <your app origin>`, and stores and logs nothing.
     - **Cost:** bandwidth only. 1,000 photos at 2560 px is about 400–600 MB through the proxy per import, within free tiers for personal use.
     - **Privacy impact:** photo bytes and the access token pass through infrastructure you run. The privacy statement and FAQ ("photos never leave your device") must be reworded to something like "Google Photos imports pass through our download relay, which doesn't store them". Deploy it under the same site so no third party sees the bytes.
     - The app already isolates this: `fetchPickedPhoto` in `src/app/google/picker.ts` is the only function that would change.
  2. **No Google integration; document Google Takeout instead.** Users export an album with Takeout, unzip it, and use **Add folder**. No backend, works today, but more manual for users.
  3. **Ship local files only for now**, and revisit Google Photos when Google adds CORS support for the Picker media host.

Per the project brief, I have **not** added a proxy. That decision is yours.
