# Bus and Traffic widgets

InkPanel exposes Bus and Traffic as independent dashboard widget types. Provider credentials are server-wide secrets: they can be entered from the relevant widget editor, but are not stored in a device's `config.json` and are never returned to the browser after saving.

## Bus — TransportAPI

Bus departure boards use TransportAPI v3 Bus Information:

- live stop board: `GET https://transportapi.com/v3/uk/bus/stop/{ATCOCODE}/live.json`
- stop search: `GET https://transportapi.com/v3/uk/places.json?query=...&type=bus_stop`
- authentication is sent in `X-App-Id` and `X-App-Key` headers, not query parameters
- InkPanel asks for `group=no`, `nextbuses=yes`, and a bounded departure count

Create a TransportAPI account/application and obtain its `app_id` and `app_key`. In InkPanel choose **Bus** for a dashboard section and enter both credentials. Once saved, stop-name search is enabled. A valid ATCO stop code can also be entered directly, including on the first save before search is available.

An optional Route filter restricts the displayed departures to a single service such as `6` or `X5`.

TransportAPI's permanent Free plan currently permits 30 hits/day. A frequently refreshed e-paper dashboard can exceed that allowance, so choose a plan/refresh cadence appropriate for the panel. TransportAPI's licence permits storing/caching supplied Data; InkPanel therefore uses its normal device/config-isolated stale-data cache for Bus. The displayed Bus cell carries the licence acknowledgement `source: http://transportapi.com/`.

Environment fallback for deployments that do not want browser-managed credentials:

```text
TRANSPORTAPI_APP_ID=<app id>
TRANSPORTAPI_APP_KEY=<app key>
```

The Web-UI-managed value takes precedence after one is saved.

## Traffic — Google Maps Routes API

Traffic uses Google Maps Platform Routes API `Compute Routes`:

```text
POST https://routes.googleapis.com/directions/v2:computeRoutes
```

InkPanel requests a driving route with `routingPreference: TRAFFIC_AWARE`. Google returns both `duration` and `staticDuration`. InkPanel displays those returned duration values directly as the traffic-aware journey time and the no-live-traffic reference time; it does not create a separate calculated delay metric from Google Maps Content.

In Google Cloud:

1. Create/select a project and attach billing.
2. Enable **Routes API**.
3. Create an API key and restrict it appropriately for the InkPanel server.
4. In InkPanel choose **Traffic**, paste the key, then enter the **From** and **To** addresses/postcodes.

Environment fallback:

```text
GOOGLE_MAPS_ROUTES_API_KEY=<API key>
```

The Web-UI-managed key takes precedence after one is saved.

### Google content handling

Routes API results are intentionally not written to InkPanel's persistent `SourceCache`. Traffic uses a timeout-only live runner: if Google is unavailable, the cell reports unavailable instead of replaying persisted stale Google data. Exact duplicate Traffic widgets share only the in-flight request for one render.

Routes API permits display without a corresponding Google map provided the required attribution is shown. The e-paper Traffic cell therefore includes visible, unmodified **Google Maps** text attribution in the same cell at the minimum supported text size. Keep this attribution intact.

InkPanel also exposes public `/terms.html` and `/privacy.html` pages and links them from the admin UI. The privacy page explains that configured Traffic origins/destinations are sent to Google Maps Platform when the widget is rendered.

## Secret files

When configured from the Web UI, InkPanel writes owner-only managed files under `DATA_DIR`:

```text
.transportapi-credentials.json
.google-maps-api-key
```

On POSIX systems these are tightened to mode `0600`. GET status endpoints expose only `configured` / `managed` booleans; stored values are never returned.

Optional endpoint overrides exist only for controlled testing/future provider migrations and must remain HTTPS:

```text
TRANSPORTAPI_BASE_URL=...
GOOGLE_ROUTES_URL=...
```
