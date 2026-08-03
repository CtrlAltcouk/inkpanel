/*
  EE04 deep-sleep current spike.

  This is the first thing to run, before any inkpanel firmware. Battery life is
  dominated by idle draw, and nobody knows what the EE04 carrier actually
  consumes until it is measured. Record the result in
  docs/hardware/sleep-current.md.

  Measure with a multimeter in series on the battery positive lead, set to uA.
  Allow 30 seconds to settle. USB MUST be disconnected: the USB-serial path
  draws current that will dominate the reading.
*/
#include <Arduino.h>
#include <esp_sleep.h>

// From the EE04 pin map. Driving this low removes power from the panel.
constexpr int EPD_ENABLE = 43;

// Set false to measure with the panel rail left powered, for comparison.
constexpr bool PANEL_RAIL_OFF = true;

void setup() {
  pinMode(EPD_ENABLE, OUTPUT);
  digitalWrite(EPD_ENABLE, PANEL_RAIL_OFF ? LOW : HIGH);

  esp_sleep_enable_timer_wakeup(300ULL * 1000000ULL);  // 5 minutes
  esp_deep_sleep_start();
}

void loop() {}
