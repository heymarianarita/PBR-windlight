// Radiance .hdr (RGBE) decoding. Reads flat, old-style RLE and new-style RLE
// scanlines in the usual `-Y H +X W` orientation (top row first, left to right).

export function decodeHdr(buffer) {
  const bytes = new Uint8Array(buffer);
  const { width, height, pos } = readHeader(bytes);
  const data = new Float32Array(width * height * 3);
  const line = new Uint8Array(width * 4);
  let p = pos;
  for (let y = 0; y < height; y++) {
    p = readScanline(bytes, p, line, width);
    for (let x = 0; x < width; x++) rgbeToFloat(line, x * 4, data, (y * width + x) * 3);
  }
  return { width, height, data };
}

// ---------- Header ----------

function readHeader(bytes) {
  let pos = 0;
  const nextLine = () => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
    if (pos >= bytes.length) throw new Error('Not a Radiance .hdr file: header never ends');
    const s = String.fromCharCode(...bytes.subarray(start, pos));
    pos++;
    return s;
  };

  if (!nextLine().startsWith('#?')) throw new Error('Not a Radiance .hdr file: missing #? signature');
  let format = '';
  for (let s = nextLine(); s.trim() !== ''; s = nextLine()) {
    if (s.startsWith('FORMAT=')) format = s.slice(7).trim();
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`Unsupported .hdr format: ${format} (only RGBE is supported)`);

  const res = nextLine().trim().match(/^-Y\s+(\d+)\s+\+X\s+(\d+)$/);
  if (!res) throw new Error('Unsupported .hdr orientation: only "-Y height +X width" is supported');
  const height = Number(res[1]);
  const width = Number(res[2]);
  if (!width || !height) throw new Error('Bad .hdr size');
  return { width, height, pos };
}

// ---------- Scanlines ----------

function readScanline(bytes, p, line, width) {
  need(bytes, p, 4);
  const newRle = width >= 8 && width < 0x8000 && bytes[p] === 2 && bytes[p + 1] === 2 && !(bytes[p + 2] & 0x80);
  if (!newRle) return readFlat(bytes, p, line, width);
  if (((bytes[p + 2] << 8) | bytes[p + 3]) !== width) throw new Error('Bad .hdr scanline: width mismatch');
  p += 4;
  // Each channel is run-length encoded separately.
  for (let c = 0; c < 4; c++) {
    let x = 0;
    while (x < width) {
      need(bytes, p, 1);
      let n = bytes[p++];
      if (n > 128) {
        n -= 128;
        if (x + n > width) throw new Error('Bad .hdr scanline: run too long');
        need(bytes, p, 1);
        const v = bytes[p++];
        for (let i = 0; i < n; i++) line[(x++) * 4 + c] = v;
      } else {
        if (n === 0 || x + n > width) throw new Error('Bad .hdr scanline: bad literal count');
        need(bytes, p, n);
        for (let i = 0; i < n; i++) line[(x++) * 4 + c] = bytes[p++];
      }
    }
  }
  return p;
}

// Flat pixels, with the old-style (1,1,1,n) repeat marker.
function readFlat(bytes, p, line, width) {
  let x = 0;
  let shift = 0;
  while (x < width) {
    need(bytes, p, 4);
    if (bytes[p] === 1 && bytes[p + 1] === 1 && bytes[p + 2] === 1) {
      if (x === 0) throw new Error('Bad .hdr scanline: repeat with nothing before it');
      const n = bytes[p + 3] << shift;
      if (x + n > width) throw new Error('Bad .hdr scanline: run too long');
      for (let i = 0; i < n; i++, x++) line.copyWithin(x * 4, (x - 1) * 4, x * 4);
      shift += 8;
    } else {
      line.set(bytes.subarray(p, p + 4), x * 4);
      x++;
      shift = 0;
    }
    p += 4;
  }
  return p;
}

function need(bytes, p, n) {
  if (p + n > bytes.length) throw new Error('Bad .hdr file: data ends early');
}

function rgbeToFloat(src, i, dst, j) {
  const e = src[i + 3];
  if (e === 0) {
    dst[j] = dst[j + 1] = dst[j + 2] = 0;
    return;
  }
  const f = Math.pow(2, e - 136);
  dst[j] = (src[i] + 0.5) * f;
  dst[j + 1] = (src[i + 1] + 0.5) * f;
  dst[j + 2] = (src[i + 2] + 0.5) * f;
}
