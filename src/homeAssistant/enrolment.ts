import type { HomeAssistantClient } from './client.ts';
import type { DeviceEnrolmentDefaultsProvider } from '../http/deviceEnrolment.ts';

/** Deployment adapter; standalone enrolment has no HA dependency. */
export function homeAssistantEnrolmentDefaults(
  enabled: boolean,
  client: HomeAssistantClient,
): DeviceEnrolmentDefaultsProvider | undefined {
  if (!enabled) return undefined;
  return async () => {
    const result = await client.installationLocation();
    return result.available ? result.data : null;
  };
}
