# Widget setup links and remembered settings

The Panels editor keeps provider setup close to the widget that needs it and remembers non-provider widget configuration when a section changes type.

## Setup links

Each configurable widget links to the relevant setup/help page next to its input:

- **Calendar** — Google Calendar help for the **Secret address in iCal format**. Other HTTPS iCal feeds remain supported.
- **Trains** — Rail Data Marketplace, where the National Rail Consumer key is obtained.
- **Bus** — TransportAPI developer portal for `app_id` and `app_key`.
- **Traffic** — Google Maps Platform Routes API key setup.
- **Octopus Agile** — Octopus tariff/API documentation. Agile public prices do not require an Octopus API key.
- **Bins** — `findmyaddress.co.uk` for the Milton Keynes UPRN, as before.

External setup links open in a new tab and use `rel="noreferrer"`.

## Provider credentials remain write-only

National Rail, TransportAPI and Google Maps credentials keep their existing server-wide stores. They are not copied into remembered widget settings and are never sent back to the browser after saving.

The editor only receives `configured` / `managed` status. A blank credential field therefore means **keep the existing saved credential**.

This also means one configured provider credential automatically works for the relevant widget on every InkPanel device.

## Remembered widget configuration

DeviceStore continues to contain only the four widget configurations that the panel is actively rendering. Inactive editor drafts are stored separately in:

```text
DATA_DIR/.dashboard-editor-preferences.json
```

On POSIX systems the file is kept at mode `0600`, because remembered values can include secret calendar URLs and private route addresses.

The file stores:

1. **per-device, per-slot drafts** — switching a particular panel/slot away from a widget and back restores that slot's previous value;
2. **shared last-useful values** — a panel/slot that has never configured a widget can start with the most recently saved complete configuration from another panel.

Precedence when the editor opens is:

```text
active DeviceStore config
    > same panel/slot remembered draft
    > shared last-useful config
    > blank widget default
```

So sharing never overwrites a panel's current or previously remembered setup.

Shared fallbacks are promoted only from complete/useful configurations:

- Calendar: at least one URL
- Trains: both From and To station
- Bus: a stop code
- Traffic: both From and To
- Octopus Agile: a tariff code
- Bins: a UPRN
- Home Assistant Sensors: at least one ordered `sensor.*` entity ID (maximum four)

Weather and Empty have no reusable configuration.

Home Assistant Sensors uses the existing `entities` V1 draft in both per-slot and shared remembered settings. Switching Sensors → Weather → Sensors restores the selected IDs and order; active configuration still takes precedence over remembered defaults. Missing IDs remain valid configuration and are never silently removed. Sensor search is transient UI state, while add/remove/reorder requires **Save changes**. The Content option is offered only in HA App mode; an already-saved Sensors widget remains visible even if discovery or HA support is unavailable.

## Save behaviour

When **Save** is pressed, InkPanel:

1. saves any newly entered provider credentials to their existing secure stores;
2. saves every widget draft currently remembered by the four editor slots;
3. saves the four active widget configurations to DeviceStore.

If the remembered-settings write fails, the active device configuration is not changed by that Save attempt.

The remembered-settings file is convenience state rather than authoritative panel state. If it is corrupt on startup, InkPanel preserves it with a `.corrupt-<timestamp>` suffix and starts with empty remembered settings; `config.json` is not touched.
