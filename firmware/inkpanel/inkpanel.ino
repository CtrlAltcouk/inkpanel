/*
  inkpanel firmware.

  Wakes on a timer or KEY1, fetches a frame, draws it only if it changed, and
  sleeps for however long the server said. The device holds no opinion about
  scheduling — that lives in TypeScript where it can be tested and changed
  without reflashing.

  First boot with no stored credentials first imports the one-time provisioning
  record written during WebFlash. USB provisioning and the captive portal stay
  available as recovery paths. Hold KEY3 while resetting to wipe credentials.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>

#include "config.h"
#include "FlashProvisioning.h"
#include "FrameClient.h"
#include "OldV2EPD.h"
#include "Provisioning.h"

// Optional development shortcut. Copy secrets.example.h to secrets.h to skip
// provisioning on your own bench; the repo compiles and works without it.
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

  pinMode(Hardware::EPD_ENABLE, OUTPUT);
  digitalWrite(Hardware::EPD_ENABLE, LOW);

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

  // KEY3 is a genuine factory-configuration reset: clear both durable NVS and
  // any one-time WebFlash record so a pending record cannot immediately put
  // credentials back after the user deliberately wiped them.
  pinMode(Hardware::KEY3, INPUT_PULLUP);
  delay(50);
  if (digitalRead(Hardware::KEY3) == LOW) {
    Serial.println("[setup] KEY3 held — clearing credentials and one-time setup record");
    clearCredentials();
    clearFlashProvisioning();
    runProvisioningPortal();
  }

  if (!obtainCredentials()) {
    // Normal new-board setup is now completed entirely inside the flash
    // operation: the browser writes a CRC-protected record into the dedicated
    // provisioning partition. Import it before depending on USB re-enumeration.
    Serial.println("[setup] no credentials stored — checking flash-time provisioning");
    if (importFlashProvisioning() && obtainCredentials()) {
      Serial.println("[setup] flash-time credentials imported");
    } else {
      // USB remains a recovery path for an already-flashed unconfigured board.
      Serial.println("[setup] no flash-time credentials — waiting for USB provisioning");
      if (waitForUsbProvisioning(30000) && obtainCredentials()) {
        Serial.println("[setup] USB credentials saved");
      } else {
        Serial.println("[setup] no USB credentials received — starting portal fallback");
        runProvisioningPortal();
      }
    }
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
