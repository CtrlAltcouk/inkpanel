#pragma once
/*
  Copy to secrets.h for bring-up.

  Task 19 replaces this with on-device provisioning via a captive portal, after
  which secrets.h is only a development convenience — a stranger cloning this
  repo cannot edit their SSID into a header file, so the shipped path must not
  depend on it.

  secrets.h is gitignored. Do not commit real credentials.
*/
#define WIFI_SSID   "your-network"
#define WIFI_PASS   "your-password"
#define SERVER_URL  "http://192.168.1.20:8080"
