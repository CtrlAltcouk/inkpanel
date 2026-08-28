# InkPanel Home Assistant App

This App is experimental. Install it by adding the following App repository in Home Assistant:

`https://github.com/CtrlAltcouk/inkpanel#Home-Assistant`

## Configuration

- `panel_base_url` — the LAN HTTP URL that physical InkPanel devices can reach, for example `http://192.168.1.20:8080`. Use only the origin: no path, query or fragment.
- `lan_password` — required password for the direct LAN Studio. Home Assistant Ingress uses your Home Assistant session instead.

Save both options and start the App. Open **Web UI** for the Ingress-hosted Studio.

## Network ports

- `8099` is internal Ingress traffic only and is not published to the host.
- `8080` is the panel-facing HTTP API and direct LAN Studio.
- `8443` is the self-signed HTTPS Studio used for browser WebSerial flashing.

The Flash tab remains visible through Ingress. If the browser cannot use WebSerial in the Ingress context, it offers the direct HTTPS Studio address. Accept the local self-signed certificate warning once, then use either supported hardware target normally.

## Persistence and backups

All configuration, caches, local lists, connection settings, session material and generated HTTPS material live under `/data`. Home Assistant cold backups include this directory.

## Home Assistant connection

The App uses the Supervisor-provided, process-only token to query Home Assistant Core. It never sends that token to the browser or stores it in InkPanel configuration. The Settings page reports a safe connection status.

Phase HA-1 establishes deployment and runtime integration only. It does not add Home Assistant-backed widgets yet.
Later phases will add optional Home Assistant Calendar, To Do and Entity providers while retaining all existing InkPanel sources.
