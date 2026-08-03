#include "Provisioning.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#include "config.h"

namespace {

constexpr const char* NVS_NAMESPACE = "inkpanel";
constexpr const char* AP_SSID = "inkpanel-setup";

Preferences prefs;
DNSServer dns;
WebServer web(80);

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
  const String url = web.arg("url");

  if (ssid.isEmpty() || url.isEmpty()) {
    web.send(400, "text/html",
             "<body style='background:#0a0a0b;color:#f5f5f6;font-family:sans-serif;padding:24px'>"
             "<h1 style='color:#e85a56'>Missing details</h1>"
             "<p>A network and a server address are both required.</p>"
             "<p><a style='color:#f7a4a2' href='/'>Back</a></p></body>");
    return;
  }

  prefs.begin(NVS_NAMESPACE, false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", web.arg("pass"));
  prefs.putString("url", url);
  prefs.end();

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
  return true;
}

void clearCredentials() {
  prefs.begin(NVS_NAMESPACE, false);
  prefs.clear();
  prefs.end();
}

[[noreturn]] void runProvisioningPortal() {
  Serial.printf("[setup] portal starting, join WiFi '%s'\n", AP_SSID);

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID);
  Serial.printf("[setup] open http://%s\n", WiFi.softAPIP().toString().c_str());

  dns.start(53, "*", WiFi.softAPIP());

  web.on("/", HTTP_GET, [] { web.send(200, "text/html", setupPage()); });
  web.on("/save", HTTP_POST, handleSave);
  // Anything else redirects, which is what triggers the captive-portal prompt.
  web.onNotFound([] {
    web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString());
    web.send(302, "text/plain", "");
  });
  web.begin();

  for (;;) {
    dns.processNextRequest();
    web.handleClient();
    delay(2);
  }
}
