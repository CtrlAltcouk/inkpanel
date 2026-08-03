/*
  inkpanel firmware — bring-up stage.

  Mains/USB powered, WiFi credentials compiled in. Fetches one frame and
  displays it. Deep sleep and on-device provisioning come next; this stage
  exists so the panel, the driver and the HTTP protocol can be verified
  independently of them.
*/
#include <Arduino.h>
#include <WiFi.h>

#include "config.h"
#include "secrets.h"
#include "FrameClient.h"
#include "OldV2EPD.h"

OldV2EPD display;

static float readBatteryVoltage() {
  pinMode(Hardware::BATTERY_ADC_ENABLE_PIN, OUTPUT);
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, HIGH);
  delay(10);
  analogReadResolution(12);
  const float volts =
      (static_cast<float>(analogRead(Hardware::BATTERY_ADC_PIN)) / 4096.0f) * 7.16f;
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, LOW);
  return volts;
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] connect failed");
    return false;
  }
  Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
  return true;
}

static void drawFrame() {
  if (!display.begin()) {
    Serial.printf("[epd] init failed: %s\n", display.lastError());
    return;
  }
  if (!display.display(display.framebuffer())) {
    Serial.printf("[epd] refresh failed: %s\n", display.lastError());
    return;
  }
  display.sleep();
  Serial.println("[epd] drawn; panel power disabled, image persists");
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  char id[24];
  deviceId(id, sizeof(id));
  Serial.printf("\n[inkpanel] %s device=%s\n", FIRMWARE_VERSION, id);

  const float volts = readBatteryVoltage();
  Serial.printf("[batt] %.2f V\n", volts);

  if (!connectWifi()) return;

  const FetchOutcome outcome = fetchFrame(
      SERVER_URL, id, display.framebuffer(), OldV2EPD::BUFFER_SIZE, "", volts, "boot");

  switch (outcome.result) {
    case FetchResult::Updated:
      Serial.printf("[net] new frame, etag=%s next=%us\n",
                    outcome.etag, outcome.nextWakeSeconds);
      drawFrame();
      break;
    case FetchResult::NotModified:
      Serial.println("[epd] unchanged, panel left alone");
      break;
    case FetchResult::Failed:
      Serial.println("[epd] fetch failed, panel left alone");
      break;
  }
}

void loop() {
  delay(1000);
}
