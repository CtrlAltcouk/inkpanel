import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function frameClientSource(): Promise<string> {
  return readFile(join(process.cwd(), 'firmware', 'inkpanel', 'FrameClient.cpp'), 'utf8');
}

test('known Content-Length must still equal the framebuffer exactly', async () => {
  const source = await frameClientSource();
  assert.match(
    source,
    /if \(length >= 0 && length != static_cast<int>\(bufferSize\)\)/,
  );
});

test('unknown-length responses are accepted only through HTTPClient chunk decoding', async () => {
  const source = await frameClientSource();
  const unknownBranch = source.indexOf('if (length < 0)');
  const chunkedCheck = source.indexOf('transferEncoding.equalsIgnoreCase("chunked")');
  const decodedWrite = source.indexOf('http.writeToStream(&sink)');
  const rawStream = source.indexOf('http.getStreamPtr()');

  assert.ok(unknownBranch >= 0, 'unknown-size branch exists');
  assert.ok(chunkedCheck > unknownBranch, 'unknown size requires Transfer-Encoding: chunked');
  assert.ok(decodedWrite > chunkedCheck, 'chunked payload uses HTTPClient decoder');
  assert.ok(rawStream > decodedWrite, 'raw TCP stream remains only on the known-length fast path');
});

test('chunked decoder is bounded and requires exactly one framebuffer', async () => {
  const source = await frameClientSource();
  assert.match(source, /class FrameBufferSink : public Stream/);
  assert.match(source, /const size_t remaining = written_ < capacity_ \? capacity_ - written_ : 0/);
  assert.match(source, /if \(accepted != size\) overflowed_ = true/);
  assert.match(
    source,
    /decoded != static_cast<int>\(bufferSize\)[\s\S]*sink\.bytesWritten\(\) != bufferSize \|\| sink\.overflowed\(\)/,
  );
});

test('firmware version records the transfer-behaviour change', async () => {
  const config = await readFile(join(process.cwd(), 'firmware', 'inkpanel', 'config.h'), 'utf8');
  assert.match(config, /FIRMWARE_VERSION = "0\.1\.3"/);
});
