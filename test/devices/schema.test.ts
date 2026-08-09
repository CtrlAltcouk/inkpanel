import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  deviceRecordV1Schema,
  deviceStoreV1Schema,
  migrateV0ToV1,
  runDeviceStoreMigrations,
  type DeviceStoreMigrations,
  type DeviceStoreV1,
} from '../../src/devices/schema.ts';

test('migration registry chains V0 -> V1 -> V2 through a genuine frozen V1 object', () => {
  const deviceRecordV2Schema = deviceRecordV1Schema.extend({ v2OnlyField: z.string() });
  const deviceStoreV2Schema = z.strictObject({
    schemaVersion: z.literal(2),
    devices: z.array(deviceRecordV2Schema),
  });
  const steps: string[] = [];
  const v1Intermediates: DeviceStoreV1[] = [];

  const migrations: DeviceStoreMigrations = {
    0: (file) => {
      steps.push('V0 -> V1');
      const v1 = migrateV0ToV1(file);
      v1Intermediates.push(v1);
      return v1;
    },
    1: (file) => {
      steps.push('V1 -> V2');
      const v1 = deviceStoreV1Schema.parse(file);
      return deviceStoreV2Schema.parse({
        schemaVersion: 2,
        devices: v1.devices.map((device) => ({ ...device, v2OnlyField: 'added by V2' })),
      });
    },
  };

  const migrated = runDeviceStoreMigrations(
    { devices: [{ id: 'esp32-chain', name: 'Legacy panel' }] },
    0,
    2,
    migrations,
  );

  assert.deepEqual(steps, ['V0 -> V1', 'V1 -> V2']);
  const v1Intermediate = v1Intermediates[0]!;
  assert.equal(v1Intermediate.schemaVersion, 1);
  assert.equal(deviceStoreV1Schema.safeParse(v1Intermediate).success, true);
  assert.equal('v2OnlyField' in v1Intermediate.devices[0]!, false);
  assert.equal(deviceStoreV2Schema.parse(migrated).devices[0]?.v2OnlyField, 'added by V2');
});
