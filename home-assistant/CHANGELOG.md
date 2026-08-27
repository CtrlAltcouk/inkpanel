# Changelog

## 0.1.0-ha.5

- Add native Home Assistant Calendar discovery and multi-calendar selection through the server-only Supervisor client.
- Add Calendar widget V2 provider selection while preserving existing V1/iCal configurations and renderers.
- Preserve widget versions in Studio drafts and remembered settings.
- Normalize panel-local dates and use isolated per-calendar stale caches with deterministic event ordering.
- HA-1 is validated; HA-2 awaits real-world validation. No firmware changes.

## 0.1.0-ha.4

- Let Home Assistant own App updates: remove the standalone updater UI and reject its mutation endpoint.
- Show update ownership in Settings without changing standalone deployments.

## 0.1.0-ha.3

- Include verified full-size and Mini production firmware packages in the App image.
- Make the Home Assistant Ingress WebFlash handoff clearer.

## 0.1.0-ha.2

- Use the current Home Assistant App image label.
- Always move WebFlash from Ingress to the direct secure InkPanel Studio.

## 0.1.0-ha.1

- Add the first Home Assistant App package for amd64 and aarch64.
- Add Studio support for arbitrary Ingress path prefixes.
- Keep panel HTTP and WebFlash HTTPS available as explicit LAN services.
- Add a safe Home Assistant Core connection status in Settings.
