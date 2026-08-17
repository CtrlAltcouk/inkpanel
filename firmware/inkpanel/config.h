#pragma once
#include <stdint.h>

#ifndef INKPANEL_MINI

// XIAO ePaper Display Board EE04 (ESP32-S3 Plus). Unchanged from the working
// EE04_WFT0583CZ61_OldV2_Test sketch.
namespace Hardware {
constexpr int EPD_SCLK   = 7;   // XIAO D8
constexpr int EPD_MOSI   = 9;   // XIAO D10
constexpr int EPD_CS     = 44;  // Board D7
constexpr int EPD_DC     = 10;  // Board D16
constexpr int EPD_BUSY   = 4;   // Board D3, active LOW for this old-V2 driver
constexpr int EPD_RST    = 38;  // Board D11
constexpr int EPD_ENABLE = 43;  // Board D6, display power enable

constexpr int KEY1 = 2;  // refresh now (wakes from deep sleep)
constexpr int KEY2 = 3;  // reserved
constexpr int KEY3 = 5;  // hold at boot to clear credentials

constexpr int BATTERY_ADC_PIN = 1;
constexpr int BATTERY_ADC_ENABLE_PIN = 6;

constexpr uint32_t SPI_HZ = 4'000'000;
}

constexpr bool HAS_EPD_POWER_ENABLE = true;
constexpr bool HAS_WAKE_BUTTON = true;
constexpr bool HAS_FACTORY_RESET_BUTTON = true;
constexpr bool HAS_BATTERY_ADC = true;

// Firmware 0.1.4 predates profile advertisement. Keep the default large-panel
// request byte-for-byte compatible and let the server's missing-header fallback
// identify it as wft0583-800x480-mono.
constexpr const char* PANEL_PROFILE_ID = nullptr;

// Bumped whenever behaviour visible on the physical panel changes. Keeping
// this distinct makes serial output a quick proof that WebFlash served the
// build we intended rather than a stale firmware/dist package.
//
// Keep the full-size literal first in this file: firmware-manifest.mjs reads the
// default production version without preprocessing config.h.
constexpr const char* FIRMWARE_VERSION = "0.1.4";

#else

// InkPanel Mini:
//   Seeed Studio XIAO ESP32-S3 (standard 8 MB board)
//   Seeed ePaper Driver Board for XIAO
//   1.54-inch 200x200 monochrome SSD1681 panel
//
// Seeed's driver board routes the panel connector to XIAO D0/D1/D2/D3/D8/D10.
// The raw GPIO values below are the standard XIAO ESP32-S3 pin mapping.
namespace Hardware {
constexpr int EPD_RST  = 1;  // XIAO D0
constexpr int EPD_CS   = 2;  // XIAO D1
constexpr int EPD_BUSY = 3;  // XIAO D2, SSD1681 BUSY is active HIGH
constexpr int EPD_DC   = 4;  // XIAO D3
constexpr int EPD_SCLK = 7;  // XIAO D8
constexpr int EPD_MOSI = 9;  // XIAO D10

constexpr uint32_t SPI_HZ = 4'000'000;
}

constexpr bool HAS_EPD_POWER_ENABLE = false;
constexpr bool HAS_WAKE_BUTTON = false;
constexpr bool HAS_FACTORY_RESET_BUTTON = false;
constexpr bool HAS_BATTERY_ADC = false;
constexpr const char* PANEL_PROFILE_ID = "ssd1681-200x200-mono";
constexpr const char* FIRMWARE_VERSION = "0.2.0-mini.1";

#endif

constexpr uint32_t EPD_BUSY_TIMEOUT_MS = 60'000;

// Association can be slow straight out of reset, and one retry costs little
// against the alternative of sleeping for 15 minutes.
constexpr uint32_t WIFI_TIMEOUT_MS = 20'000;
constexpr uint8_t  WIFI_ATTEMPTS = 2;

// Generous: the server may be cold-starting Chromium, which on a small
// container can take longer than a panel expects a web request to.
constexpr uint32_t HTTP_TIMEOUT_MS = 45'000;

// Used when a wake cycle cannot complete successfully. Wi-Fi, frame-fetch and
// display-refresh failures share the same RTC-persisted exponential streak so
// repeated hardware faults back off instead of following the normal schedule.
constexpr uint32_t FALLBACK_WAKE_SECONDS = 900;
constexpr uint32_t MAX_BACKOFF_SECONDS = 3600;
