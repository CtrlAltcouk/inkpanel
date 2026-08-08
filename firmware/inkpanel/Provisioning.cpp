#include "Provisioning.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <mbedtls/base64.h>

#include "config.h"

namespace {

constexpr const char* NVS_NAMESPACE = "inkpanel";
constexpr const char* AP_SSID = "inkpanel-setup";

constexpr const char* USB_READY = "INKPANEL_READY_V1";
constexpr const char* USB_SAVED = "INKPANEL_SAVED_V1";
constexpr const char* USB_ERROR = "INKPANEL_ERROR_V1|";
constexpr const char* USB_PREFIX = "INKPANEL_PROVISION_V1|";
constexpr size_t MAX_USB_LINE = 640;
constexpr uint32_t USB_READY_INTERVAL_MS = 1000;

Preferences prefs;
DNSServer dns;
WebServer web(80);
String usbLine;
uint32_t lastUsbReady = 0;

bool validCredentials(const Credentials& credentials) {
  if (credentials.ssid[0] == '\0' || credentials.serverUrl[0] == '\0') return false;
  // Panel check-ins intentionally use the server's plain-HTTP listener. The
  // HTTPS listener has a local/self-signed certificate and exists for the
  // browser Flash tab, not for the ESP32 HTTP client.
  return strncmp(credentials.serverUrl, "http://", 7) == 0;
}

bool decodeBase64Field(const String& encoded, char* output, size_t outputSize) {
  if (outputSize < 2) return false;

  size_t decodedLength = 0;
  const int rc = mbedtls_base64_decode(
      reinterpret_cast<unsigned char*>(output), outputSize - 1, &decodedLength,
      reinterpret_cast<const unsigned char*>(encoded.c_str()), encoded.length());
  if (rc != 0 || decodedLength >= outputSize) return false;

  output[decodedLength] = '\0';
  // NVS/WiFi credentials are C strings. Embedded NULs would otherwise make
  // the browser and firmware disagree about what was saved, so reject them.
  return strlen(output) == decodedLength;
}

bool handleUsbProvisionLine(const String& line) {
  if (!line.startsWith(USB_PREFIX)) return false;

  const int first = line.indexOf('|');
  const int second = line.indexOf('|', first + 1);
  const int third = line.indexOf('|', second + 1);
  if (first < 0 || second < 0 || third < 0 || line.indexOf('|', third + 1) >= 0) {
    Serial.printf("%smalformed\n", USB_ERROR);
    return false;
  }

  Credentials incoming{};
  if (!decodeBase64Field(line.substring(first + 1, second), incoming.ssid, sizeof(incoming.ssid))) {
    Serial.printf("%sssid\n", USB_ERROR);
    return false;
  }
  if (!decodeBase64Field(line.substring(second + 1, third), incoming.password, sizeof(incoming.password))) {
    Serial.printf("%spassword\n", USB_ERROR);
    return false;
  }
  if (!decodeBase64Field(line.substring(third + 1), incoming.serverUrl, sizeof(incoming.serverUrl))) {
    Serial.printf("%sserver-url\n", USB_ERROR);
    return false;
  }
  if (!validCredentials(incoming)) {
    Serial.printf("%sinvalid-credentials\n", USB_ERROR);
    return false;
  }

  if (!saveCredentials(incoming)) {
    Serial.printf("%snvs-write\n", USB_ERROR);
    return false;
  }

  Serial.println(USB_SAVED);
  Serial.flush();
  return true;
}

void resetUsbProvisioningState() {
  usbLine = "";
  usbLine.reserve(MAX_USB_LINE);
  lastUsbReady = 0;
}

void emitUsbReadyIfDue() {
  const uint32_t now = millis();
  if (lastUsbReady == 0 || now - lastUsbReady >= USB_READY_INTERVAL_MS) {
    Serial.println(USB_READY);
    Serial.flush();
    lastUsbReady = now;
  }
}

/**
 * Consume any provisioning bytes currently available on USB CDC.
 *
 * Kept separate from waitForUsbProvisioning() so the same protocol remains
 * live while the captive-portal recovery loop is running. That means a board
 * which missed the browser's first post-flash reconnect can still be configured
 * over USB later, without another erase/reflash and without visiting 192.168.4.1.
 */
bool serviceUsbProvisioning() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;

