import { z } from 'zod';
import { calendarEntityIdsSchema } from '../homeAssistant/calendarSchemas.ts';
import { todoEntityIdSchema } from '../homeAssistant/todoSchemas.ts';
import { homeAssistantUserIdSchema } from '../homeAssistant/ingressUser.ts';
import { sensorEntityIdsSchema } from '../homeAssistant/sensorSchemas.ts';

export const entitiesWidgetConfigV1Schema = z.strictObject({ entityIds: sensorEntityIdsSchema });
export const entitiesWidgetV1Schema = z.strictObject({
  type: z.literal('entities'), version: z.literal(1), config: entitiesWidgetConfigV1Schema,
});

/** Persisted calendar URLs stay broad so existing private feeds remain readable. */
export const calendarWidgetConfigV1Schema = z.strictObject({
  calendarUrls: z.array(z.string().url()).max(10),
});

export const calendarWidgetConfigV2Schema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('ical'), calendarUrls: z.array(z.string().url()).max(10) }),
  z.strictObject({ provider: z.literal('home-assistant'), entityIds: calendarEntityIdsSchema }),
]);

export const calendarWidgetV2Schema = z.strictObject({
  type: z.literal('calendar'), version: z.literal(2), config: calendarWidgetConfigV2Schema,
});

export const weatherWidgetConfigV1Schema = z.strictObject({});

const crsSchema = z.string().regex(/^(?:|[A-Z]{3})$/, 'CRS must be empty or three uppercase letters');

export const trainsWidgetConfigV1Schema = z.strictObject({
  originCrs: crsSchema,
  destinationCrs: crsSchema,
});

// DfT NaPTAN: first three authority digits, fourth character 0, followed by
// one to eight locally allocated alphanumeric characters (maximum size 12).
const busStopCodeSchema = z.string().regex(
  /^(?:|\d{3}0[A-Za-z0-9]{1,8})$/,
  'ATCO stop code must be empty or use the NaPTAN ATCO format',
);

export const busWidgetConfigV1Schema = z.strictObject({
  stopCode: busStopCodeSchema,
  stopLabel: z.string().max(80),
  routeFilter: z.string().max(32),
});

export const trafficWidgetConfigV1Schema = z.strictObject({
  origin: z.string().max(200),
  destination: z.string().max(200),
});

const octopusTariffCodeSchema = z.string().regex(
  /^(?:|E-1R-AGILE-[A-Z0-9-]+-[A-Z])$/,
  'Octopus Agile tariff code must be empty or look like E-1R-AGILE-24-10-01-C',
);

export const octopusWidgetConfigV1Schema = z.strictObject({
  tariffCode: octopusTariffCodeSchema,
});

export const todoWidgetConfigV1Schema = z.strictObject({
  listId: z.string().regex(/^(?:|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/, 'invalid To Do list id'),
});

export const todoWidgetConfigV2Schema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('local'), listId: todoWidgetConfigV1Schema.shape.listId }),
  z.strictObject({ provider: z.literal('home-assistant'), entityId: z.union([z.literal(''), todoEntityIdSchema]) }),
]);
export const todoWidgetV2Schema = z.strictObject({
  type: z.literal('todo'), version: z.literal(2), config: todoWidgetConfigV2Schema,
});
export const todoWidgetV3Schema = z.strictObject({
  type: z.literal('todo'), version: z.literal(3), config: z.discriminatedUnion('provider', [
    z.strictObject({ provider: z.literal('local'), listId: todoWidgetConfigV1Schema.shape.listId }),
    z.strictObject({ provider: z.literal('home-assistant'), ownerUserId: homeAssistantUserIdSchema, entityId: todoEntityIdSchema }),
  ]),
});

export const printersWidgetConfigV1Schema = z.strictObject({
  printerIds: z.array(z.string().uuid('invalid printer id')).max(4)
    .refine((ids) => new Set(ids).size === ids.length, 'printer IDs must be unique'),
});

export const binsWidgetConfigV1Schema = z.strictObject({
  uprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits'),
});

export const emptyWidgetConfigV1Schema = z.strictObject({});

