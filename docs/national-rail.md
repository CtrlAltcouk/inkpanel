# National Rail live departures

InkPanel can populate a **Trains** dashboard widget from the National Rail live departure-board service. The widget itself stores only the origin and destination CRS codes. API credentials stay on the InkPanel server and are never written to `config.json`, browser settings, framebuffer data, firmware, or source-cache configuration.

## Before configuring it

Subscribe to the current **LDB Webservice Public Version** product in Rail Data Marketplace (RDM), then use the product's **Specification** page as the source of truth for the gateway URL and authentication method.

Do not copy credentials into this repository. Do not assume an old National Rail/Data Portal endpoint or authentication example still applies.

InkPanel currently accepts one configured authentication header/value pair. If the current RDM product specification requires a different scheme (for example multiple headers or token exchange), update the transport before entering production credentials rather than trying to encode multiple secrets into one value.

## Server environment

The transport uses these environment variables:

```text
NATIONAL_RAIL_LDB_BASE_URL=https://.../
NATIONAL_RAIL_LDB_AUTH_HEADER=Authorization
NATIONAL_RAIL_LDB_AUTH_VALUE=...
```

`NATIONAL_RAIL_LDB_AUTH_HEADER` defaults to `Authorization`; set it to the exact header name documented by the subscribed RDM product.

The base URL must be HTTPS and must not contain embedded username/password credentials. A partial configuration fails server startup so a typo cannot silently disable a transport that an administrator intended to enable.

### Proxmox LXC installer

The systemd unit already reads the root-owned environment file `/opt/inkpanel/inkpanel.env`. Enter the container as root, edit that file, and restart InkPanel:

```bash
pct enter <CTID>
nano /opt/inkpanel/inkpanel.env
systemctl restart inkpanel
journalctl -u inkpanel -n 50 --no-pager
exit
```

The existing installer keeps that file `root:inkpanel` and mode `0640`. Do not put the API credential into `/opt/inkpanel/app`, Git, `config.json`, or a shell script in the app checkout.

At startup the journal should report only:

```text
National Rail live departures: configured
```

It deliberately does not print the endpoint's credential value.

### Docker / Compose

`docker-compose.yml` passes the same three optional variables from the local Compose environment. Put the secret in a deployment-local `.env` or proper secret-management system, not in the tracked Compose file:

```text
NATIONAL_RAIL_LDB_BASE_URL=https://.../
NATIONAL_RAIL_LDB_AUTH_HEADER=Authorization
NATIONAL_RAIL_LDB_AUTH_VALUE=...
```

Then recreate/restart the container.

## Widget behaviour

A Train widget with either station missing performs no National Rail request and renders `Trains — not set up`.

With both CRS codes configured:

- a successful board shows up to three upcoming departures using the existing InkPanel train renderer;
- a successful board with no matching services renders `No departures`;
- a source failure with a last-good value for the same device and exact route renders stale cached departures with the existing `from HH:MM` badge;
- a failure without matching stale data renders `Trains unavailable`.

Stale data is scoped by device, source, origin CRS and destination CRS. `MKC → EUS` cannot borrow cached data from `EUS → MKC` or from another panel.

## Live acceptance test

Before declaring the transport production-ready, verify it against the currently subscribed RDM product rather than mocks alone. A useful first route is **Milton Keynes Central (MKC) → London Euston (EUS)**:

1. Configure the current gateway/authentication in the server environment.
2. Restart InkPanel and confirm the journal reports the train transport as configured without printing any secret.
3. Set one dashboard section to Trains, `MKC` → `EUS`, and save.
4. Open the panel preview and confirm live departure times/platforms are plausible against National Rail.
5. Wake/push the physical panel and confirm the same data renders cleanly.
6. Confirm the current RDM/National Rail product terms and required attribution presentation before relying on the feed in production.

Do not paste the live credential into issue/PR comments or screenshots. When reviewing the RDM Specification page, redact the credential value but leave the gateway URL, authentication scheme/header names, request format, and attribution terms visible.
