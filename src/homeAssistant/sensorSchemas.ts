import { z } from 'zod';

/** HA-4 V1 deliberately permits sensors only; future domains need new schemas. */
export const sensorEntityIdSchema = z.string().max(255).regex(/^sensor\.[a-z0-9_]+$/, 'invalid Home Assistant sensor entity ID');
export const sensorEntityIdsSchema = z.array(sensorEntityIdSchema).max(4)
  .refine((ids) => new Set(ids).size === ids.length, 'sensor entity IDs must be unique');

export function sensorFallbackName(entityId: string): string {
  return entityId.slice('sensor.'.length).replaceAll('_', ' ');
}

function text(value: unknown, max: number): string | null {
  const parsed = z.string().trim().min(1).max(max).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface HomeAssistantSensorState {
  entityId: string;
  name: string;
  state: string;
  unit: string | null;
  deviceClass: string | null;
  available: boolean;
}

/** Strip all unrelated attributes/timestamps at the server-only API boundary. */
export const homeAssistantSensorStateSchema = z.object({
  entity_id: sensorEntityIdSchema,
  state: z.string().trim().min(1).max(255),
  attributes: z.object({
    friendly_name: z.unknown().optional(),
    unit_of_measurement: z.unknown().optional(),
    device_class: z.unknown().optional(),
  }).optional(),
}).transform((state): HomeAssistantSensorState => ({
  entityId: state.entity_id,
  name: text(state.attributes?.friendly_name, 255) ?? sensorFallbackName(state.entity_id),
  state: state.state,
  unit: text(state.attributes?.unit_of_measurement, 32),
  deviceClass: text(state.attributes?.device_class, 64),
  available: !['unknown', 'unavailable', 'undefined', 'null', 'nan'].includes(state.state.toLowerCase()),
}));

// Validate the list envelope, then ignore malformed individual sensors. A bad
// entity must not prevent selecting other valid sensors in a large HA install.
export const homeAssistantSensorsSchema = z.array(z.object({
  entity_id: z.string().min(1), state: z.unknown().optional(), attributes: z.unknown().optional(),
})).transform((states) => {
  const sensors = states.filter((state) => state.entity_id.startsWith('sensor.'))
    .flatMap((state) => {
      const parsed = homeAssistantSensorStateSchema.safeParse(state);
      return parsed.success ? [parsed.data] : [];
    });
  return [...new Map(sensors.map((sensor) => [sensor.entityId, sensor])).values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
});
