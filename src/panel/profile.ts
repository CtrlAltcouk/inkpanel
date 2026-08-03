export interface PanelProfile {
  id: string;
  width: number;
  height: number;
  bitDepth: 1;
  bitOrder: 'msb-first';
  /** Bit value that means "ink on paper". */
  inkBit: 1;
  /** Bytes per row. */
  stride: number;
  /** Total packed buffer size. */
  bytes: number;
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
};

export const PROFILES: Record<string, PanelProfile> = {
  [WFT0583.id]: WFT0583,
};