export const calendarWidgetV1Schema = z.strictObject({
  type: z.literal('calendar'),
  version: z.literal(1),
  config: calendarWidgetConfigV1Schema,
});
export const weatherWidgetV1Schema = z.strictObject({
  type: z.literal('weather'),
  version: z.literal(1),
  config: weatherWidgetConfigV1Schema,
});
export const trainsWidgetV1Schema = z.strictObject({
  type: z.literal('trains'),
  version: z.literal(1),
  config: trainsWidgetConfigV1Schema,
});
export const busWidgetV1Schema = z.strictObject({
  type: z.literal('bus'),
  version: z.literal(1),
  config: busWidgetConfigV1Schema,
});
export const trafficWidgetV1Schema = z.strictObject({
  type: z.literal('traffic'),
  version: z.literal(1),
  config: trafficWidgetConfigV1Schema,
});
export const octopusWidgetV1Schema = z.strictObject({
  type: z.literal('octopus'),
  version: z.literal(1),
  config: octopusWidgetConfigV1Schema,
});
export const todoWidgetV1Schema = z.strictObject({
  type: z.literal('todo'),
  version: z.literal(1),
  config: todoWidgetConfigV1Schema,
});
export const printersWidgetV1Schema = z.strictObject({
  type: z.literal('printers'),
  version: z.literal(1),
  config: printersWidgetConfigV1Schema,
});
export const binsWidgetV1Schema = z.strictObject({
  type: z.literal('bins'),
  version: z.literal(1),
  config: binsWidgetConfigV1Schema,
});
export const emptyWidgetV1Schema = z.strictObject({
  type: z.literal('empty'),
  version: z.literal(1),
  config: emptyWidgetConfigV1Schema,
});

export type DashboardWidget =
  | z.infer<typeof entitiesWidgetV1Schema>
  | z.infer<typeof calendarWidgetV1Schema>
  | z.infer<typeof calendarWidgetV2Schema>
  | z.infer<typeof weatherWidgetV1Schema>
  | z.infer<typeof trainsWidgetV1Schema>
  | z.infer<typeof busWidgetV1Schema>
  | z.infer<typeof trafficWidgetV1Schema>
  | z.infer<typeof octopusWidgetV1Schema>
  | z.infer<typeof todoWidgetV1Schema>
  | z.infer<typeof todoWidgetV2Schema>
  | z.infer<typeof todoWidgetV3Schema>
  | z.infer<typeof printersWidgetV1Schema>
  | z.infer<typeof binsWidgetV1Schema>
  | z.infer<typeof emptyWidgetV1Schema>;

/** Current runtime registry, explicitly keyed by widget type and version. */
export const widgetRegistry = {
  entities: { 1: entitiesWidgetV1Schema },
  calendar: { 1: calendarWidgetV1Schema, 2: calendarWidgetV2Schema },
  weather: { 1: weatherWidgetV1Schema },
  trains: { 1: trainsWidgetV1Schema },
  bus: { 1: busWidgetV1Schema },
  traffic: { 1: trafficWidgetV1Schema },
  octopus: { 1: octopusWidgetV1Schema },
  todo: { 1: todoWidgetV1Schema, 2: todoWidgetV2Schema, 3: todoWidgetV3Schema },
  printers: { 1: printersWidgetV1Schema },
  bins: { 1: binsWidgetV1Schema },
  empty: { 1: emptyWidgetV1Schema },
} as const;

const widgetEnvelopeSchema = z.strictObject({
  type: z.string().min(1),
  version: z.number().int().positive(),
  config: z.unknown(),
});

/**
 * Parse through the registry so a future calendar v2 is just another entry
 * under calendar, without changing DeviceStore V2.
 */
export const dashboardWidgetSchema: z.ZodType<DashboardWidget> = widgetEnvelopeSchema.transform(
  (widget, ctx) => {
    const versions = widgetRegistry[widget.type as keyof typeof widgetRegistry];
    if (!versions) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: `unknown widget type: ${widget.type}` });
      return z.NEVER;
    }
    const parser = (versions as unknown as Record<number, z.ZodType<DashboardWidget>>)[widget.version];
    if (!parser) {
      ctx.addIssue({
        code: 'custom', path: ['version'],
        message: `unsupported ${widget.type} widget version: ${widget.version}`,
      });
      return z.NEVER;
    }
    const parsed = parser.safeParse(widget);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return parsed.data;
  },
);

export const dashboardSectionsSchema = z.tuple([
  dashboardWidgetSchema,
  dashboardWidgetSchema,
  dashboardWidgetSchema,
  dashboardWidgetSchema,
]);

export type DashboardSections = z.infer<typeof dashboardSectionsSchema>;

export const DEFAULT_DASHBOARD_SECTIONS: DashboardSections = [
  { type: 'calendar', version: 1, config: { calendarUrls: [] } },
  { type: 'weather', version: 1, config: {} },
  { type: 'trains', version: 1, config: { originCrs: '', destinationCrs: '' } },
  { type: 'bins', version: 1, config: { uprn: '' } },
];
