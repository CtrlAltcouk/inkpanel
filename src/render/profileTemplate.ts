import type {
  DashboardData,
  MiniDashboardData,
  ProfileDashboardData,
} from '../model/dashboard.ts';
import { SSD1681_200X200, type PanelProfile } from '../panel/profile.ts';
import { renderMiniHtml } from './miniTemplate.ts';
import { renderHtml } from './template.ts';

function isMiniData(data: ProfileDashboardData): data is MiniDashboardData {
  return data.sections.length === 1;
}

function isLargeData(data: ProfileDashboardData): data is DashboardData {
  return data.sections.length === 4;
}

/**
 * Pick a renderer by physical display profile.
 *
 * The existing WFT/800×480 path deliberately calls the original renderHtml
 * function unchanged. New display classes live beside it rather than changing
 * its layout or scaling its output.
 */
export function renderProfileHtml(
  data: ProfileDashboardData,
  profile: PanelProfile,
  fontCss: string,
): string {
  if (profile.id === SSD1681_200X200.id) {
    if (!isMiniData(data)) throw new Error('Mini profile requires exactly one dashboard section');
    return renderMiniHtml(data, profile, fontCss);
  }
  if (!isLargeData(data)) throw new Error(`${profile.id} requires exactly four dashboard sections`);
  return renderHtml(data, profile, fontCss);
}
