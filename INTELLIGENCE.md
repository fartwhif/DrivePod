# YouTube 403 on datacenter egress — diagnosis & fix

Date: 2026-08-24
Affects: DrivePod (audio harvest) + GrabbyTube (mp3). Same root cause, same fix.

## Symptom

Every download 403'd: `HTTP Error 403: Forbidden` from `googlevideo.com`.
172 failures in DrivePod's full log history, zero mp3s ever produced.
Metadata extraction, PO token, and format selection all succeeded — only the
actual media file download 403'd.

## What was NOT the cause (ruled out, with evidence)

- **Cookies.** Freshly exported cookies confirmed valid three ways:
  `/account_otp` returns logged-in view; `--skip-download` metadata + PO token
  works. 403 persisted across a full fresh-login cycle.
- **Rate limiting.** 90s wait between requests → still 403.
- **IP block.** An anonymous (no-cookie) download also 403'd. But — see below —
  the IP is not actually blocked for all streams.
- **DNS leak from the ytcookies browser.** Red herring. The browser's HTTP/TLS
  egress is the same gthost datacenter IP as everything else; the DNS leak to the
  home ISP does not change the source IP the CDN sees.
- **bgutil / PO token.** Token was generated and accepted; not the failure point.

## The actual root cause

Google serves different signed URLs per format and **403s only some stream types
from datacenter IPs**. Captured the exact media URL the ytcookies browser plays
(replays from drivepod return 200 — so the IP itself is fine) and isolated by
format:

  combined video+audio (18, 22, 360p mp4)  -> 200, downloads fine
  audio-only    (140 m4a, 250/251 opus)    -> 403, 0 bytes
  video-only    (134 webm)                 -> 403, 0 bytes

`-f bestaudio/best` always resolves to the 140/251 **audio-only** stream → 403
every time. The browser plays the combined mp4 stream → 200. That is the whole
difference: it was the **format**, not cookies, IP, or rate limits.

Note: the web client uses SABR (protobuf streaming, `Content-Type:
application/vnd.yt-ump`) — a different transport — which is why the browser's
exact media URL returns a 200 to the same IP even when the HTTP audio-only
variants 403.

## The fix

Prefer combined video+audio streams and extract the audio client-side.

  old: -f bestaudio/best
  new: -f b[acodec!=none][height<=360]/b[acodec!=none]/ba/b

  → picks a ≤360p combined mp4 (small, fast, contains audio), downloads it,
    then ffmpeg extracts the mp3 as before. Audio-only (`ba`) is kept only as a
    last-resort fallback for the rare case no combined format exists.

Changed in:
  - DrivePod:   backend/src/server.ts — downloadCmd in `getBaseYtDlpCommand()`
  - GrabbyTube: processor.py — `_build_yt_dlp_command()`

## Verification (real execution, post-fix)

  drivepod:   16 new mp3s in ~25 min, 0 × 403
  grabbytube: 0 × 403
  sample:     gkTyHl5MGPg.mp3 = 39 MB, ffprobe duration 5024s @ 64kbps
              (a real 83-minute audio file, not a stub)

Remaining "failed" queue entries are legitimate skips: upcoming premieres, live
streams — not 403s.

## How to tell which 403 you have (quick triage)

  - Cookie 403:  metadata step also 403s; a fresh login fixes it.
  - Format/IP 403:  metadata + PO token are fine, only the file 403s; happens
    with and without cookies, on both containers; waiting does not help.

## Repeatable cookie-fix procedure (when cookie 403s DO appear)

1. Open https://ytcookies.esfbc.com (noVNC).
2. Clear cookies / log out, then log back into YouTube.
3. Wait 30–60s, then check `docker logs ytcookies | grep exported`.
4. Verify from DrivePod:
   `docker exec drivepod head -3 /shared-cookies/cookies.txt`
5. Test:
   `docker exec drivepod yt-dlp --cookies /shared-cookies/cookies.txt \
     --skip-download --print "%(id)s" <video-url>`

## Watch item / future mitigation

This fix depends on Google continuing to 403 only the audio-only (and
video-only) URLs from this IP. If it ever tightens to block ALL datacenter-IP
streams (i.e. `b[acodec!=none]` also starts 403ing), the same fix stops working
and you will need a residential exit — wire a `--proxy` into
`getBaseYtDlpCommand()` (DrivePod) and the equivalent in GrabbyTube's
processor. Symptom to watch: 403s on the **combined** stream, not just audio-only.

## Secondary (unrelated) known issue

`cookie_exporter.py`'s login-validation checks SID/HSID on `.youtube.com`, but
Google stores them on `.google.com`. Result: false "logged out" log spam every
30s even when the cookie file is valid. Not the cause of the 403. Not yet
patched.
