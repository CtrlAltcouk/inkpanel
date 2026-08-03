#include "FrameClient.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_mac.h>

#include "config.h"

void deviceId(char* out, size_t len) {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(out, len, "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

FetchOutcome fetchFrame(const char* serverUrl,
                        const char* id,
                        uint8_t* framebuffer,
                        size_t bufferSize,
                        const char* currentEtag,
                        float batteryVolts,
                        const char* wakeReason) {
  FetchOutcome outcome{FetchResult::Failed, FALLBACK_WAKE_SECONDS, {0}};

  char url[224];
  snprintf(url, sizeof(url), "%s/api/devices/%s/frame", serverUrl, id);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(url)) {
    Serial.println("[net] http.begin failed");
    return outcome;
  }

  char volts[16];
  snprintf(volts, sizeof(volts), "%.2f", batteryVolts);
  http.addHeader("X-Battery-Voltage", volts);
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);
  http.addHeader("X-Wake-Reason", wakeReason);
  if (currentEtag && currentEtag[0]) http.addHeader("If-None-Match", currentEtag);

  // HTTPClient discards response headers unless asked to keep them.
  const char* wanted[] = {"ETag", "X-Next-Wake-Seconds"};
  http.collectHeaders(wanted, 2);

  const int status = http.GET();
  Serial.printf("[net] GET %s -> %d\n", url, status);

  if (status > 0) {
    const String wake = http.header("X-Next-Wake-Seconds");
    if (wake.length() > 0) {
      const long parsed = wake.toInt();
      if (parsed > 0) outcome.nextWakeSeconds = static_cast<uint32_t>(parsed);
    }
    snprintf(outcome.etag, sizeof(outcome.etag), "%s", http.header("ETag").c_str());
  }

  if (status == HTTP_CODE_NOT_MODIFIED) {
    outcome.result = FetchResult::NotModified;
    http.end();
    return outcome;
  }

  if (status != HTTP_CODE_OK) {
    http.end();
    return outcome;
  }

  const int length = http.getSize();
  if (length != static_cast<int>(bufferSize)) {
    Serial.printf("[net] expected %u bytes, server said %d\n",
                  static_cast<unsigned>(bufferSize), length);
    http.end();
    return outcome;
  }

  // Read the whole frame before touching the panel: a truncated read must not
  // become a half-drawn screen.
  WiFiClient* stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t lastProgress = millis();
  while (received < bufferSize) {
    const int available = stream->available();
    if (available <= 0) {
      if (!stream->connected() || millis() - lastProgress > HTTP_TIMEOUT_MS) break;
      delay(1);
      continue;
    }
    size_t want = bufferSize - received;
    if (static_cast<size_t>(available) < want) want = static_cast<size_t>(available);
    const int read = stream->readBytes(framebuffer + received, want);
    if (read <= 0) break;
    received += static_cast<size_t>(read);
    lastProgress = millis();
  }
  http.end();

  if (received != bufferSize) {
    Serial.printf("[net] short read: %u of %u\n",
                  static_cast<unsigned>(received), static_cast<unsigned>(bufferSize));
    return outcome;
  }

  outcome.result = FetchResult::Updated;
  return outcome;
}
