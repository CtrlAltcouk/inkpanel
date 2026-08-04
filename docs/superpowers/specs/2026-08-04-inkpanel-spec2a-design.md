# inkpanel — Spec 2a: UI, Push, and self-update

**Date:** 2026-08-04
**Status:** Approved, ready for implementation planning
**Follows:** [Spec 1](2026-08-03-inkpanel-spec1-design.md), which is implemented and running.

---

## 1. What this is

Spec 1 produced a working panel. This spec makes the server pleasant to live
with: a config UI that scales past one device, a city picker instead of raw
coordinates, a way to force a render, and a settings tab that can update the
server without dropping to a shell.

### Goals

- Manage several panels without the page becoming unusable.
- Set location by name, not by looking up latitude and longitude.
- See at a glance what each panel is currently displaying.
- Update the server from the UI.
- Make it possible to require a password, without forcing one.

### Explicitly not in this spec

**All transport work** — train, bus and traffic — is deferred to Spec 2b. It is
three integrations plus a station-data problem, and larger than everything here
combined. The panel already reserves and renders both bottom quadrants, so no
layout change is needed when it lands.

---

## 2. Scope decisions taken during design

| Decision | Choice | Why |
|---|---|---|
| Layout | Overview strip with live thumbnails, detail below | "Which panel is stuck?" is the question actually asked, and thumbnails answer it without reading |
| Push semantics | Force re-render, report when it lands | A sleeping panel cannot be reached; see §5 |
| Auth | Optional password, off by default | Existing installs keep working; opt in when wanted |
| Self-update | systemd path-activated root unit | Grants the web app no new privilege |

---

## 3. UI structure

Two tabs, hash-routed (`#panels`, `#settings`), centred at `max-width: 900px`.

Still vanilla JavaScript — no framework — but `public/app.js` is 130 lines today
and would not survive this. It splits by responsibility:

```
public/
  app.js          bootstrap and hash routing only
  api.js          fetch wrappers, error shapes, auth redirect
  panels.js       overview strip + device detail form
  settings.js     version, health, update flow
  components.js   shared rendering helpers (pills, fields, city picker)
  styles.css      unchanged approach: CtrlAlt tokens from vendor/
```

### Panels tab

A strip of cards — one per device — each showing a live `render.png` thumbnail,
name, claimed state, battery and last-seen. Selecting a card shows its config
below.

**Thumbnails must not cost renders.** They are lazy-loaded (`loading="lazy"`) and
served through the existing frame memo, so a page refresh is free unless content
genuinely changed. This is the same mechanism that stops the panel flashing; it
must not be bypassed here.

---

## 4. City picker

A debounced type-ahead (250 ms, minimum 2 characters) against Open-Meteo's
geocoding API, **proxied through our server**:

```
GET /api/geocode?q=milton%20keynes
→ { results: [ { label, latitude, longitude, timezone, countryCode } ] }
```

Proxied rather than called from the browser. Open-Meteo sends permissive CORS
headers so this is not strictly required today, but it keeps every outbound call
server-side, which stays true in 2b when sources need API keys.

Selecting a result sets latitude, longitude, and a new `locationLabel` field.

**It also pre-fills the timezone**, which the geocoding response includes. This
removes a genuine footgun: a mismatched timezone silently shifts every event
time on the panel, with nothing on screen to indicate why. The field stays
editable.

Latitude and longitude remain in `DeviceRecord` — the weather source consumes
them, and the picker is a better way to set them, not a replacement.

---

## 5. Push

```
POST /api/devices/:id/push
→ 200 { etag, renderedAt, willAppearBy | null, overdueSince | null }
```

Invalidates the device's memo, renders immediately, and reports when the panel
will collect it.

`willAppearBy` is `lastSeenAt + lastWakeSeconds`, requiring one new
`DeviceRecord` field, `lastWakeSeconds`, recording what the device was last told
to sleep for. If that moment has passed, the device has missed a check-in and
the response carries `overdueSince` instead — which doubles as an offline
indicator.

The UI shows: *"Rendered. Will appear by 21:35 — or press KEY1 on the panel."*

### What this button is honestly for

**It does not make anything reach the panel faster.** The panel deep-sleeps with
its radio off; nothing on the network can reach it, and there is no connection to
push down. The next scheduled wake would have fetched the new content anyway,
because changing configuration changes the content hash.

What Push provides is certainty and feedback: the thumbnail updates immediately
so a configuration change can be seen rendered, and the user is told when it
lands rather than guessing.

The forced invalidation matters in exactly one case — if the content hash is
unchanged, the memo would return the old frame and the user would learn nothing.
Push skips the memo so a render always happens.

---

## 6. Authentication

`INKPANEL_PASSWORD` unset means no authentication and no behaviour change.
Existing installations keep working untouched.

When set:

- `POST /api/auth/login` exchanges the password for an `HttpOnly`, HMAC-signed
  session cookie.
- The signing secret is generated on first start and stored at
  `/data/.session-secret` (mode 600). Sessions therefore survive restarts —
  which the update flow depends on — and are revoked by deleting the file.
- The session cookie lasts **30 days**, so a wall-mounted tablet showing the UI
  is not logging in weekly.
