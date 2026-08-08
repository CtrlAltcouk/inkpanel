#pragma once

/**
 * Import a one-time provisioning record written by the browser flasher.
 *
 * The record lives in the dedicated `provision` data partition, is validated
 * with a magic/version marker, strict field lengths and CRC32, then copied into
 * the same Preferences/NVS keys used by USB and captive-portal setup. The
 * partition is erased immediately after a successful import so the Wi-Fi
 * password is not retained in two places.
 *
 * Returns true only when valid credentials were imported and saved.
 */
bool importFlashProvisioning();

/** Erase any pending one-time provisioning record, if the partition exists. */
void clearFlashProvisioning();
