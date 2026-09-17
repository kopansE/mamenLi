/* Trim the transparent margin off each sponsor mark, and bring it down to a
   sensible size for the web.

     node scripts/trim-logos.js <src dir> <out dir>

   The trim is not tidying. The showcase positions a mark by giving its width
   as a percentage of the photograph, and the price of a spot is its AREA - so
   the file's edges have to be the artwork's edges. A logo delivered inside a
   200px transparent frame is drawn 200px smaller than it claims to be, sits
   off-centre from where it was placed, and its rectangle no longer means
   anything. Run this over any artwork before it goes into public/assets/logos.

   The resize is about the front door being quick. A mark renders about 150
   pixels wide there; artwork has arrived at 2308. Twelve of those is nearly
   two megabytes on the one screen that has to be on the page instantly, and
   not one pixel of it is visible.

   It also reports the trimmed aspect ratio, which is the number the placement
   table in app.js needs in order to know how tall a mark will be.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { decode, encode } = require("./lib/png.js");

const SRC = process.argv[2];
const OUT = process.argv[3];

if (!SRC || !OUT) {
  console.error("usage: node scripts/trim-logos.js <src dir> <out dir>");
  process.exit(2);
}

/* Anything at or under this alpha is margin. Not zero: several of these were
   exported from a photo editor and carry a one-pixel ghost of a rim. */
const CLEAR = 8;

function trim(img) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > CLEAR) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("the whole image is transparent");
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    data.copy(out, y * nw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + nw) * 4);
  }
  return { width: nw, height: nh, data: out };
}

/* The longest side a mark is allowed to keep. Generous - the showcase draws
   these around 150px and a retina phone asks for three times that. */
const LONGEST = 380;

/* Box-average down to the target, premultiplying by alpha first. Averaging
   straight RGB across a transparent edge blends the invisible pixels' colour
   into the visible ones, which is what puts a grey halo around a cut-out
   logo - and a halo is exactly what this whole exercise was about removing. */
function shrink(img, longest) {
  const { width: w, height: h, data } = img;
  const scale = longest / Math.max(w, h);
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 4);

  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * w + sx) * 4, al = data[p + 3] / 255;
          r += data[p] * al; g += data[p + 1] * al; b += data[p + 2] * al;
          a += data[p + 3];
          n++;
        }
      }
      const d = (y * nw + x) * 4;
      const alpha = a / n;
      out[d + 3] = Math.round(alpha);
      if (alpha < 0.5) { out[d] = out[d + 1] = out[d + 2] = 0; continue; }
      const un = n * (alpha / 255);                    /* un-premultiply */
      out[d] = Math.min(255, Math.round(r / un));
      out[d + 1] = Math.min(255, Math.round(g / un));
      out[d + 2] = Math.min(255, Math.round(b / un));
    }
  }
  return { width: nw, height: nh, data: out };
}

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith(".png")).sort()) {
  const img = decode(fs.readFileSync(path.join(SRC, file)));
  const cut = shrink(trim(img), LONGEST);
  const png = encode(cut);
  total += png.length;
  fs.writeFileSync(path.join(OUT, file), png);
  console.log(
    file.padEnd(20),
    `${img.width}x${img.height} -> ${cut.width}x${cut.height}`.padEnd(24),
    `ratio ${(cut.width / cut.height).toFixed(3)}`.padEnd(14),
    `${Math.round(png.length / 1024)}kB`);
}
console.log(`\n${Math.round(total / 1024)}kB for the set.`);