    if (c == '\n') {
      const bool saved = !usbLine.isEmpty() && handleUsbProvisionLine(usbLine);
      usbLine = "";
      if (saved) return true;
      continue;
    }

    if (usbLine.length() >= MAX_USB_LINE) {
      usbLine = "";
      Serial.printf("%sline-too-long\n", USB_ERROR);
    } else {
      usbLine += c;
    }
  }
  return false;
}

String htmlEscape(const String& value) {
  String out;
  out.reserve(value.length());
  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value.charAt(i);
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

String setupPage() {
  String options;
  const int found = WiFi.scanNetworks();
  for (int i = 0; i < found; ++i) {
    const String ssid = htmlEscape(WiFi.SSID(i));
    options += "<option value=\"" + ssid + "\">" + ssid +
               " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  if (options.isEmpty()) {
    options = "<option value=\"\">No networks found — rescan</option>";
  }

  // Styled with the CtrlAlt palette, inline: the phone has no route to the
  // server yet, so nothing external can be loaded.
  return String(
             "<!doctype html><html><head><meta charset=utf-8>"
             "<meta name=viewport content='width=device-width,initial-scale=1'>"
             "<title>inkpanel setup</title><style>"
             "body{background:#0a0a0b;color:#f5f5f6;font-family:system-ui,sans-serif;"
             "padding:24px;max-width:480px;margin:auto}"
             "h1{color:#f7a4a2;font-size:32px;margin:0 0 8px}"
             "p{color:#b9bac0;font-size:14px;margin:0 0 24px}"
             "label{display:block;margin:16px 0 6px;font-size:14px;color:#b9bac0}"
             "input,select{width:100%;padding:12px;border-radius:6px;border:1px solid #26272c;"
             "background:#1f2024;color:#f5f5f6;font-size:16px;box-sizing:border-box}"
             "button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:999px;"
             "background:#f7a4a2;color:#0a0a0b;font-weight:700;font-size:16px}"
             "</style></head><body><h1>inkpanel</h1>"
             "<p>Connect this panel to your network.</p>"
             "<form method=POST action=/save>"
             "<label>WiFi network</label><select name=ssid>") +
         options +
         String("</select>"
                "<label>Password</label><input name=pass type=password autocomplete=off>"
                "<label>Server address</label>"
                "<input name=url placeholder='http://192.168.1.20:8080' autocapitalize=off "
                "autocorrect=off spellcheck=false>"
                "<button type=submit>Save and restart</button></form></body></html>");
}

void handleSave() {
  const String ssid = web.arg("ssid");
  const String pass = web.arg("pass");
  const String url = web.arg("url");

  if (ssid.isEmpty() || url.isEmpty() || ssid.length() > 32 || pass.length() > 64 || url.length() > 127) {
    web.send(400, "text/html",
             "<body style='background:#0a0a0b;color:#f5f5f6;font-family:sans-serif;padding:24px'>"
             "<h1 style='color:#e85a56'>Invalid details</h1>"
             "<p>A network and HTTP server address are required and must fit the panel limits.</p>"
             "<p><a style='color:#f7a4a2' href='/'>Back</a></p></body>");
    return;
  }

  Credentials incoming{};
  snprintf(incoming.ssid, sizeof(incoming.ssid), "%s", ssid.c_str());
  snprintf(incoming.password, sizeof(incoming.password), "%s", pass.c_str());
  snprintf(incoming.serverUrl, sizeof(incoming.serverUrl), "%s", url.c_str());
  if (!saveCredentials(incoming)) {
    web.send(400, "text/html",
             "<body style='background:#0a0a0b;color:#f5f5f6;font-family:sans-serif;padding:24px'>"
             "<h1 style='color:#e85a56'>Could not save</h1>"
             "<p>Check the server address begins with http:// and try again.</p></body>");
    return;
  }

  web.send(200, "text/html",
           "<body style='background:#0a0a0b;color:#f5f5f6;font-family:sans-serif;padding:24px'>"
           "<h1 style='color:#f7a4a2'>Saved</h1>"
           "<p>Restarting. The panel will show its device ID shortly.</p></body>");
  delay(1200);
  ESP.restart();
}

}  // namespace

