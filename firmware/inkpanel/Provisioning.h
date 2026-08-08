#pragma once
#include <Arduino.h>

struct Credentials {
  char ssid[33];
  char password[65];
  char serverUrl[128];
};

/** True when a usable SSID and server URL are stored in NVS. */
bool loadCredentials(Credentials& out);

/** Validate and persist credentials in the same NVS keys used by every setup path. */
bool saveCredentials(const Credentials& credentials);

void clearCredentials();

/**
 * Give the browser flasher an initial window to provision this board over USB CDC.
 *
 * Protocol v1 is a single newline-terminated record with base64 fields:
 * INKPANEL_PROVISION_V1|<ssid>|<password>|<server-url>
 *
 * The function emits INKPANEL_READY_V1 while waiting and INKPANEL_SAVED_V1
 * after a successful save. Returns true when credentials were saved, false
 * when the initial window expires. USB provisioning remains available later
 * from runProvisioningPortal(), so missing this window never forces a reflash.
 */
bool waitForUsbProvisioning(uint32_t timeoutMs);

/**
 * Start the recovery setup mode for an unconfigured board.
 *
 * A SoftAP/captive page is kept for recovery, but the same USB provisioning
 * protocol remains active indefinitely at the same time. A user can therefore
 * configure the board from the InkPanel Flash page without ever joining the
 * temporary 192.168.4.1 network. Reboots once either setup path saves settings;
 * never returns.
 */
[[noreturn]] void runProvisioningPortal();
