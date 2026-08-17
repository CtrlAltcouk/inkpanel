#include "MiniEPD.h"

#include "config.h"

#include <string.h>

MiniEPD::MiniEPD() : last_error_("Not started"), started_(false) {
  // Logical InkPanel white is 0 because the wire format defines bit 1 as ink.
  memset(framebuffer_, 0x00, sizeof(framebuffer_));
}

bool MiniEPD::begin() {
  last_error_ = "Starting";

  pinMode(Hardware::EPD_CS, OUTPUT);
  pinMode(Hardware::EPD_DC, OUTPUT);
  pinMode(Hardware::EPD_RST, OUTPUT);
  pinMode(Hardware::EPD_BUSY, INPUT);

  digitalWrite(Hardware::EPD_CS, HIGH);
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_RST, HIGH);

  SPI.begin(Hardware::EPD_SCLK, -1, Hardware::EPD_MOSI, Hardware::EPD_CS);
  hardwareReset();

  // SSD1681 full-refresh initialisation for the 200x200 D67-family panel.
  command(0x12);  // SWRESET
  delay(10);
  if (!waitUntilIdle(EPD_BUSY_TIMEOUT_MS)) return false;

  command(0x01);  // Driver output control: 200 gate lines (0..199)
  data(0xC7);
  data(0x00);
  data(0x00);

  command(0x3C);  // Border waveform
  data(0x05);

  command(0x18);  // Use the controller's internal temperature sensor
  data(0x80);

  setFullRamArea();
  started_ = true;
  last_error_ = "OK";
  return true;
}

void MiniEPD::hardwareReset() {
  digitalWrite(Hardware::EPD_RST, HIGH);
  delay(20);
  digitalWrite(Hardware::EPD_RST, LOW);
  delay(2);
  digitalWrite(Hardware::EPD_RST, HIGH);
  delay(20);
}

void MiniEPD::command(uint8_t value) {
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, LOW);
  digitalWrite(Hardware::EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void MiniEPD::data(uint8_t value) {
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void MiniEPD::dataBlockInverted(const uint8_t* values, size_t count) {
  if (!values || count == 0) return;

  // SSD1681 RAM uses 1 for white while the InkPanel wire format uses 1 for
  // black. Invert in a small scratch block so no second 5 KB frame is needed.
  uint8_t chunk[256];
  size_t sent = 0;

  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);

  while (sent < count) {
    const size_t n = (count - sent < sizeof(chunk)) ? (count - sent) : sizeof(chunk);
    for (size_t i = 0; i < n; ++i) {
      chunk[i] = static_cast<uint8_t>(~values[sent + i]);
    }
    SPI.writeBytes(chunk, n);
    sent += n;
  }

  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void MiniEPD::setFullRamArea() {
  // RAM entry: X and Y both increase. The framebuffer is already packed as 25
  // bytes per row, top-to-bottom, so no server-side controller orientation is
  // encoded in the wire format.
  command(0x11);
  data(0x03);

  command(0x44);  // X start/end, byte addresses 0..24
  data(0x00);
  data(0x18);

  command(0x45);  // Y start/end, line addresses 0..199
  data(0x00);
  data(0x00);
  data(0xC7);
  data(0x00);

  command(0x4E);  // X counter
  data(0x00);

  command(0x4F);  // Y counter
  data(0x00);
  data(0x00);
}

bool MiniEPD::waitUntilIdle(uint32_t timeoutMs) {
  const uint32_t started = millis();

  // SSD1681 BUSY is active HIGH on this panel/driver-board combination.
  while (digitalRead(Hardware::EPD_BUSY) == HIGH) {
    if (millis() - started >= timeoutMs) {
      last_error_ = "BUSY timeout";
      return false;
    }
    delay(10);
  }

  delay(10);
  return true;
}

bool MiniEPD::display(const uint8_t* image) {
  if (!started_) {
    last_error_ = "Display not initialised";
    return false;
  }
  if (!image) {
    last_error_ = "Null framebuffer";
    return false;
  }

  // Populate both SSD1681 RAM planes before a full update. This avoids leaving
  // an unknown previous-image buffer after reset and gives repeatable full
  // refresh behaviour without relying on differential/partial updates.
  setFullRamArea();
  command(0x26);  // previous image RAM
  dataBlockInverted(image, BUFFER_SIZE);

  setFullRamArea();
  command(0x24);  // current image RAM
  dataBlockInverted(image, BUFFER_SIZE);

  command(0x22);  // Display Update Control 2
  data(0xF7);     // full update sequence
  command(0x20);  // Master activation

  if (!waitUntilIdle(EPD_BUSY_TIMEOUT_MS)) return false;

  last_error_ = "OK";
  return true;
}

bool MiniEPD::sleep() {
  if (!started_) return true;

  // The full-refresh sequence powers the panel-driving voltages down. Put the
  // SSD1681 logic itself into deep sleep as well; RST wakes it next cycle.
  command(0x10);
  data(0x01);
  delay(10);
  started_ = false;
  last_error_ = "OK";
  return true;
}
