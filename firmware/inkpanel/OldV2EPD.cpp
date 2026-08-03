/*
  OldV2EPD.cpp

  The panel initialisation sequence and LUT values in this file are adapted
  from Waveshare's epd7in5_V2_old.py.

  Copyright (C) Waveshare team.

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/

#include "OldV2EPD.h"

#include "config.h"

#include <string.h>

namespace {

// These values are a direct C++ port of Waveshare's epd7in5_V2_old.py
// full-refresh initialisation tables for the older 800x480 panel family.
constexpr size_t LUT_SIZE = 42;

const uint8_t LUT_VCOM[LUT_SIZE] PROGMEM = {
  0x00,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x0F,0x01,0x0F,0x01,0x02,
  0x00,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00
};

const uint8_t LUT_WW[LUT_SIZE] PROGMEM = {
  0x10,0x0F,0x0F,0x00,0x00,0x01,
  0x84,0x0F,0x01,0x0F,0x01,0x02,
  0x20,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00
};

const uint8_t LUT_BW[LUT_SIZE] PROGMEM = {
  0x10,0x0F,0x0F,0x00,0x00,0x01,
  0x84,0x0F,0x01,0x0F,0x01,0x02,
  0x20,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00
};

const uint8_t LUT_WB[LUT_SIZE] PROGMEM = {
  0x80,0x0F,0x0F,0x00,0x00,0x01,
  0x84,0x0F,0x01,0x0F,0x01,0x02,
  0x40,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00
};

const uint8_t LUT_BB[LUT_SIZE] PROGMEM = {
  0x80,0x0F,0x0F,0x00,0x00,0x01,
  0x84,0x0F,0x01,0x0F,0x01,0x02,
  0x40,0x0F,0x0F,0x00,0x00,0x01,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00
};

}  // namespace

OldV2EPD::OldV2EPD() : last_error_("Not started") {
  memset(framebuffer_, 0x00, sizeof(framebuffer_));
}

bool OldV2EPD::begin() {
  last_error_ = "Starting";

  pinMode(Hardware::EPD_ENABLE, OUTPUT);
  digitalWrite(Hardware::EPD_ENABLE, HIGH);
  delay(20);

  pinMode(Hardware::EPD_CS, OUTPUT);
  pinMode(Hardware::EPD_DC, OUTPUT);
  pinMode(Hardware::EPD_RST, OUTPUT);
  pinMode(Hardware::EPD_BUSY, INPUT);

  digitalWrite(Hardware::EPD_CS, HIGH);
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_RST, HIGH);

  SPI.begin(Hardware::EPD_SCLK, -1, Hardware::EPD_MOSI, Hardware::EPD_CS);
  return initialiseOldV2();
}

void OldV2EPD::hardwareReset() {
  digitalWrite(Hardware::EPD_RST, HIGH);
  delay(20);
  digitalWrite(Hardware::EPD_RST, LOW);
  delay(2);
  digitalWrite(Hardware::EPD_RST, HIGH);
  delay(20);
}

void OldV2EPD::command(uint8_t value) {
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, LOW);
  digitalWrite(Hardware::EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void OldV2EPD::data(uint8_t value) {
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);
  SPI.transfer(value);
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void OldV2EPD::dataBlock(const uint8_t* values, size_t count, bool invert) {
  if (!values || count == 0) return;
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);

  if (!invert) {
    // writeBytes takes a non-const pointer but does not modify the buffer.
    SPI.writeBytes(const_cast<uint8_t*>(values), count);
  } else {
    // Invert through a small scratch buffer rather than duplicating 48 KB.
    uint8_t chunk[512];
    size_t sent = 0;
    while (sent < count) {
      const size_t n = (count - sent < sizeof(chunk)) ? (count - sent) : sizeof(chunk);
      for (size_t i = 0; i < n; ++i) chunk[i] = static_cast<uint8_t>(~values[sent + i]);
      SPI.writeBytes(chunk, n);
      sent += n;
    }
  }

  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

void OldV2EPD::repeatedData(uint8_t value, size_t count) {
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);
  for (size_t i = 0; i < count; ++i) SPI.transfer(value);
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

bool OldV2EPD::waitUntilIdle(uint32_t timeoutMs) {
  const uint32_t started = millis();
  command(0x71);

  // The Waveshare old-V2 driver treats LOW as busy and HIGH as ready.
  while (digitalRead(Hardware::EPD_BUSY) == LOW) {
    command(0x71);
    if (millis() - started >= timeoutMs) {
      last_error_ = "BUSY timeout";
      return false;
    }
    delay(10);
  }

  delay(20);
  return true;
}

void OldV2EPD::loadLut(uint8_t commandValue, const uint8_t* lut, size_t count) {
  command(commandValue);
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);
  for (size_t i = 0; i < count; ++i) SPI.transfer(pgm_read_byte(lut + i));
  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}

bool OldV2EPD::initialiseOldV2() {
  hardwareReset();

  command(0x01);  // Power setting
  data(0x17);
  data(0x17);      // VGH/VGL
  data(0x3F);      // VSH
  data(0x3F);      // VSL
  data(0x11);      // VSHR

  command(0x82);  // VCOM DC
  data(0x24);

  command(0x06);  // Booster soft start
  data(0x27);
  data(0x27);
  data(0x2F);
  data(0x17);

  command(0x30);  // Oscillator
  data(0x06);

  command(0x04);  // Power on
  delay(100);
  if (!waitUntilIdle(EPD_BUSY_TIMEOUT_MS)) return false;

  command(0x00);  // Panel setting
  data(0x3F);

  command(0x61);  // 800 x 480 resolution
  data(0x03);
  data(0x20);
  data(0x01);
  data(0xE0);

  command(0x15);
  data(0x00);

  command(0x50);  // VCOM and data interval
  data(0x10);
  data(0x07);

  command(0x60);  // TCON
  data(0x22);

  command(0x65);
  data(0x00);
  data(0x00);
  data(0x00);
  data(0x00);

  loadLut(0x20, LUT_VCOM, LUT_SIZE);
  loadLut(0x21, LUT_WW, LUT_SIZE);
  loadLut(0x22, LUT_BW, LUT_SIZE);
  loadLut(0x23, LUT_WB, LUT_SIZE);
  loadLut(0x24, LUT_BB, LUT_SIZE);

  last_error_ = "OK";
  return true;
}

bool OldV2EPD::display(const uint8_t* image) {
  if (!image) {
    last_error_ = "Null image";
    return false;
  }

  command(0x10);
  dataBlock(image, BUFFER_SIZE, true);   // Old image plane: inverse of new image

  command(0x13);
  dataBlock(image, BUFFER_SIZE, false);  // New image plane

  command(0x12);
  delay(100);
  if (!waitUntilIdle(EPD_BUSY_TIMEOUT_MS)) return false;

  last_error_ = "OK";
  return true;
}

bool OldV2EPD::clear(bool black) {
  command(0x10);
  repeatedData(black ? 0x00 : 0xFF, BUFFER_SIZE);
  command(0x13);
  repeatedData(black ? 0xFF : 0x00, BUFFER_SIZE);
  command(0x12);
  delay(100);
  return waitUntilIdle(EPD_BUSY_TIMEOUT_MS);
}

bool OldV2EPD::sleep() {
  command(0x02);  // Power off
  if (!waitUntilIdle(EPD_BUSY_TIMEOUT_MS)) return false;

  command(0x07);  // Deep sleep
  data(0xA5);
  delay(2000);

  digitalWrite(Hardware::EPD_ENABLE, LOW);
  last_error_ = "Sleeping";
  return true;
}
