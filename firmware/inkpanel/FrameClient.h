#pragma once
#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

enum class FetchResult { Updated, NotModified, Failed };

struct FetchOutcome {
  FetchResult result;
  uint32_t nextWakeSeconds;
  char etag[48];
};

/** Build a stable device id from the WiFi MAC: "esp32-a1b2c3". */
void deviceId(char* out, size_t len);

/**
 * Fetch a frame into `framebuffer`.
 * On NotModified or Failed the buffer is left untouched, so the panel keeps
 * whatever it is already showing.
 *
 * `panelProfileId` is optional for backwards compatibility. Existing 0.1.4
 * large-panel firmware historically sent no profile header; Mini firmware sends
 * its profile explicitly so a new device enrols with the correct wire format.
 */
FetchOutcome fetchFrame(const char* serverUrl,
                        const char* id,
                        uint8_t* framebuffer,
                        size_t bufferSize,
                        const char* currentEtag,
                        float batteryVolts,
                        const char* wakeReason,
                        const char* panelProfileId);
