# National Rail live departures

InkPanel can populate a **Trains** dashboard widget from the National Rail/Rail Delivery Group Live Departure Board service. The widget stores only origin and destination CRS codes. API credentials stay on the InkPanel server and are never written to `config.json`, browser settings, framebuffer data, firmware, or source-cache configuration.

## Current RDM product contract

This implementation targets the Rail Data Marketplace **Live Departure Board** product, version **1.1**, as shown by the subscribed product Specification.

The current API root is:

```text
https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/
```

Departure boards are requested from:

```text
GET GetDepartureBoard/{crs}
```

InkPanel uses the documented query parameters:

```text
numRows=8
filterCrs=<destination CRS>
filterType=to
timeOffset=0
timeWindow=120
```

The current RDM Specification authenticates the request with the subscription **Consumer key** in this HTTP header:

```text
x-apikey: <Consumer key>
```

The Specification also displays a Consumer secret, but its documented cURL/request example uses only `x-apikey`. InkPanel therefore does not store or send the Consumer secret.

If RDM changes the product contract, update this transport against the current subscribed Specification rather than copying legacy National Rail/Data Portal examples.

## Server environment

Normally only one value is required:

```text
NATIONAL_RAIL_LDB_API_KEY=<Consumer key>
```

An optional base-URL override exists only for a future gateway migration or controlled testing:

```text
NATIONAL_RAIL_LDB_BASE_URL=https://.../
```

If the API key is absent, live Train transport is disabled. If a base-URL override is supplied without an API key, startup fails closed. Base URLs must use HTTPS and cannot contain embedded credentials.

### Proxmox LXC installer

The systemd unit reads the root-owned environment file `/opt/inkpanel/inkpanel.env`. Enter the container as root, edit that file, and restart InkPanel:

```bash
pct enter <CTID>
nano /opt/inkpanel/inkpanel.env
systemctl restart inkpanel
journalctl -u inkpanel -n 50 --no-pager
exit
```

Add:

```text
NATIONAL_RAIL_LDB_API_KEY=<Consumer key>
```

The installer keeps that file `root:inkpanel` and mode `0640`. Do not put the API key or Consumer secret into `/opt/inkpanel/app`, Git, `config.json`, PR/issue comments, screenshots, or shell scripts in the app checkout.

At startup the journal should report only:

```text
National Rail live departures: configured
```

It deliberately never prints the API key.

### Docker / Compose

`docker-compose.yml` passes `NATIONAL_RAIL_LDB_API_KEY` from the deployment environment. Put the Consumer key in a deployment-local `.env` or proper secret-management system, not in the tracked Compose file.

## Widget behaviour

A Train widget with either station missing performs no National Rail request and renders `Trains — not set up`.

With both CRS codes configured:

- a successful board shows up to three upcoming departures using the existing InkPanel train renderer;
- a successful board with no matching services renders `No departures`;
- a source failure with a last-good value for the same device and exact route renders stale cached departures with the existing `from HH:MM` badge;
- a failure without matching stale data renders `Trains unavailable`.

Stale data is scoped by device, source, origin CRS and destination CRS. `MKC → EUS` cannot borrow cached data from `EUS → MKC` or from another panel.

## Licence and attribution

The subscribed product licence identifies **Rail Delivery Group** as the attribution party. National Rail's current Darwin developer guidance also requires attribution of National Rail as the data provider in line with the published brand guidelines. Do not invent a logo or attribution treatment: confirm the downloadable product licence/brand guidance before the physical widget is considered production-ready.

## Live acceptance test

Before merging the transport, verify it against the live subscribed RDM product. A useful first route is **Milton Keynes Central (MKC) → London Euston (EUS)**:

1. Ensure any API key that has appeared in a screenshot/chat/log has been revoked and replaced.
2. Put the replacement Consumer key directly into `/opt/inkpanel/inkpanel.env` as `NATIONAL_RAIL_LDB_API_KEY`.
3. Restart InkPanel and confirm the journal reports the train transport as configured without printing the key.
4. Set one dashboard section to Trains, `MKC` → `EUS`, and save.
5. Open the panel preview and confirm live departure times/platforms are plausible against National Rail.
6. Wake the physical panel and confirm the same data renders cleanly.
7. Confirm the final attribution presentation against the current downloadable licence/brand guidance.

Never paste live credentials into issue/PR comments or screenshots.
