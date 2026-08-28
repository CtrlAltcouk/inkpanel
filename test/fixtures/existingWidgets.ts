import type { DashboardSectionData } from '../../src/model/dashboard.ts';
import { offlinePrinter } from '../../src/printers/moonraker.ts';
import { dashboardData } from './dashboard.ts';

/** Fixed pre-HA-4 cases for exact legacy template-output regression checks. */
export function existingWidgets(): DashboardSectionData[] {
  return [
    ...dashboardData().sections.slice(0, 2),
    { type: 'trains', data: null, health: null },
    { type: 'bus', data: null, health: null },
    { type: 'traffic', data: null, health: null },
    { type: 'octopus', data: null, health: null },
    { type: 'todo', data: { items: ['Buy milk', 'Take bins out'] }, configured: true, health: null },
    { type: 'bins', data: null, health: null },
    { type: 'printers', data: { printers: [offlinePrinter('Workshop')] }, configured: true, health: null },
    { type: 'empty' },
  ];
}
