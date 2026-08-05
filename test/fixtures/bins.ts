/**
 * Trimmed but structurally faithful Milton Keynes bin-collection response,
 * captured 2026-08-05 for UPRN 25006645 via `scripts/capture-bins.mjs`.
 *
 * The council's `apibroker/runLookup` endpoint wraps the interesting data in
 * `integration.transformed.rows_data`: an object keyed by row index (not an
 * array), one entry per bin round. The same information also comes back as
 * an XML string in `data` / `integration.transformed.xml_data`; those fields
 * (and the unrelated `select_data`, `meta_data`, `tokens`, `runtimes`,
 * `log_id`, `hash` noise) are omitted here as they carry nothing our mapper
 * reads and no personal data was present in them regardless.
 *
 * At capture time `NextInstance` was already advanced past each round's
 * `LastInstance`/`TaskCompletedDate` — the council pre-computes "next", so
 * the mapper does not need to reason about completed rounds, only choose the
 * soonest instance that has not passed relative to "today".
 */
export const REAL_RESPONSE = {
  status: 'done',
  integration: {
    transformed: {
      rows_data: {
        '0': {
          ServiceName: 'Domestic Recycling Collection',
          TaskTypeName: 'Collect Recycling Red',
          AssetTypeName: '180L Paper & Card (Red Lid)',
          RoundName: 'Recy Red 16 Fri',
          ScheduleDescription: 'Every Friday fortnightly',
          NextInstance: '2026-08-14',
          LastInstance: '2026-07-31',
          StateName: 'Complete',
        },
        '1': {
          ServiceName: 'Domestic Recycling Collection',
          TaskTypeName: 'Collect Recycling Blue',
          AssetTypeName: '180L Metal Glass & Plastic (Blue Lid)',
          RoundName: 'Recy Blue 16 Fri',
          ScheduleDescription: 'Every Friday fortnightly',
          NextInstance: '2026-08-07',
          LastInstance: '2026-07-24',
          StateName: 'Complete',
        },
        '2': {
          ServiceName: 'Food and Garden',
          TaskTypeName: 'Collect Food and Garden',
          AssetTypeName: '140L Food & Garden (Green Lid)',
          RoundName: 'Food and Garden 07 Fri',
          ScheduleDescription: 'Every Friday',
          NextInstance: '2026-08-07',
          LastInstance: '2026-07-31',
          StateName: 'Complete',
        },
        '3': {
          ServiceName: 'Domestic Refuse Collection',
          TaskTypeName: 'Collect Refuse',
          AssetTypeName: '180L Refuse (Grey Lid)',
          RoundName: 'Refuse 09 Fri',
          ScheduleDescription: 'Every Friday',
          NextInstance: '2026-08-07',
          LastInstance: '2026-07-31',
          StateName: 'Complete',
        },
      },
    },
  },
};

/**
 * Same envelope shape as a real response, with zero rows. Not independently
 * captured — every UPRN we have access to has active rounds — but it is the
 * documented degenerate case of the real shape above (an empty `rows_data`),
 * not a guessed alternative shape.
 */
export const NO_COLLECTIONS = {
  status: 'done',
  integration: {
    transformed: {
      rows_data: {},
    },
  },
};
