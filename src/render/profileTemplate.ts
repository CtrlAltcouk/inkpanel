import type { DashboardData } from '../model/dashboard.ts';
import { SSD1681_200X200, type PanelProfile } from '../panel/profile.ts';
import { renderMiniHtml } from './miniTemplate.ts';
import { renderHtml } from './template.ts';

/**
 * Pick a renderer by physical display profile.
 *
 * The existing WFT/800×480 path deliberately calls the original renderHtml
 * function unchanged. New display classes live beside it rather than changing
 * its layout or scaling its output.
 */
export function renderProfileHtml(
  data: DashboardData,
  profile: PanelProfile,
  fontCss: string,
): string {
  if (profile.id === SSD1681_200X200.id) {
    return renderMiniHtml(data, profile, fontCss);
  }
  return renderHtml(data, profile, fontCss);
}
