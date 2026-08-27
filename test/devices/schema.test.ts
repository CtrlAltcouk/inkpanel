import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  deviceRecordV2Schema,
  deviceRecordV3Schema,
  deviceStoreV1Schema,
  deviceStoreV2PersistenceSchema,
  deviceStoreV2Schema,
  deviceStoreV3Schema,
  defaultDeviceV1,
  defaultDeviceV3,
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  parseDeviceStoreFile,
  runDeviceStoreMigrations,
  type DeviceStoreMigrations,
  type DeviceStoreV1,
} from '../../src/devices/schema.ts';

test('migration registry chains through every intermediate version in order', () => {
  const syntheticV3Record = deviceRecordV2Schema.extend({ v3OnlyField: z.string() });
  const syntheticV3Store = z.strictObject({
    schemaVersion: z.literal(3),
    devices: z.array(syntheticV3Record),
  });
  const steps: string[] = [];
  const v1Intermediates: DeviceStoreV1[] = [];
  const v2Intermediates: unknown[] = [];

  const migrations: DeviceStoreMigrations = {
    0: (file) => {
      steps.push('V0 -> V1');
      const v1 = migrateV0ToV1(file);
      v1Intermediates.push(v1);
      return v1;
    },
    1: (file) => {
      steps.push('V1 -> V2');
      const v2 = migrateV1ToV2(file);
      v2Intermediates.push(v2);
      return v2;
    },
    2: (file) => {
      steps.push('V2 -> V3');
      const v2 = deviceStoreV2Schema.parse(file);
      return syntheticV3Store.parse({
        schemaVersion: 3,
        devices: v2.devices.map((device) => ({ ...device, v3OnlyField: 'added by V3' })),
      });
    },
  };

  const migrated = runDeviceStoreMigrations(
    { devices: [{ id: 'esp32-chain', name: 'Legacy panel' }] },
    0,
    3,
    migrations,
  );

  assert.deepEqual(steps, ['V0 -> V1', 'V1 -> V2', 'V2 -> V3']);
  const v1Intermediate = v1Intermediates[0]!;
  assert.equal(v1Intermediate.schemaVersion, 1);
  assert.equal(deviceStoreV1Schema.safeParse(v1Intermediate).success, true);
  assert.equal('dashboardSections' in v1Intermediate.devices[0]!, false);
  const v2Intermediate = deviceStoreV2Schema.parse(v2Intermediates[0]);
  assert.equal(v2Intermediate.schemaVersion, 2);
  assert.equal('v3OnlyField' in v2Intermediate.devices[0]!, false);
  assert.equal(syntheticV3Store.parse(migrated).devices[0]?.v3OnlyField, 'added by V3');
});

test('real migration chain produces frozen V1, frozen V2, then lossless V3', () => {
  const v0 = { devices: [{ id: 'esp32-real-chain', name: 'Kitchen', claimed: true, latitude: 51.5, longitude: -0.1, activeIntervalSeconds: 1800, calendarUrls: ['https://example.com/a.ics'], binsUprn: '100080152345', trainOriginCrs: 'MKC', trainDestinationCrs: 'EUS' }] };
  const v1 = migrateV0ToV1(v0);
  const v2 = migrateV1ToV2(v1);
  const v3 = migrateV2ToV3(v2);
  assert.equal(v1.schemaVersion, 1);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v3.schemaVersion, 3);
  const expectedSections = [
    { type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/a.ics'] } },
    { type: 'weather', version: 1, config: {} },
    { type: 'trains', version: 1, config: { originCrs: 'MKC', destinationCrs: 'EUS' } },
    { type: 'bins', version: 1, config: { uprn: '100080152345' } },
  ];
  assert.deepEqual(v2.devices[0]?.dashboardSections, expectedSections);
  assert.deepEqual(v3.devices[0]?.dashboardSections, expectedSections, 'V2 -> V3 keeps all four widgets byte-for-byte equivalent');
  assert.equal(v3.devices[0]?.panelProfileId, 'wft0583-800x480-mono');
  assert.equal('calendarUrls' in v2.devices[0]!, false);
  assert.equal('binsUprn' in v2.devices[0]!, false);
  assert.equal('trainOriginCrs' in v2.devices[0]!, false);
  assert.equal(v3.devices[0]?.name, 'Kitchen');
  assert.equal(v3.devices[0]?.claimed, true);
  assert.equal(v3.devices[0]?.latitude, 51.5);
  assert.equal(v3.devices[0]?.activeIntervalSeconds, 1800);
});

