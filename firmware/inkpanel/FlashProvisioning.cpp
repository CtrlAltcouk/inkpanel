#include "FlashProvisioning.h"

#include <Arduino.h>
#include <esp_partition.h>
#include <cstring>

#include "Provisioning.h"

namespace {

constexpr const char* PARTITION_LABEL = "provision";
constexpr uint8_t MAGIC[8] = {'I', 'N', 'K', 'P', 'V', '0', '0', '1'};
constexpr uint16_t FORMAT_VERSION = 1;
constexpr size_t HEADER_SIZE = 20;
constexpr size_t MAX_PAYLOAD = 32 + 64 + 127;

uint16_t readLe16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) |
         (static_cast<uint16_t>(p[1]) << 8);
}

uint32_t readLe32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
  }
  return crc;
}

uint32_t recordCrc(const uint8_t* metadata, const uint8_t* payload, size_t payloadLength) {
  uint32_t crc = 0xFFFFFFFFu;
  crc = crc32Update(crc, metadata, 8);  // version + three field lengths
  crc = crc32Update(crc, payload, payloadLength);
  return crc ^ 0xFFFFFFFFu;
}

const esp_partition_t* provisioningPartition() {
  return esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA,
      ESP_PARTITION_SUBTYPE_ANY,
      PARTITION_LABEL);
}

bool erasePartition(const esp_partition_t* partition) {
  if (!partition) return false;
  const esp_err_t rc = esp_partition_erase_range(partition, 0, partition->size);
  if (rc != ESP_OK) {
    Serial.printf("[setup] could not erase one-time provisioning partition (err=%d)\n",
                  static_cast<int>(rc));
    return false;
  }
  return true;
}

bool rejectRecord(const esp_partition_t* partition, const char* reason) {
  Serial.printf("[setup] one-time provisioning record invalid (%s) — clearing it\n", reason);
  erasePartition(partition);
  return false;
}

}  // namespace

void clearFlashProvisioning() {
  const esp_partition_t* partition = provisioningPartition();
  if (!partition) return;
  erasePartition(partition);
}

bool importFlashProvisioning() {
  const esp_partition_t* partition = provisioningPartition();
  if (!partition) {
    Serial.println("[setup] one-time provisioning partition not found");
    return false;
  }
  if (partition->size < HEADER_SIZE) {
    return rejectRecord(partition, "partition-too-small");
  }

  uint8_t header[HEADER_SIZE]{};
  if (esp_partition_read(partition, 0, header, sizeof(header)) != ESP_OK) {
    Serial.println("[setup] could not read one-time provisioning partition");
    return false;
  }

  // An erased/unused partition is the normal steady state after onboarding.
  if (memcmp(header, MAGIC, sizeof(MAGIC)) != 0) return false;

  const uint16_t version = readLe16(header + 8);
  const uint16_t ssidLength = readLe16(header + 10);
  const uint16_t passwordLength = readLe16(header + 12);
  const uint16_t urlLength = readLe16(header + 14);
  const uint32_t expectedCrc = readLe32(header + 16);

  if (version != FORMAT_VERSION) return rejectRecord(partition, "unsupported-version");
  if (ssidLength == 0 || ssidLength > 32) return rejectRecord(partition, "ssid-length");
  if (passwordLength > 64) return rejectRecord(partition, "password-length");
  if (urlLength == 0 || urlLength > 127) return rejectRecord(partition, "server-url-length");

  const size_t payloadLength =
      static_cast<size_t>(ssidLength) + passwordLength + urlLength;
  if (payloadLength > MAX_PAYLOAD || HEADER_SIZE + payloadLength > partition->size) {
    return rejectRecord(partition, "payload-length");
  }

  uint8_t payload[MAX_PAYLOAD]{};
  if (esp_partition_read(partition, HEADER_SIZE, payload, payloadLength) != ESP_OK) {
    Serial.println("[setup] could not read one-time provisioning payload");
    return false;
  }

  const uint32_t actualCrc = recordCrc(header + 8, payload, payloadLength);
  if (actualCrc != expectedCrc) return rejectRecord(partition, "crc");

  Credentials incoming{};
  size_t cursor = 0;
  memcpy(incoming.ssid, payload + cursor, ssidLength);
  incoming.ssid[ssidLength] = '\0';
  cursor += ssidLength;

  memcpy(incoming.password, payload + cursor, passwordLength);
  incoming.password[passwordLength] = '\0';
  cursor += passwordLength;

  memcpy(incoming.serverUrl, payload + cursor, urlLength);
  incoming.serverUrl[urlLength] = '\0';

  if (!saveCredentials(incoming)) {
    Serial.println("[setup] one-time provisioning record was valid but NVS save failed");
    return false;
  }

  // Save first, erase second. If power disappears between those operations,
  // the board already has valid NVS credentials; setup never depends on the
  // temporary record surviving after this point.
  if (!erasePartition(partition)) {
    Serial.println("[setup] credentials imported but temporary record could not be erased");
  } else {
    Serial.println("[setup] imported flash-time Wi-Fi/server settings and erased temporary record");
  }
  return true;
}
