/*
  WiFi diagnostic for the XIAO ESP32-S3.

  Scans for networks, then repeatedly tries to associate with the credentials
  in secrets.h, reporting the status code at each step.

  Run this when association is failing. It separates three very different
  problems that look identical from the inkpanel log:

    - The radio cannot hear anything          -> few or no networks, weak RSSI
    - The network is there but auth fails     -> seen strongly, status 4
    - The network is 5 GHz only               -> not listed at all

  The XIAO ESP32-S3 has a U.FL antenna connector and ships with a small
  antenna that must be plugged in. Without it, expect very few networks and
  RSSI in the -85 dBm and worse range even standing next to the router.
*/
#include <Arduino.h>
#include <WiFi.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID "your-network"
#define WIFI_PASS "your-password"
#endif

static const char* statusName(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS:     return "IDLE (0) — never started associating";
    case WL_NO_SSID_AVAIL:   return "NO_SSID_AVAIL (1) — SSID not found";
    case WL_SCAN_COMPLETED:  return "SCAN_COMPLETED (2)";
    case WL_CONNECTED:       return "CONNECTED (3)";
    case WL_CONNECT_FAILED:  return "CONNECT_FAILED (4) — usually wrong password";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST (5)";
    case WL_DISCONNECTED:    return "DISCONNECTED (6) — associated then dropped";
    default:                 return "unknown";
  }
}

static void scan() {
  Serial.println("\n--- scan ---");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(200);

  const int found = WiFi.scanNetworks();
  if (found <= 0) {
    Serial.println("NO NETWORKS FOUND.");
    Serial.println("If you are near a router, the antenna is almost certainly");
    Serial.println("not connected. Check the U.FL socket on the XIAO module.");
    return;
  }

  Serial.printf("%d networks:\n", found);
  int strongest = -127;
  for (int i = 0; i < found; ++i) {
    const int rssi = WiFi.RSSI(i);
    if (rssi > strongest) strongest = rssi;
    Serial.printf("  %-32s %4d dBm  ch%-3d %s\n",
                  WiFi.SSID(i).c_str(), rssi, WiFi.channel(i),
                  WiFi.SSID(i) == String(WIFI_SSID) ? "  <== target" : "");
  }

  Serial.printf("\nstrongest signal: %d dBm — ", strongest);
  if (strongest > -60)      Serial.println("excellent");
  else if (strongest > -70) Serial.println("good");
  else if (strongest > -80) Serial.println("marginal");
  else                      Serial.println("very poor; suspect a missing antenna");
}

static void tryConnect() {
  Serial.printf("\n--- connecting to '%s' ---\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  for (int elapsed = 0; elapsed < 20; ++elapsed) {
    const wl_status_t s = WiFi.status();
    Serial.printf("  %2ds  %s\n", elapsed, statusName(s));
    if (s == WL_CONNECTED) {
      Serial.printf("\nCONNECTED  ip=%s  rssi=%d dBm  channel=%d\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
      return;
    }
    delay(1000);
  }
  Serial.println("\nFAILED after 20s.");
  WiFi.disconnect(true);
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n\n=== XIAO ESP32-S3 WiFi diagnostic ===");
  Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
  Serial.println("Note: the ESP32 is 2.4 GHz only. A 5 GHz network will not appear.");
}

void loop() {
  scan();
  tryConnect();
  Serial.println("\n(repeating in 10s)");
  delay(10000);
}
