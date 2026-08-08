// Binary one-time provisioning record written directly into the ESP32's
// dedicated `provision` partition during a new-board flash.
//
// Layout (little-endian):
//   0x00  char[8]  magic "INKPV001"
//   0x08  u16      format version (1)
//   0x0A  u16      SSID byte length
//   0x0C  u16      password byte length
//   0x0E  u16      server URL byte length
//   0x10  u32      CRC32(metadata[0x08..0x0F] + payload)
//   0x14  bytes    UTF-8 SSID + password + server URL
//   rest           0xFF
//
// Firmware validates magic, version, lengths and CRC before copying the values
// into Preferences/NVS, then erases the entire partition immediately.

export const FLASH_PROVISION_MAGIC = 'INKPV001';
export const FLASH_PROVISION_VERSION = 1;
export const FLASH_PROVISION_HEADER_SIZE = 20;

function writeLe16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeLe32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

/** Standard reflected CRC-32 (polynomial 0xEDB88320). */
export function crc32(bytes, seed = 0xFFFFFFFF) {
  let crc = seed >>> 0;
  for (const value of bytes) {
    crc = (crc ^ value) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) >>> 0;
    }
  }
  return crc >>> 0;
}

function finalRecordCrc(metadata, payload) {
  let crc = crc32(metadata);
  crc = crc32(payload, crc);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function checkedPartition(partition) {
  const offset = Number(partition?.offset);
  const size = Number(partition?.size);
  const format = Number(partition?.format);

  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 0x1000 !== 0) {
    throw new Error('Firmware manifest has an invalid provisioning partition offset. Rebuild the firmware.');
  }
  if (!Number.isSafeInteger(size) || size < 0x1000 || size % 0x1000 !== 0) {
    throw new Error('Firmware manifest has an invalid provisioning partition size. Rebuild the firmware.');
  }
  if (format !== FLASH_PROVISION_VERSION) {
    throw new Error(`Unsupported firmware provisioning format ${format}; expected ${FLASH_PROVISION_VERSION}.`);
  }
  return { offset, size, format };
}

/** Build the exact bytes consumed by FlashProvisioning.cpp. */
export function buildFlashProvisioningImage(config, partition) {
  const target = checkedPartition(partition);
  const encoder = new TextEncoder();
  const ssid = encoder.encode(String(config?.ssid ?? ''));
  const password = encoder.encode(String(config?.password ?? ''));
  const serverUrl = encoder.encode(String(config?.serverUrl ?? ''));

  // Duplicate the firmware limits here as a final binary-boundary guard even
  // though the UI validates them before this function is called.
  if (ssid.length < 1 || ssid.length > 32) throw new Error('Invalid SSID length for flash provisioning.');
  if (password.length > 64) throw new Error('Invalid Wi-Fi password length for flash provisioning.');
  if (serverUrl.length < 1 || serverUrl.length > 127) throw new Error('Invalid server URL length for flash provisioning.');

  const payloadLength = ssid.length + password.length + serverUrl.length;
  if (FLASH_PROVISION_HEADER_SIZE + payloadLength > target.size) {
    throw new Error('Provisioning settings do not fit in the reserved firmware partition.');
  }

  const image = new Uint8Array(target.size);
  image.fill(0xFF);
  image.set(new TextEncoder().encode(FLASH_PROVISION_MAGIC), 0);

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  writeLe16(view, 8, FLASH_PROVISION_VERSION);
  writeLe16(view, 10, ssid.length);
  writeLe16(view, 12, password.length);
  writeLe16(view, 14, serverUrl.length);

  let cursor = FLASH_PROVISION_HEADER_SIZE;
  image.set(ssid, cursor);
  cursor += ssid.length;
  image.set(password, cursor);
  cursor += password.length;
  image.set(serverUrl, cursor);

  const payload = image.subarray(FLASH_PROVISION_HEADER_SIZE, FLASH_PROVISION_HEADER_SIZE + payloadLength);
  const metadata = image.subarray(8, 16);
  writeLe32(view, 16, finalRecordCrc(metadata, payload));
  return image;
}

/**
 * Add the one-time record to a prepared esptool file array.
 *
 * A normal arduino-cli merged image spans the whole 16 MB chip. In that case
 * patch the reserved sector inside the image so esptool writes it in a single
 * pass. If a toolchain only provides separate region binaries, append the
 * provisioning sector as one additional write instead.
 */
export function addFlashProvisioning(parts, config, partition) {
  const target = checkedPartition(partition);
  const record = buildFlashProvisioningImage(config, target);
  let embedded = false;

  const result = parts.map((part) => {
    if (!(part.data instanceof Uint8Array)) {
      throw new Error('Provisioning can only be added after firmware images are prepared as bytes.');
    }
    const start = Number(part.address);
    const end = start + part.data.length;
    const targetEnd = target.offset + target.size;
    if (!embedded && start <= target.offset && end >= targetEnd) {
      const data = part.data.slice();
      data.set(record, target.offset - start);
      embedded = true;
      return { ...part, data };
    }
    return part;
  });

  if (!embedded) result.push({ address: target.offset, data: record });
  return result;
}
