#pragma once

#include <Arduino.h>
#include <SPI.h>
#include <stddef.h>
#include <stdint.h>

/**
 * Minimal full-refresh driver for the 1.54-inch 200x200 SSD1681 panel used by
 * InkPanel Mini.
 *
 * InkPanel's wire framebuffer is row-major, MSB-first, with bit 1 meaning black
 * ink. SSD1681 RAM uses the opposite polarity (1 = white), so display() inverts
 * bytes while streaming them to the controller. The server therefore stays
 * controller-agnostic and uses the same logical framebuffer convention for all
 * InkPanel profiles.
 */
class MiniEPD {
public:
  static constexpr int16_t WIDTH = 200;
  static constexpr int16_t HEIGHT = 200;
  static constexpr size_t BUFFER_SIZE = static_cast<size_t>(WIDTH) * HEIGHT / 8;

  MiniEPD();

  bool begin();
  bool display(const uint8_t* image);
  bool sleep();

  uint8_t* framebuffer() { return framebuffer_; }
  const uint8_t* framebuffer() const { return framebuffer_; }
  const char* lastError() const { return last_error_; }

private:
  void hardwareReset();
  void command(uint8_t value);
  void data(uint8_t value);
  void dataBlockInverted(const uint8_t* values, size_t count);
  void setFullRamArea();
  bool waitUntilIdle(uint32_t timeoutMs);

  uint8_t framebuffer_[BUFFER_SIZE];
  const char* last_error_;
  bool started_;
};
