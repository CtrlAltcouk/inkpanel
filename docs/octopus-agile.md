# Octopus Agile widget

InkPanel can show the cheapest upcoming Octopus Agile half-hour period as one of the four dashboard sections.

## Configuration

Choose **Octopus Agile** in a dashboard section and paste the full electricity tariff code, for example:

```text
E-1R-AGILE-24-10-01-C
```

InkPanel derives the Octopus product code from the tariff code (`AGILE-24-10-01` in the example), so there is only one field to configure.

The Agile standard-unit-rate endpoint is public. This widget does **not** need or store an Octopus account number, API key, MPAN or meter serial.

If you do not know your tariff code, retrieve it from your Octopus account/agreement details and paste only the tariff code into InkPanel. Do not paste account API credentials into the tariff field.

## What is displayed

The panel intentionally answers one question: **when is the cheapest upcoming time to use electricity?**

The cell shows:

- the cheapest still-valid half-hour start/end time
- `NOW`, `TODAY`, `TOMORROW`, or a short date label
- the price in pence/kWh including VAT

Negative Agile prices are valid and are displayed as negative values rather than discarded.

## Data source and time window

InkPanel calls Octopus Energy's public Agile price endpoint:

```text
GET https://api.octopus.energy/v1/products/{product}/electricity-tariffs/{tariff}/standard-unit-rates/
```

Each request includes explicit UTC `period_from` and `period_to` parameters covering the next 24 hours. Octopus recommends explicit UTC periods to avoid ambiguity around daylight-saving changes.

The response's `valid_from` and `valid_to` values are used directly; InkPanel does not manufacture the end time by assuming every returned record is exactly 30 minutes long.

## Failure/cache behaviour

Octopus uses InkPanel's normal device/config-isolated `SourceCache` path.

- live request succeeds: use the current rate window
- live request fails but a same-panel/same-tariff last-good window exists: use it as stale data
- no usable rate data exists: show `Octopus unavailable`
- blank tariff: show `Octopus — not set up`

The cached object is the rate window, not a permanently chosen cheapest slot. On every render InkPanel re-evaluates which cached slot is still in the future, so a stale cache cannot continue recommending a period that has already ended.

## API reference

Octopus Energy REST API documentation:

```text
https://developer.octopus.energy/guides/rest/api-endpoints/
```