test('parseDeviceStoreFile migrates a V2 large panel to current V3 without layout changes', () => {
  const v2 = migrateV1ToV2({ schemaVersion: 1, devices: [defaultDeviceV1('esp32-upgrade')] });
  const current = parseDeviceStoreFile(v2);
  assert.equal(current.schemaVersion, 3);
  assert.equal(current.devices[0]?.panelProfileId, 'wft0583-800x480-mono');
  assert.equal(current.devices[0]?.dashboardSections.length, 4);
  assert.deepEqual(current.devices[0]?.dashboardSections, v2.devices[0]?.dashboardSections);
});

test('V3 accepts exactly one widget for Mini and exactly four for WFT', () => {
  const mini = defaultDeviceV3('esp32-mini', 'ssd1681-200x200-mono');
  assert.equal(mini.dashboardSections.length, 1);
  assert.equal(mini.dashboardSections[0]?.type, 'weather');
  assert.equal(deviceRecordV3Schema.safeParse(mini).success, true);

  assert.equal(deviceRecordV3Schema.safeParse({
    ...mini,
    dashboardSections: [
      ...mini.dashboardSections,
      { type: 'empty', version: 1, config: {} },
      { type: 'empty', version: 1, config: {} },
      { type: 'empty', version: 1, config: {} },
    ],
  }).success, false, 'Mini cannot persist hidden extra slots');

  const large = defaultDeviceV3('esp32-large');
  assert.equal(large.dashboardSections.length, 4);
  assert.equal(deviceRecordV3Schema.safeParse(large).success, true);
  assert.equal(deviceRecordV3Schema.safeParse({ ...large, dashboardSections: [large.dashboardSections[0]] }).success, false,
    'WFT cannot be accidentally switched to a one-slot framebuffer layout');

  assert.equal(deviceStoreV3Schema.safeParse({ schemaVersion: 3, devices: [mini, large] }).success, true);
});

test('frozen V1 remains unchanged after V3 is current', () => {
  const v1 = { ...defaultDeviceV1('esp32-v1'), calendarUrls: ['ftp://legacy.example/feed.ics'] };
  assert.equal(deviceStoreV1Schema.safeParse({ schemaVersion: 1, devices: [v1] }).success, true);
  assert.equal('dashboardSections' in v1, false);
});

test('V2 persistence envelope remains generic while its frozen runtime registry fails closed', () => {
  const migrated = migrateV1ToV2({ schemaVersion: 1, devices: [defaultDeviceV1('esp32-v2')] });
  const unknown = structuredClone(migrated);
  unknown.devices[0]!.dashboardSections[0] = { type: 'future-widget', version: 7, config: { anything: true } };
  assert.equal(deviceStoreV2PersistenceSchema.safeParse(unknown).success, true, 'frozen storage envelope accepts future registry entries');
  const unknownResult = deviceStoreV2Schema.safeParse(unknown);
  assert.equal(unknownResult.success, false, 'frozen V2 registry rejects unknown type/version');
  if (!unknownResult.success) assert.match(unknownResult.error.message, /unknown widget type: future-widget/);

  const futureVersion = structuredClone(migrated);
  futureVersion.devices[0]!.dashboardSections[0] = { type: 'calendar', version: 99, config: { calendarUrls: [] } };
  const versionResult = deviceStoreV2Schema.safeParse(futureVersion);
  assert.equal(versionResult.success, false);
  if (!versionResult.success) assert.match(versionResult.error.message, /unsupported calendar widget version: 99/);

  const malformed = structuredClone(migrated);
  malformed.devices[0]!.dashboardSections[0] = { type: 'calendar', version: 1, config: { calendarUrls: [], extra: true } };
  assert.equal(deviceStoreV2Schema.safeParse(malformed).success, false, 'widget config is strict');

  const short = structuredClone(migrated) as { schemaVersion: 2; devices: Array<{ dashboardSections: unknown[] }> };
  short.devices[0]!.dashboardSections.pop();
  assert.equal(deviceStoreV2Schema.safeParse(short).success, false, 'frozen V2 still requires exactly four sections');
});
