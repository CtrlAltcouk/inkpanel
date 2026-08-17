export interface PanelProfile {
  id: string;
  width: number;
  height: number;
  bitDepth: 1;
  bitOrder: 'msb-first';
  /** Bit value that means "ink on paper" on the InkPanel wire framebuffer. */
  inkBit: 1;
  /** Bytes per row. */
  stride: number;
  /** Total packed buffer size. */
  bytes: number;
  /** Number of dashboard widgets this physical display can present. */
  dashboardSlots: 1 | 4;
}

/**
 * Good Display GDEW075T7 / flex WFT0583CZ61, driven by the Waveshare old-V2
 * sequence. This layout is byte-for-byte what MonoCanvas already uses, so the
 * firmware copies the response straight into the framebuffer.
 */
export const WFT0583: PanelProfile = {
  id: 'wft0583-800x480-mono',
  width: 800,
  height: 480,
  bitDepth: 1,
  bitOrder: 'msb-first',
  inkBit: 1,
  stride: 100,
  bytes: 48000,
  dashboardSlots: 4,
};

/**
 * 1.54-inch 200×200 monochrome SSD1681 panel on Seeed's ePaper Driver Board
 * for XIAO. The server wire format stays logical row-major MSB-first with an
 * ink bit of 1; the firmware display driver owns any SSD1681-specific
 * inversion/orientation required by the controller.
 */
export const SSD1681_200X200: PanelProfile = {
  id: 'ssd1681-200x200-mono',
  width: 200,
  height: 200,
  bitDepth: 1,
  bitOrder: 'msb-first',
  inkBit: 1,
  stride: 25,
  bytes: 5000,
  dashboardSlots: 1,
};

export const PROFILES: Readonly<Record<string, PanelProfile>> = {
  [WFT0583.id]: WFT0583,
  [SSD1681_200X200.id]: SSD1681_200X200,
};

export function panelProfile(id: string): PanelProfile | null {
  return PROFILES[id] ?? null;
}
