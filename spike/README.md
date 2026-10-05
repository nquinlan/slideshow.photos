# Milestone 0 spike: Google Photos Picker in a browser-only app

## Status: blocked pending one test in a real browser

Everything up to the download step works from a static page. The download step itself is very likely blocked by CORS for the documented method, and two fallbacks still need a real-account test.

| Step | Browser-only? | Evidence |
|---|---|---|
| Sign in (GIS token model, `photospicker.mediaitems.readonly`) | ✅ | Standard GIS flow, no secret needed |
| `sessions.create` / `get` / `delete`, `mediaItems.list` | ✅ | `OPTIONS https://photospicker.googleapis.com/v1/sessions` returns `access-control-allow-origin: <origin>` and `access-control-allow-headers: authorization,content-type` |
| Open picker | ✅ | `pickerUri` + `/autoclose` in a new window (iframes aren't allowed) |
| **Download bytes with `Authorization: Bearer`** (the documented method) | ❌ **probably blocked** | The media host `lh3.googleusercontent.com` answers a CORS preflight like a plain GET: `200`, `access-control-allow-origin: *`, but **no `Access-Control-Allow-Headers`**. A cross-origin `fetch` carrying an `Authorization` header needs `authorization` listed there, so browsers will reject it. |
| Download with `?access_token=` (no preflight) | ❓ | Responses carry `ACAO: *`, so this works **if** the media host accepts the token as a query parameter. Untested without a real token. |
| Download with no credentials | ❓ | Works only if Picker `baseUrl`s are capability URLs. The docs say a bearer token is required. |

The preflight probe was run on 2026-10-05:

```
curl -X OPTIONS 'https://lh3.googleusercontent.com/a/default-user=s96-c' \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' -D - -o /dev/null
HTTP/2 200
content-type: image/png
access-control-allow-origin: *
access-control-expose-headers: Content-Length
(no access-control-allow-headers, no access-control-allow-methods)
```

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

## What each outcome means

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
