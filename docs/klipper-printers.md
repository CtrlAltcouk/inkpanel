# Klipper 3D Printers

The **3D Printers** widget reads live status from Klipper printers through [Moonraker's HTTP API](https://moonraker.readthedocs.io/en/latest/external_api/printer/). Moonraker must be installed, running, and reachable from the InkPanel server.

Add connections in InkPanel Studio with an HTTP or HTTPS base URL, for example:

```text
http://192.168.1.50
http://voron.local:7125
https://printer.example.lan/moonraker
```

Private LAN addresses are intentionally supported. URLs with embedded usernames or passwords and non-HTTP protocols are rejected.

## Authentication

An API key is optional when Moonraker trusts the InkPanel server's network. If Moonraker requires authentication, obtain the API key from the Moonraker configuration or your printer UI's authentication/settings area and paste it into the connection editor.

InkPanel stores the key only on the server and sends it to Moonraker using the `X-Api-Key` header. Stored keys are never returned to the browser. Leave the key field blank while editing to preserve it, or select **Clear saved API key** to remove it.

## Display behaviour

- A full-size 800×480 panel can select one to four printers. One printer gets a detailed progress view; two to four printers use a compact ordered overview.
- InkPanel Mini displays exactly one printer.
- Printer order in Studio controls the order in the full-size overview.
- Offline printers are isolated: one unavailable Moonraker instance does not hide healthy printers.

Status is live-only and is never written to InkPanel's stale source cache. The widget uses the panel's existing refresh interval; it does not change wake scheduling.

Progress prefers `display_status.progress` and falls back to `virtual_sdcard.progress`. Layer information is shown only when Klipper supplies valid current and total layers. Remaining time uses Moonraker file metadata when a useful estimate is available; otherwise it is omitted rather than guessed.

## Backup

Printer names, URLs, stable IDs, and optional API keys are stored in:

```text
DATA_DIR/.printer-connections.json
```

The file is mode `0600` on POSIX systems. Include it in backups alongside `DATA_DIR/config.json`. Panel configurations store only stable printer IDs.
