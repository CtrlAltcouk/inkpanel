#include "FrameClient.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_mac.h>
#include <string.h>

#include "config.h"

namespace {

/**
 * Bounded Stream sink used only for HTTPClient's chunked-transfer decoder.
 *
 * HTTPClient::getStreamPtr() exposes the raw TCP stream, including chunk
 * framing. writeToStream() decodes Transfer-Encoding: chunked before writing
 * payload bytes here. Returning a short write once capacity is exhausted makes
 * HTTPClient fail the transfer rather than accepting a frame larger than the
 * panel buffer.
 */
class FrameBufferSink : public Stream {
 public:
  FrameBufferSink(uint8_t* buffer, size_t capacity)
      : buffer_(buffer), capacity_(capacity) {}

  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}

  size_t write(uint8_t byte) override { return write(&byte, 1); }

  size_t write(const uint8_t* data, size_t size) override {
    const size_t remaining = written_ < capacity_ ? capacity_ - written_ : 0;
    const size_t accepted = size < remaining ? size : remaining;
    if (accepted > 0) {
      memcpy(buffer_ + written_, data, accepted);
      written_ += accepted;
    }
    if (accepted != size) overflowed_ = true;
    return accepted;
  }

  size_t bytesWritten() const { return written_; }
  bool overflowed() const { return overflowed_; }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t written_ = 0;
  bool overflowed_ = false;
};

}  // namespace

void deviceId(char* out, size_t len) {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(out, len, "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

FetchOutcome fetchFrame(const char* serverUrl,
                        const char* id,
                        uint8_t* framebuffer,
                        size_t bufferSize,
                        const char* currentEtag,
                        float batteryVolts,
                        const char* wakeReason) {
  FetchOutcome outcome{FetchResult::Failed, FALLBACK_WAKE_SECONDS, {0}};

  char url[224];
  snprintf(url, sizeof(url), "%s/api/devices/%s/frame", serverUrl, id);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(url)) {
    Serial.println("[net] http.begin failed");
    return outcome;
  }

  char volts[16];
  snprintf(volts, sizeof(volts), "%.2f", batteryVolts);
  http.addHeader("X-Battery-Voltage", volts);
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);
  http.addHeader("X-Wake-Reason", wakeReason);
  if (currentEtag && currentEtag[0]) http.addHeader("If-None-Match", currentEtag);

  // HTTPClient discards response headers unless asked to keep them.
  const char* wanted[] = {"ETag", "X-Next-Wake-Seconds", "Transfer-Encoding"};
  http.collectHeaders(wanted, 3);

  const int status = http.GET();
  Serial.printf("[net] GET %s -> %d\n", url, status);

  if (status > 0) {
    const String wake = http.header("X-Next-Wake-Seconds");
    if (wake.length() > 0) {
      const long parsed = wake.toInt();
      if (parsed > 0) outcome.nextWakeSeconds = static_cast<uint32_t>(parsed);
    }
    snprintf(outcome.etag, sizeof(outcome.etag), "%s", http.header("ETag").c_str());
  }

  if (status == HTTP_CODE_NOT_MODIFIED) {
    outcome.result = FetchResult::NotModified;
    http.end();
    return outcome;
  }

  if (status != HTTP_CODE_OK) {
    http.end();
    return outcome;
  }

  const int length = http.getSize();
  if (length >= 0 && length != static_cast<int>(bufferSize)) {
    Serial.printf("[net] expected %u bytes, server said %d\n",
                  static_cast<unsigned>(bufferSize), length);
    http.end();
    return outcome;
  }

  if (length < 0) {
    // Unknown size is safe only when HTTPClient knows how to decode the body.
    // A close-delimited HTTP/1.1 body can otherwise keep an ESP blocked on a
    // misbehaving keep-alive peer, while chunked has an explicit terminal chunk.
    const String transferEncoding = http.header("Transfer-Encoding");
    if (!transferEncoding.equalsIgnoreCase("chunked")) {
      Serial.println("[net] missing Content-Length without chunked transfer encoding");
      http.end();
      return outcome;
    }

    FrameBufferSink sink(framebuffer, bufferSize);
    const int decoded = http.writeToStream(&sink);
    http.end();

    if (decoded != static_cast<int>(bufferSize) ||
        sink.bytesWritten() != bufferSize || sink.overflowed()) {
      Serial.printf("[net] chunked frame size mismatch: decoded=%d stored=%u expected=%u%s\n",
                    decoded,
                    static_cast<unsigned>(sink.bytesWritten()),
                    static_cast<unsigned>(bufferSize),
                    sink.overflowed() ? " overflow" : "");
      return outcome;
    }

    outcome.result = FetchResult::Updated;
    return outcome;
  }

  // Known-length fast path. Read the whole frame before touching the panel: a
  // truncated read must not become a half-drawn screen.
  WiFiClient* stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t lastProgress = millis();
  while (received < bufferSize) {
    const int available = stream->available();
    if (available <= 0) {
      if (!stream->connected() || millis() - lastProgress > HTTP_TIMEOUT_MS) break;
      delay(1);
      continue;
    }
    size_t want = bufferSize - received;
    if (static_cast<size_t>(available) < want) want = static_cast<size_t>(available);
    const int read = stream->readBytes(framebuffer + received, want);
    if (read <= 0) break;
    received += static_cast<size_t>(read);
    lastProgress = millis();
  }
  http.end();

  if (received != bufferSize) {
    Serial.printf("[net] short read: %u of %u\n",
                  static_cast<unsigned>(received), static_cast<unsigned>(bufferSize));
    return outcome;
  }

  outcome.result = FetchResult::Updated;
  return outcome;
}
