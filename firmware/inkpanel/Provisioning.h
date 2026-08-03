#pragma once
#include <Arduino.h>

struct Credentials {
  char ssid[33];
  char password[65];
  char serverUrl[128];
};

/** True when a usable SSID and server URL are stored in NVS. */
bool loadCredentials(Credentials& out);

void clearCredentials();

/**
 * Start a SoftAP captive portal so the panel can be configured from a phone.
 * Reboots once the user saves; never returns.
 */
[[noreturn]] void runProvisioningPortal();