- Failed attempts are rate-limited in memory: **5 per 15 minutes per source IP**,
  then 429 until the window clears. Enough to make brute force impractical
  without adding a dependency, and the counter resets on restart, which is
  acceptable for a LAN appliance.

**Two endpoints remain open regardless:**

| Endpoint | Why |
|---|---|
| `GET /api/devices/:id/frame` | Firmware cannot log in. Device tokens are their own project. |
| `GET /health` | Monitoring should not need credentials. |

### Stated limitation

**This is HTTP, not HTTPS.** The password crosses the LAN in clear text and the
session cookie is sniffable by anyone able to capture packets on it.

This is protection against casual access — a guest on the WiFi, someone idly
poking at the address — and explicitly **not** protection against a hostile
network. Remote access still means a reverse proxy with TLS, not this. The README
must say so in those terms.

---

## 7. Settings tab

Displays version (package version plus short commit SHA), uptime, device count,
per-source health from the last render, data directory and free space, and
whether an update is available.

The update check is **read-only**: `git ls-remote origin main` compared against
local `HEAD`. It touches the network but does not mutate the repository, and the
result is cached for **10 minutes**, with a manual "check now" control that
bypasses the cache. Without that TTL, an open browser tab polling the settings
page would hit GitHub on every load.

A failure to reach GitHub reports "could not check" rather than "up to date" —
the two are not the same and conflating them hides a real problem.

---

## 8. Self-update

### Mechanism

The installer adds two root-owned units and one script:

```
/etc/systemd/system/inkpanel-update.path
  [Path] PathExists=/opt/inkpanel/data/.update-requested
         Unit=inkpanel-update.service

/etc/systemd/system/inkpanel-update.service
  [Service] Type=oneshot
            ExecStart=/usr/local/bin/inkpanel-update

/usr/local/bin/inkpanel-update   root-owned, 0755, not writable by inkpanel
```

The application's only action is to create the flag file — something it can
already do inside its own data directory. systemd runs the updater as root.

**The web app is granted no new privilege.** It cannot influence *what* runs,
only *that* it runs. Given the UI is unauthenticated by default, that containment
is the point: the worst an attacker on the LAN can do is trigger an update to the
project's own published repository.

### Updater sequence

1. Delete the flag file immediately, so it cannot retrigger.
2. Write `data/update-status.json` with `state: "running"`.
3. `runuser -u inkpanel -- git pull --ff-only`
4. **Only if `package-lock.json` changed**, `runuser -u inkpanel -- npm ci --omit=dev`
5. `systemctl restart inkpanel`
6. Write final status, `success` or `failed`, with the captured log.

Two decisions reduce the blast radius:

**`npm ci` runs conditionally.** Most updates are code-only. `npm ci` deletes
`node_modules` before reinstalling, and a failure partway leaves the service
unable to start — so it should run only when dependencies actually changed.

**A failed update does not restart the service.** The old, working process keeps
running and the UI reports the failure. A broken update must be a no-op, not an
outage.

### API

```
POST /api/system/update        → 202 { requestedAt }
GET  /api/system/update/status → 200 { state, startedAt, finishedAt, log[], error }
```

### UI flow

The server restarts underneath the page, so the browser will lose it. The client
polls every two seconds and **treats connection failures as expected**, not as
errors. When the server responds again reporting success with a new version, the
page reloads. After three minutes it gives up and points at `journalctl`.

The status file is written by root and read by the app, which is what makes
polling work across the restart. When authentication is enabled, the session
cookie survives because the signing secret is on disk.

### Risk

Self-update can break the service, and the UI that would fix it *is* the service.
If an update leaves it unable to start, recovery is the command line:
`journalctl -u inkpanel -n 50` and `git reset --hard` inside the container. The
mitigations above make this unlikely, not impossible. It goes in the docs.

---

## 9. Data model changes

`DeviceRecord` gains two fields:

| Field | Type | Default for existing records | Purpose |
|---|---|---|---|
| `locationLabel` | `string` | `''` — the picker shows empty, coordinates still work | Display name from the city picker |
| `lastWakeSeconds` | `number \| null` | `null` — Push reports "at its next check-in" until the device wakes once | What the device was last told to sleep for; used to compute `willAppearBy` |

`defaultDevice()` supplies both, and the store merges patches over defaults, so
existing `config.json` files load unchanged and no migration is required.

---

## 10. Testing

| Layer | Coverage |
|---|---|
| Geocoding mapper | Open-Meteo response → picker results, including missing `admin1` and absent timezone |
| Push | `willAppearBy` arithmetic, the overdue branch, and that the memo is genuinely bypassed |
| Auth | Unset password leaves everything open; set password 401s the management API; `frame` and `health` stay open in both cases; cookie signing rejects tampering |
| Update status | Parsing of running, success and failed status files, including a truncated or absent file |
| Contract | `/api/geocode`, `/api/devices/:id/push`, `/api/system/*` shapes |

The updater script is bash and cannot be meaningfully unit tested. It gets
`bash -n` in CI and a line in the installer's verification steps.

---

## 11. Deferred to Spec 2b

- Transport provider abstraction
- Train departures (National Rail Darwin) with station picker
- Bus departures (Bus Open Data Service) with stop picker
- Traffic drive time between saved home and work addresses
- Milton Keynes bin collections
- Tasks
- Per-device layout presets
- Event-aware wake scheduling
