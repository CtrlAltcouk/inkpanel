#pragma once
#include <stdint.h>

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

constexpr uint32_t EPD_BUSY_TIMEOUT_MS = 60'000;

// Association can be slow straight out of reset, and one retry costs little
// against the alternative of sleeping for 15 minutes.
constexpr uint32_t WIFI_TIMEOUT_MS = 20'000;
constexpr uint8_t  WIFI_ATTEMPTS = 2;

// Generous: the server may be cold-starting Chromium, which on a small
// container can take longer than a panel expects a web request to.
constexpr uint32_t HTTP_TIMEOUT_MS = 45'000;

// Used only when the server is unreachable and cannot dictate a schedule.
constexpr uint32_t FALLBACK_WAKE_SECONDS = 900;
constexpr uint32_t MAX_BACKOFF_SECONDS = 3600;

// Bumped whenever behaviour visible on the physical panel changes. Keeping
// this distinct makes serial output a quick proof that WebFlash served the
// build we intended rather than a stale firmware/dist package.
constexpr const char* FIRMWARE_VERSION = "0.1.2";
