/* Minimal 8-bit RGBA PNG decode/encode on top of node's zlib. */
const zlib = require("zlib");

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let TBL = null;
function crcTable() {
  if (TBL) return TBL;
  TBL = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TBL[n] = c;
  }
  return TBL;
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error("not a png");
  let off = 8, ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error("only 8-bit non-interlaced");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error("unsupported colour type " + ihdr.color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= channels && y > 0 ? out[up + x - channels] : 0;
      const v = raw[src + x];
      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else if (filter === 4) r = v + paeth(a, b, c);
      else throw new Error("bad filter " + filter);
      out[dst + x] = r & 0xff;
    }
  }

  /* everything downstream wants RGBA */
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels, d = i * 4;
    if (channels === 4) { px[d] = out[s]; px[d + 1] = out[s + 1]; px[d + 2] = out[s + 2]; px[d + 3] = out[s + 3]; }
    else if (channels === 3) { px[d] = out[s]; px[d + 1] = out[s + 1]; px[d + 2] = out[s + 2]; px[d + 3] = 255; }
    else if (channels === 2) { px[d] = px[d + 1] = px[d + 2] = out[s]; px[d + 3] = out[s + 1]; }
    else { px[d] = px[d + 1] = px[d + 2] = out[s]; px[d + 3] = 255; }
  }
  return { width: w, height: h, data: px };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encode({ width: w, height: h, data: px }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride),
                Buffer.alloc(stride), Buffer.alloc(stride)];

  /* Pick a filter per row by the usual minimum-sum-of-absolute-differences
     heuristic. Half of this artwork is photographic - a QR code, a portrait,
     a rendered globe - and storing those rows unfiltered makes the files
     three times the size for no gain in quality. */
  for (let y = 0; y < h; y++) {
    const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = px[row + x];
      const a = x >= 4 ? px[row + x - 4] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= 4 && y > 0 ? px[prev + x - 4] : 0;
      cand[0][x] = v;
      cand[1][x] = (v - a) & 0xff;
      cand[2][x] = (v - b) & 0xff;
      cand[3][x] = (v - ((a + b) >> 1)) & 0xff;
      cand[4][x] = (v - paeth(a, b, c)) & 0xff;
    }
    let best = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < stride; x++) { const d = cand[f][x]; cost += d < 128 ? d : 256 - d; }
      if (cost < bestCost) { bestCost = cost; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

module.exports = { decode, encode };
