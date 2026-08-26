export type UpdateMode = 'self' | 'home-assistant';

export const HOME_ASSISTANT_UPDATE_ERROR = 'updates are managed by Home Assistant';

export interface ManagedUpdateInfo {
  state: 'managed';
  manager: 'home-assistant';
}

export function updateModeForDeployment(homeAssistantMode: boolean): UpdateMode {
  return homeAssistantMode ? 'home-assistant' : 'self';
}

export function managedUpdateInfo(): ManagedUpdateInfo {
  return { state: 'managed', manager: 'home-assistant' };
}
