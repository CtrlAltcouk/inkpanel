#pragma once

#include <Arduino.h>
#include <SPI.h>
#include <stddef.h>
#include <stdint.h>

class OldV2EPD {
public:
  static constexpr int16_t WIDTH = 800;
  static constexpr int16_t HEIGHT = 480;
  static constexpr size_t BUFFER_SIZE = static_cast<size_t>(WIDTH) * HEIGHT / 8;

  OldV2EPD();

  bool begin();
  bool display(const uint8_t* image);
  bool clear(bool black = false);
  bool sleep();

  uint8_t* framebuffer() { return framebuffer_; }
  const uint8_t* framebuffer() const { return framebuffer_; }
  const char* lastError() const { return last_error_; }

private:
  void hardwareReset();
  void command(uint8_t value);
  void data(uint8_t value);
  void dataBlock(const uint8_t* values, size_t count, bool invert = false);
  void repeatedData(uint8_t value, size_t count);
  bool waitUntilIdle(uint32_t timeoutMs);
  void loadLut(uint8_t commandValue, const uint8_t* lut, size_t count);
  bool initialiseOldV2();

  uint8_t framebuffer_[BUFFER_SIZE];
  const char* last_error_;
};
