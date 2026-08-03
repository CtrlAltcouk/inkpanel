/*
  inkpanel firmware.

  Wakes on a timer or KEY1, fetches a frame, draws it only if it changed, and
  sleeps for however long the server said. The device holds no opinion about
  scheduling — that lives in TypeScript where it can be tested and changed
  without reflashing.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>

#include "config.h"
#include "secrets.h"
#include "FrameClient.h"
#include "OldV2EPD.h"

OldV2EPD display;

// RTC memory survives deep sleep, so the ETag persists without wearing flash.
RTC_DATA_ATTR char storedEtag[48] = {0};
RTC_DATA_ATTR uint32_t consecutiveFailures = 0;

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

static const char* wakeReason() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_EXT1:  return "button";
    default:                     return "boot";
  }
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

/** Exponential backoff, doubling per consecutive failure up to the cap. */
static uint32_t backoffSeconds() {
  uint32_t seconds = FALLBACK_WAKE_SECONDS;
  for (uint32_t i = 1; i < consecutiveFailures && seconds < MAX_BACKOFF_SECONDS; ++i) {
    seconds *= 2;
  }
  return seconds > MAX_BACKOFF_SECONDS ? MAX_BACKOFF_SECONDS : seconds;
}

[[noreturn]] static void sleepFor(uint32_t seconds) {
  Serial.printf("[sleep] %u seconds\n", seconds);
  Serial.flush();

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  // Panel rail off — the image persists without power.
  pinMode(Hardware::EPD_ENABLE, OUTPUT);
  digitalWrite(Hardware::EPD_ENABLE, LOW);

  // KEY1 wakes for an immediate refresh. GPIO 2 is RTC-capable on the S3, and
  // the buttons are active low, so the pullup must be held through sleep.
  const gpio_num_t key1 = static_cast<gpio_num_t>(Hardware::KEY1);
  rtc_gpio_pullup_en(key1);
  rtc_gpio_pulldown_dis(key1);
  esp_sleep_enable_ext1_wakeup(1ULL << Hardware::KEY1, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(seconds) * 1000000ULL);

  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(300);

  char id[24];
  deviceId(id, sizeof(id));
  const char* reason = wakeReason();
  Serial.printf("\n[inkpanel] %s device=%s wake=%s\n", FIRMWARE_VERSION, id, reason);

  const float volts = readBatteryVoltage();

  if (!connectWifi()) {
    consecutiveFailures++;
    Serial.printf("[wifi] failed (%u consecutive)\n", consecutiveFailures);
    sleepFor(backoffSeconds());
  }

  const FetchOutcome outcome = fetchFrame(
      SERVER_URL, id, display.framebuffer(), OldV2EPD::BUFFER_SIZE,
      storedEtag, volts, reason);

  if (outcome.result == FetchResult::Failed) {
    consecutiveFailures++;
    Serial.printf("[net] failed (%u consecutive), panel untouched\n", consecutiveFailures);
    sleepFor(backoffSeconds());
  }

  consecutiveFailures = 0;

  if (outcome.result == FetchResult::Updated) {
    if (display.begin() && display.display(display.framebuffer())) {
      display.sleep();
      // Only record the ETag once the pixels are actually on the panel.
      snprintf(storedEtag, sizeof(storedEtag), "%s", outcome.etag);
      Serial.println("[epd] drawn");
    } else {
      Serial.printf("[epd] failed: %s\n", display.lastError());
    }
  } else {
    Serial.println("[epd] unchanged, no refresh");
  }

  sleepFor(outcome.nextWakeSeconds);
}

void loop() {}