bool loadCredentials(Credentials& out) {
  prefs.begin(NVS_NAMESPACE, true);
  const String ssid = prefs.getString("ssid", "");
  const String pass = prefs.getString("pass", "");
  const String url = prefs.getString("url", "");
  prefs.end();

  if (ssid.isEmpty() || url.isEmpty()) return false;

  snprintf(out.ssid, sizeof(out.ssid), "%s", ssid.c_str());
  snprintf(out.password, sizeof(out.password), "%s", pass.c_str());
  snprintf(out.serverUrl, sizeof(out.serverUrl), "%s", url.c_str());
  return validCredentials(out);
}

bool saveCredentials(const Credentials& credentials) {
  if (!validCredentials(credentials)) return false;

  prefs.begin(NVS_NAMESPACE, false);
  const size_t ssidBytes = prefs.putString("ssid", credentials.ssid);
  // An empty password is valid for an open network; Preferences returns 0 for
  // an empty string, so it must not be treated as a failed write.
  prefs.putString("pass", credentials.password);
  const size_t urlBytes = prefs.putString("url", credentials.serverUrl);
  prefs.end();
  return ssidBytes > 0 && urlBytes > 0;
}

void clearCredentials() {
  prefs.begin(NVS_NAMESPACE, false);
  prefs.clear();
  prefs.end();
}

bool waitForUsbProvisioning(uint32_t timeoutMs) {
  Serial.printf("[setup] USB provisioning available for %lu seconds\n",
                static_cast<unsigned long>(timeoutMs / 1000));

  resetUsbProvisioningState();
  const uint32_t deadline = millis() + timeoutMs;

  while (static_cast<int32_t>(deadline - millis()) > 0) {
    emitUsbReadyIfDue();
    if (serviceUsbProvisioning()) return true;
    delay(5);
  }

  Serial.println("[setup] USB provisioning window expired");
  return false;
}

[[noreturn]] void runProvisioningPortal() {
  Serial.printf("[setup] portal starting, join WiFi '%s'\n", AP_SSID);

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID);
  Serial.printf("[setup] recovery page http://%s (only reachable while joined to '%s')\n",
                WiFi.softAPIP().toString().c_str(), AP_SSID);
  Serial.println("[setup] USB provisioning remains available; the recovery page is not required");

  dns.start(53, "*", WiFi.softAPIP());

  web.on("/", HTTP_GET, [] { web.send(200, "text/html", setupPage()); });
  web.on("/save", HTTP_POST, handleSave);
  // Anything else redirects, which is what triggers the captive-portal prompt.
  web.onNotFound([] {
    web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString());
    web.send(302, "text/plain", "");
  });
  web.begin();

  // The AP is a recovery option, not a dead end. Keep the exact same USB
  // provisioning protocol alive indefinitely while the portal is running so
  // the dashboard can configure a board later even if automatic post-flash
  // USB re-enumeration was missed by Windows/Chromium.
  resetUsbProvisioningState();
  for (;;) {
    emitUsbReadyIfDue();
    if (serviceUsbProvisioning()) {
      Serial.println("[setup] USB credentials saved in recovery mode — restarting");
      Serial.flush();
      delay(200);
      ESP.restart();
    }

    dns.processNextRequest();
    web.handleClient();
    delay(2);
  }
}
