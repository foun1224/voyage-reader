/**
 * Zero-Copy Streaming ZIP32 & ZIP64 Reader (Zero external dependencies)
 * - For STORED (method 0) entries: returns a lazy Blob slice via file.slice()
 *   so importing a 1 GB category pack uses < 5 MB RAM on iPhone Safari.
 * - For DEFLATE (method 8) entries (e.g. EPUB or standard ZIPs): decompresses
 *   using native DecompressionStream('deflate-raw').
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function readUint64LE(dv, offset) {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  return hi * 4294967296 + lo;
}

/**
 * Parse Central Directory of any Blob/File without loading the whole archive into RAM.
 * @param {Blob} blob
 * @returns {Promise<Array<ZipEntry>>}
 */
export async function listZipEntries(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('檔案過小，不是有效的 ZIP 檔案');

  const tailLen = Math.min(size, 65557);
  const tailStart = size - tailLen;
  const tailBuf = await blob.slice(tailStart, size).arrayBuffer();
  const tailDv = new DataView(tailBuf);

  // Locate EOCD signature scanning backwards from end
  let eocdPos = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tailDv.getUint32(i, true) === SIG_EOCD) {
      const commentLen = tailDv.getUint16(i + 20, true);
      if (i + 22 + commentLen === tailLen) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) throw new Error('找不到 ZIP 目錄尾標記（EOCD）');

  let totalEntries = tailDv.getUint16(eocdPos + 10, true);
  let cdSize = tailDv.getUint32(eocdPos + 12, true);
  let cdOffset = tailDv.getUint32(eocdPos + 16, true);

  // Check for ZIP64 locator right before EOCD
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    const locPos = eocdPos - 20;
    if (locPos >= 0 && tailDv.getUint32(locPos, true) === SIG_ZIP64_LOCATOR) {
      const z64EocdOffset = readUint64LE(tailDv, locPos + 8);
      const z64Buf = await blob.slice(z64EocdOffset, z64EocdOffset + 56).arrayBuffer();
      const z64Dv = new DataView(z64Buf);
      if (z64Dv.getUint32(0, true) === SIG_ZIP64_EOCD) {
        totalEntries = readUint64LE(z64Dv, 32);
        cdSize = readUint64LE(z64Dv, 40);
        cdOffset = readUint64LE(z64Dv, 48);
      }
    }
  }

  // Read Central Directory (typically only a few KB)
  const cdBuf = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cdDv = new DataView(cdBuf);
  const cdU8 = new Uint8Array(cdBuf);

  const entries = [];
  let pos = 0;
  while (pos + 46 <= cdBuf.byteLength) {
    const sig = cdDv.getUint32(pos, true);
    if (sig !== SIG_CEN) break;

    const flags = cdDv.getUint16(pos + 8, true);
    const method = cdDv.getUint16(pos + 10, true);
    let compSize = cdDv.getUint32(pos + 20, true);
    let uncompSize = cdDv.getUint32(pos + 24, true);
    const nameLen = cdDv.getUint16(pos + 28, true);
    const extraLen = cdDv.getUint16(pos + 30, true);
    const commentLen = cdDv.getUint16(pos + 32, true);
    let localHeaderOffset = cdDv.getUint32(pos + 42, true);

    const nameBytes = cdU8.subarray(pos + 46, pos + 46 + nameLen);
    const name = utf8Decoder.decode(nameBytes);

    // Parse ZIP64 extra field if needed
    if (
      uncompSize === 0xffffffff ||
      compSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      let ePos = pos + 46 + nameLen;
      const eEnd = ePos + extraLen;
      while (ePos + 4 <= eEnd) {
        const headerId = cdDv.getUint16(ePos, true);
        const dataSize = cdDv.getUint16(ePos + 2, true);
        if (headerId === 0x0001) {
          let fPos = ePos + 4;
          if (uncompSize === 0xffffffff && fPos + 8 <= ePos + 4 + dataSize) {
            uncompSize = readUint64LE(cdDv, fPos);
            fPos += 8;
          }
          if (compSize === 0xffffffff && fPos + 8 <= ePos + 4 + dataSize) {
            compSize = readUint64LE(cdDv, fPos);
            fPos += 8;
          }
          if (localHeaderOffset === 0xffffffff && fPos + 8 <= ePos + 4 + dataSize) {
            localHeaderOffset = readUint64LE(cdDv, fPos);
          }
          break;
        }
        ePos += 4 + dataSize;
      }
    }

    const isDir = name.endsWith('/');
    entries.push({
      name,
      isDir,
      flags,
      method,
      compSize,
      uncompSize,
      localHeaderOffset,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function getEntryDataSlice(blob, entry, mimeType = 'application/octet-stream') {
  const lhBuf = await blob
    .slice(entry.localHeaderOffset, entry.localHeaderOffset + 30)
    .arrayBuffer();
  const lhDv = new DataView(lhBuf);
  if (lhDv.getUint32(0, true) !== SIG_LOC) {
    throw new Error(`ZIP 檔頭損毀：${entry.name}`);
  }
  const nameLen = lhDv.getUint16(26, true);
  const extraLen = lhDv.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  return blob.slice(dataStart, dataStart + entry.compSize, mimeType);
}

/**
 * Extract an entry as a Blob.
 * - Method 0 (STORED): returns a zero-copy disk-backed Blob slice!
 * - Method 8 (DEFLATE): inflates via native DecompressionStream('deflate-raw').
 */
export async function extractZipEntryBlob(blob, entry, mimeType = 'application/octet-stream') {
  const rawSlice = await getEntryDataSlice(blob, entry, mimeType);
  if (entry.method === 0) {
    return rawSlice;
  }
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('此瀏覽器版本不支援 DEFLATE 解壓，請使用未壓縮書包或升級 iOS 16.4+');
    }
    const ds = new DecompressionStream('deflate-raw');
    const decompressedStream = rawSlice.stream().pipeThrough(ds);
    const resp = new Response(decompressedStream);
    const buf = await resp.arrayBuffer();
    return new Blob([buf], { type: mimeType });
  }
  throw new Error(`不支援的 ZIP 壓縮方式 (${entry.method})：${entry.name}`);
}

export async function extractZipEntryText(blob, entry) {
  const b = await extractZipEntryBlob(blob, entry, 'text/plain;charset=utf-8');
  return b.text();
}

export async function extractZipEntryBytes(blob, entry) {
  const b = await extractZipEntryBlob(blob, entry);
  return new Uint8Array(await b.arrayBuffer());
}
