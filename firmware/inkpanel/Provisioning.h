#pragma once
#include <Arduino.h>

struct Credentials {
  char ssid[33];
  char password[65];
  char serverUrl[128];
};

/** True when a usable SSID and server URL are stored in NVS. */
bool loadCredentials(Credentials& out);

/** Validate and persist credentials in the same NVS keys used by the portal. */
bool saveCredentials(const Credentials& credentials);

void clearCredentials();

/**
 * Wait briefly for the browser flasher to provision this board over USB CDC.
 *
 * Protocol v1 is a single newline-terminated record with base64 fields:
 * INKPANEL_PROVISION_V1|<ssid>|<password>|<server-url>
 *
 * The function emits INKPANEL_READY_V1 while waiting and INKPANEL_SAVED_V1
 * after a successful save. Returns true when credentials were saved, false
 * when the window expires. No external Arduino libraries are required.
 */
bool waitForUsbProvisioning(uint32_t timeoutMs);

/**
 * Start a SoftAP captive portal so the panel can be configured from a phone.
 * This remains the recovery fallback when USB provisioning is not used.
 * Reboots once the user saves; never returns.
 */
[[noreturn]] void runProvisioningPortal();
