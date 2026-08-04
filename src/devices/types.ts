export interface DeviceRecord {
  id: string;
  name: string;
  claimed: boolean;

  timezone: string;
  latitude: number;
  longitude: number;
  calendarUrls: string[];
  panelProfileId: string;

  /** Local hour, 0-23, when quiet hours begin and end. */
  quietHoursStart: number;
  quietHoursEnd: number;
  activeIntervalSeconds: number;
  lowBatteryIntervalSeconds: number;
  lowBatteryVolts: number;
  unclaimedIntervalSeconds: number;

  lastSeenAt: string | null;
  lastBatteryVolts: number | null;
  lastEtag: string | null;
  lastFirmwareVersion: string | null;

  /** Human-readable location from the city picker, e.g. "Milton Keynes, England, GB". */
  locationLabel: string;

  /**
   * What the device was last told to sleep for. Combined with lastSeenAt this
   * gives the next expected check-in, which Push reports back to the user.
   */
  lastWakeSeconds: number | null;
}

export function defaultDevice(id: string): DeviceRecord {
  return {
    id,
    name: 'Unnamed panel',
    claimed: false,
    timezone: 'Europe/London',
    latitude: 52.04,
    longitude: -0.76,
    calendarUrls: [],
    panelProfileId: 'wft0583-800x480-mono',
    quietHoursStart: 23,
    quietHoursEnd: 6,
    activeIntervalSeconds: 900,
    lowBatteryIntervalSeconds: 21600,
    lowBatteryVolts: 3.5,
    unclaimedIntervalSeconds: 60,
    lastSeenAt: null,
    lastBatteryVolts: null,
    lastEtag: null,
    lastFirmwareVersion: null,
    locationLabel: '',
    lastWakeSeconds: null,
  };
}
