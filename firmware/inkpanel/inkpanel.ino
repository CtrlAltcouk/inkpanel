/*
  inkpanel firmware.

  Wakes on a timer or KEY1, fetches a frame, draws it only if it changed, and
  sleeps for however long the server said. The device holds no opinion about
  scheduling — that lives in TypeScript where it can be tested and changed
  without reflashing.

  First boot with no stored credentials opens a captive portal.
  Hold KEY3 while resetting to wipe credentials and return to it.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>

#include "config.h"
#include "FrameClient.h"
#include "OldV2EPD.h"
#include "Provisioning.h"

// Optional development shortcut. Copy secrets.example.h to secrets.h to skip
// the portal on your own bench; the repo compiles and works without it.
#if __has_include("secrets.h")
#include "secrets.h"
#define HAVE_COMPILED_CREDENTIALS 1
#endif

OldV2EPD display;
static Credentials credentials;

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
  WiFi.setSleep(false);  // association is more reliable with modem sleep off

  for (uint8_t attempt = 1; attempt <= WIFI_ATTEMPTS; ++attempt) {
    WiFi.begin(credentials.ssid, credentials.password);
    const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
    while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[wifi] connected on attempt %u, ip=%s rssi=%d\n",
                    attempt, WiFi.localIP().toString().c_str(), WiFi.RSSI());
      return true;
    }

    // A failed association can leave the stack in a state a plain retry does
    // not clear, so tear it down before trying again.
    Serial.printf("[wifi] attempt %u failed (status %d)\n", attempt, WiFi.status());
    WiFi.disconnect(true);
    delay(500);
  }
  return false;
}

/** Exponential backoff, doubling per consecutive failure up to the cap. */
static uint32_t backoffSeconds() {
  uint32_t seconds = FALLBACK_WAKE_SECONDS;
  for (uint32_t i = 1; i < consecutiveFailures && seconds < MAX_BACKOFF_SECONDS; ++i) {
    seconds *= 2;
  }
  return seconds > MAX_BACKOFF_SECONDS ? MAX_BACKOFF_SECONDS : seconds;
}

/*
  Deliberately not marked [[noreturn]], though it never returns.

  The Arduino build system auto-generates prototypes for functions defined in
  .ino files and injects them above the sketch. Those generated prototypes drop
  attributes, so GCC sees a first declaration without [[noreturn]] followed by a
  definition with it and errors out. Functions in .cpp files are unaffected,
  which is why runProvisioningPortal keeps its attribute.
*/
static void sleepFor(uint32_t seconds) {
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

/** Load credentials from NVS, or from secrets.h if one was compiled in. */
static bool obtainCredentials() {
#ifdef HAVE_COMPILED_CREDENTIALS
  snprintf(credentials.ssid, sizeof(credentials.ssid), "%s", WIFI_SSID);
  snprintf(credentials.password, sizeof(credentials.password), "%s", WIFI_PASS);
  snprintf(credentials.serverUrl, sizeof(credentials.serverUrl), "%s", SERVER_URL);
  Serial.println("[setup] using credentials compiled from secrets.h");
  return true;
#else
  return loadCredentials(credentials);
#endif
}

void setup() {
  Serial.begin(115200);
  delay(300);

  char id[24];
  deviceId(id, sizeof(id));
  const char* reason = wakeReason();
  Serial.printf("\n[inkpanel] %s device=%s wake=%s\n", FIRMWARE_VERSION, id, reason);

  // KEY3 held at boot wipes stored credentials. Checked before anything else
  // so a bad server address cannot lock the panel out of being reconfigured.
  pinMode(Hardware::KEY3, INPUT_PULLUP);
  delay(50);
  if (digitalRead(Hardware::KEY3) == LOW) {
    Serial.println("[setup] KEY3 held — clearing credentials");
    clearCredentials();
    runProvisioningPortal();
  }

  if (!obtainCredentials()) {
    Serial.println("[setup] no credentials stored — starting portal");
    runProvisioningPortal();
  }

  const float volts = readBatteryVoltage();

  if (!connectWifi()) {
    consecutiveFailures++;
    Serial.printf("[wifi] failed (%u consecutive)\n", consecutiveFailures);
    sleepFor(backoffSeconds());
  }

  const FetchOutcome outcome = fetchFrame(
      credentials.serverUrl, id, display.framebuffer(), OldV2EPD::BUFFER_SIZE,
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
