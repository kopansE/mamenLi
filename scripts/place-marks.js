"use strict";

/* =========================================================================
   Lay the sponsor marks out on the garments, and print the table that goes
   into the SHOWCASE constant in public/assets/js/app.js.

     node scripts/place-marks.js

   Why a program and not a person with a mouse: a mark has to sit ENTIRELY on
   the garment. Somebody prints these and wears them to a wedding, and a patch
   that laps over a shoulder onto the sky is the one thing that makes the whole
   site look fake. At the size the showcase renders, a rectangle overhanging a
   trouser leg by three percent looks fine and is wrong - which is exactly how
   the first version of this table shipped, twice.

   So every candidate rectangle is tested against a mask of the photograph's
   own pixels (test/helpers/cloth-mask.js, shared with the test that keeps the
   table honest afterwards) and a position is only taken when every pixel of it
   is cloth. It runs in Chrome because node here has no JPEG decoder and Chrome
   has one built in.

   Previews land in scratch/place-<photo>.jpg - the mask in green with the
   chosen rectangles drawn on it. Look at them before pasting anything. The
   machine guarantees nothing hangs off an edge. It does not guarantee the
   result is a picture anybody wants to look at.
   ========================================================================= */

const fs = require("fs");
const path = require("path");
const { Browser, findChrome } = require("../test/helpers/cdp.js");
const { startServer } = require("../test/helpers/server.js");
const { MASK_SOURCE, PHOTOS } = require("../test/helpers/cloth-mask.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "scratch");
const PORT = 8796;

/* Width over height of each mark, read off the file that actually ships. A
   ratio rounded to three decimals is not good enough: the browser sizes the
   <img> from the image's own pixels, so a table that disagrees in the third
   decimal renders the rectangle a pixel or two below where this checked it,
   and a mark flush with a hem goes over it. */
const LOGO_DIR = path.join(ROOT, "public/assets/logos");
const RATIO = {};
for (const f of fs.readdirSync(LOGO_DIR)) {
  if (!f.endsWith(".png")) continue;
  const b = fs.readFileSync(path.join(LOGO_DIR, f));
  RATIO[f] = b.readUInt32BE(16) / b.readUInt32BE(20);      /* IHDR width, height */
}

const BRAND = {
  "castro.png": "Castro",
  "chanel.png": "Chanel",
  "max.png": "Max",
  "mcdonalds.png": "McDonald's",
  "osem.png": "Osem",
  "pepsi.png": "Pepsi",
  "prada.png": "Prada",
  "redbull.png": "Red Bull",
  "sano.png": "Sano",
  "spotify.png": "Spotify",
  "strauss.png": "Strauss",
  "zara.png": "Zara",
};

/* Which marks can be read on which cloth, which is not a nicety: a mark nobody
   can see is a spot nobody would pay for.

   Five of these are black wordmarks - Castro, Chanel, Max, Prada, Zara - and
   they disappear on a near-black navy suit. Two are yellow - the McDonald's
   arches and the Osem oval - and they are washed out on ivory satin. The rest
   carry enough of their own colour to sit on anything. So the navy suit gets
   the bright half, the gowns get the dark half plus whatever is saturated, and
   mid-grey p5 takes either. */
const IVORY = ["chanel.png", "pepsi.png", "zara.png", "spotify.png", "prada.png",
  "redbull.png", "castro.png", "sano.png", "max.png", "strauss.png"];
const NAVY = ["mcdonalds.png", "pepsi.png", "spotify.png", "osem.png", "sano.png",
  "strauss.png", "redbull.png"];
const GREY = ["spotify.png", "chanel.png", "pepsi.png", "max.png", "mcdonalds.png",
  "prada.png", "redbull.png", "sano.png", "zara.png"];

/* Six a side. Not because more will not fit - the packer will happily put
   eighteen on a person and every one of them will be on the cloth - but
   because a garment carrying eighteen logos reads as a novelty costume, and
   what is being sold is a spot somebody would pay real money for. Six front
   and six back is also roughly what the real thing looks like.

   Rotated per side and per person, so the front and the back are not the same
   wall of logos twice and all twelve brands still appear across the five. */
const PER_SIDE = 6;
const rot = (list, k) => list.slice(k).concat(list.slice(0, k)).slice(0, PER_SIDE);

const PLAN = {
  "p1-front": rot(IVORY, 0), "p1-back": rot(IVORY, 4),
  "p2-front": rot(IVORY, 2), "p2-back": rot(IVORY, 6),
  "p3-front": rot(IVORY, 5), "p3-back": rot(IVORY, 1),
  "p4-front": rot(NAVY, 0),  "p4-back": rot(NAVY, 4),
  "p5-front": rot(GREY, 0),  "p5-back": rot(GREY, 6),
};

/* A named mark put in a named place, before the packer deals the rest.

   The bodice is the best spot on a gown and the one a sponsor would actually
   pay for - it is what a camera is pointed at all day - but it is also the
   narrowest cloth on the garment, so a packer working top to bottom finds the
   skirt easier and leaves the chest bare. These say "this brand, on this
   panel". Everything else about them is normal: the rectangle still has to
   land wholly inside the mask, and the marks dealt afterwards still have to
   keep clear of it.

   The boxes are the bodice of each gown, measured off the photographs: below
   the neckline, above the waist seam, inside the opaque lace. */
const PINS = {
  "p1-front": [{ logo: "prada.png", box: [43, 32, 58, 41] }],
  "p2-front": [{ logo: "zara.png", box: [42, 27, 58, 37] }],
  "p3-front": [{ logo: "chanel.png", box: [43, 25, 58, 36] }],
};

/* A run of sizes rather than one size, so a garment reads like a sponsor board
   and not like a contact sheet.

   One column, both kinds of garment. Two abreast was tried and it does not
   work: a bodice is narrow, a suit between its sleeves is narrower still, and
   whichever mark loses the toss falls back to wherever it can go - which came
   out as a pile on one side with the other half of the skirt bare. A single
   column down the garment is also what the backs already looked like, and they
   were the ones that read as deliberate.

   The floors are set by what the visitor actually sees, not by what looks fine
   in a 1400-pixel preview. The showcase draws each photograph about 520 pixels
   wide, so a mark at nine percent is 47 pixels across and a wordmark inside it
   has a six-pixel cap height. Three marks shipped that small and none of them
   could be read.

   The two runs differ in scale and in reach. A gown is long and its whole
   length is printable, so the bands cover almost all of it. A suit ends in two
   trouser legs about eight points wide, so its bands stop at four fifths and
   its marks are smaller. */
const LAYOUT = {
  gown: { widths: [13.5, 12.5, 12, 11, 10, 9.5], cols: 1, wmin: 7, span: 0.95 },
  suit: { widths: [12, 11, 10, 9, 7.5, 6.5], cols: 1, wmin: 5, span: 0.8 },
};
const GAP = 1.4;             /* percent of frame width kept clear between marks */
const MIN_HEIGHT = 1.7;      /* percent of frame height, under which a mark is a smudge */

/* rate   - shekels for one point of cover, which is the wearer's own asking
            price in the product's own terms
   frontX - how much more the front is worth than the back

   No two of these are the same and none of them is round. Five listings
   quoting identical tidy totals read as a spreadsheet; five people each asking
   their own price read as five people. The totals fall out of these and the
   area actually covered, so they are not chosen either. */
const WEARER = {
  p4: { name: "Roi Avital", where: "Jerusalem", garment: "suit", rate: 2870, frontX: 1.55 },
  p5: { name: "Amit Barak", where: "Ramat Gan", garment: "suit", rate: 3180, frontX: 1.7 },
  p1: { name: "Maya & Tal", where: "Tel Aviv", garment: "gown", rate: 3060, frontX: 1.6 },
  p2: { name: "Dana Halevi", where: "Caesarea", garment: "gown", rate: 2745, frontX: 1.45 },
  p3: { name: "Noa Lev", where: "Haifa", garment: "gown", rate: 2960, frontX: 1.5 },
};

const PACK = String.raw`
window.packMarks = function (who, jobs, gap, cols, span) {
  const m = window.__mask[who];
  const placed = [];
  const skipped = [];
  const stepPx = Math.max(3, Math.round(m.W * 0.005));
  const gp = Math.round(gap / 100 * m.W);
  /* Every rectangle is checked a few pixels larger than it is. The showcase
     stores x, y and w rounded to a tenth of a percent and the browser rounds
     again when it lays the mark out, so a placement that is exactly flush with
     the edge of the mask here can render one pixel over it. */
  const slack = Math.max(2, Math.round(m.W * 0.003));

  /* Where the cloth actually starts and stops, so the bands below divide the
     garment and not the photograph. */
  let top = m.H, bot = -1;
  for (let y = 0; y < m.H; y++) {
    let any = false;
    for (let x = 0; x < m.W && !any; x += 4) if (m.keep[y * m.W + x]) any = true;
    if (any) { if (y < top) top = y; bot = y; }
  }
  if (bot < 0) return { marks: [], skipped: jobs.map(j => j.logo) };

  /* Marks are dealt into horizontal bands, one to a band, alternately leaning
     left and right of centre. Without this the packer piles everything onto
     the chest - it is the widest open cloth, so it wins every time - and the
     trousers and the hem come out bare.

     The bands cover the top part of the cloth, not all of it. Run to the very
     bottom on a suit and the last band lands on the shoes; a gown can use
     almost its whole length. */
  /* Pinned marks go down first, inside the box they were given, biggest that
     fits and centred in it. They are not exempt from anything - the rectangle
     still has to be wholly on cloth - they simply choose their panel instead
     of taking whatever the bands leave. */
  for (const job of jobs.filter(j => j.box)) {
    const [bx0, by0, bx1, by1] = job.box;
    const px0 = Math.round(bx0 / 100 * m.W), px1 = Math.round(bx1 / 100 * m.W);
    const py0 = Math.round(by0 / 100 * m.H), py1 = Math.round(by1 / 100 * m.H);
    let best = null;
    for (let w = job.wMax; w >= job.wMin - 0.001 && !best; w -= 0.5) {
      const pw = Math.round(w / 100 * m.W);
      const ph = Math.round(pw / job.ratio);
      if (pw > px1 - px0 || ph > py1 - py0) continue;
      let pick = null, pickScore = 1e9;
      const wantX = (px0 + px1) / 2, wantY = (py0 + py1) / 2;
      for (let y = py0; y + ph <= py1; y += 2) {
        for (let x = px0; x + pw <= px1; x += 2) {
          if (!window.allCloth(m, x - slack, y - slack, pw + 2 * slack, ph + 2 * slack)) continue;
          const dx = x + pw / 2 - wantX, dy = y + ph / 2 - wantY;
          const d = dx * dx + dy * dy;
          if (d < pickScore) { pickScore = d; pick = { x, y, w: pw, h: ph }; }
        }
      }
      if (pick) best = pick;
    }
    if (best) placed.push(Object.assign({ logo: job.logo, brand: job.brand }, best));
    else skipped.push(job.logo + " (pinned)");
  }

  const free = jobs.filter(j => !j.box);
  const bands = Math.max(1, Math.ceil(free.length / cols));
  const bandH = (bot - top) * span / bands;

  free.forEach((job, i) => {
    const band = Math.floor(i / cols);
    const lean = i % 2 === 0 ? -1 : 1;          // -1 wants the left of the frame
    const yLo = top + band * bandH, yHi = top + (band + 1) * bandH;

    let best = null;
    for (let w = job.wMax; w >= job.wMin - 0.001 && !best; w -= 0.5) {
      const pw = Math.round(w / 100 * m.W);
      const ph = Math.round(pw / job.ratio);
      if (ph > m.H) continue;
      let pick = null, pickScore = -1e9;
      for (let y = 0; y + ph < m.H; y += stepPx) {
        const cy = y + ph / 2;
        if (cy < yLo || cy > yHi) continue;     // centre must sit in its band
        for (let x = 0; x + pw < m.W; x += stepPx) {
          if (!window.allCloth(m, x - slack, y - slack, pw + 2 * slack, ph + 2 * slack)) continue;
          let clash = false;
          for (const p of placed) {
            if (x < p.x + p.w + gp && x + pw + gp > p.x &&
                y < p.y + p.h + gp && y + ph + gp > p.y) { clash = true; break; }
          }
          if (clash) continue;
          const score = lean * (x + pw / 2);
          if (score > pickScore) { pickScore = score; pick = { x, y, w: pw, h: ph }; }
        }
      }
      if (pick) best = pick;
    }

    /* Nothing fitted in its own band - let it go anywhere rather than lose the
       sponsor, still only where the whole rectangle is cloth. */
    if (!best) {
      for (let w = job.wMax; w >= job.wMin - 0.001 && !best; w -= 0.5) {
        const pw = Math.round(w / 100 * m.W);
        const ph = Math.round(pw / job.ratio);
        if (ph > m.H) continue;
        let pick = null, pickScore = -1;
        for (let y = 0; y + ph < m.H; y += stepPx) {
          for (let x = 0; x + pw < m.W; x += stepPx) {
            if (!window.allCloth(m, x - slack, y - slack, pw + 2 * slack, ph + 2 * slack)) continue;
            let clash = false;
            for (const p of placed) {
              if (x < p.x + p.w + gp && x + pw + gp > p.x &&
                  y < p.y + p.h + gp && y + ph + gp > p.y) { clash = true; break; }
            }
            if (clash) continue;
            let score = 1e9;
            const cx = x + pw / 2, cy = y + ph / 2;
            for (const p of placed) {
              const dx = cx - (p.x + p.w / 2), dy = cy - (p.y + p.h / 2);
              score = Math.min(score, Math.sqrt(dx*dx + dy*dy));
            }
            if (score > pickScore) { pickScore = score; pick = { x, y, w: pw, h: ph }; }
          }
        }
        if (pick) best = pick;
      }
    }

    if (best) placed.push(Object.assign({ logo: job.logo, brand: job.brand }, best));
    else skipped.push(job.logo);
  });

  return {
    skipped,
    marks: placed.map(p => ({
      logo: p.logo, brand: p.brand,
      x: Math.round(p.x / m.W * 1000) / 10,
      y: Math.round(p.y / m.H * 1000) / 10,
      w: Math.round(p.w / m.W * 1000) / 10,
      h: Math.round(p.h / m.H * 1000) / 10,
    })),
  };
};
`;

const PREVIEW = String.raw`
window.markPreview = function (who, marks) {
  const m = window.__mask[who];
  const cv = document.createElement("canvas");
  cv.width = m.W; cv.height = m.H;
  const c = cv.getContext("2d");
  const src = new Image();
  return new Promise(res => {
    src.onload = () => {
      c.drawImage(src, 0, 0);
      const px = c.getImageData(0, 0, m.W, m.H);
      for (let i = 0; i < m.W * m.H; i++) {
        const p = i * 4;
        if (m.keep[i]) px.data[p+1] = 255 - (255 - px.data[p+1]) * 0.35;
        else { px.data[p] = px.data[p] * 0.5 + 118; px.data[p+1] *= 0.5; px.data[p+2] *= 0.5; }
      }
      c.putImageData(px, 0, 0);
      c.strokeStyle = "#0000ff";
      c.lineWidth = Math.max(2, m.W / 300);
      for (const k of marks) {
        c.strokeRect(k.x / 100 * m.W, k.y / 100 * m.H, k.w / 100 * m.W, k.h / 100 * m.H);
      }
      /* Downscaled, and JPEG: a full-size PNG of a 1400x1536 frame crosses the
         debugging socket as five megabytes of base64 and times the call out. */
      const out = document.createElement("canvas");
      out.width = 760; out.height = Math.round(760 * m.H / m.W);
      out.getContext("2d").drawImage(cv, 0, 0, out.width, out.height);
      res(out.toDataURL("image/jpeg", 0.86));
    };
    src.src = "/assets/garments/" + who + ".jpg";
  });
};
`;

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.error("Chrome was not found - set SQUAREINCH_CHROME to its path.");
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const server = await startServer({ port: PORT });
  const browser = await Browser.launch(chrome);
  const packed = {};
  try {
    const page = await browser.newPage({ width: 900, height: 700 });
    await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(MASK_SOURCE + PACK + PREVIEW + "\nreturn 1;");

    for (const [who, o] of Object.entries(PHOTOS)) {
      const info = await page.evaluate(
        `return await window.buildMask(${JSON.stringify(who)}, ${JSON.stringify(o)});`);
      if (info.error) throw new Error(who + ": " + info.error);

      const kit = LAYOUT[WEARER[who.split("-")[0]].garment];

      /* How narrow each mark may go before it stops being legible. A square
         logo is fine at five points wide; Prada is a six-to-one wordmark, and
         five points wide makes it fourteen pixels tall - a smudge. The floor
         is set by the HEIGHT the mark ends up with, which is the dimension
         that decides whether anybody can read it.

         Then the fussiest mark is dealt first, into the widest band. Deal them
         in the order they happen to be listed and a wide wordmark can land on
         a trouser leg, where nothing that shape fits at all, and be dropped. */
      const pins = PINS[who] || [];
      const pinned = new Set(pins.map(p => p.logo));
      const floor = logo =>
        Math.max(kit.wmin, MIN_HEIGHT * (info.H / info.W) * RATIO[logo]);

      const jobs = PLAN[who]
        .filter(logo => !pinned.has(logo))
        .map(logo => ({ logo, brand: BRAND[logo], ratio: RATIO[logo], wMin: floor(logo) }))
        .sort((a, b) => b.wMin - a.wMin)
        .map((job, i) => Object.assign(job, {
          wMax: Math.max(kit.widths[Math.min(i, kit.widths.length - 1)], job.wMin + 1),
        }));

      /* Pinned marks keep their own place in the list but carry a box, and the
         packer puts them down before it deals anything else. */
      for (const p of pins) {
        const wMin = floor(p.logo);
        jobs.unshift({
          logo: p.logo, brand: BRAND[p.logo], ratio: RATIO[p.logo],
          wMin, wMax: Math.max(kit.widths[0], wMin + 1), box: p.box,
        });
      }
      const res = await page.evaluate(
        `return window.packMarks(${JSON.stringify(who)}, ${JSON.stringify(jobs)}, ` +
        `${GAP}, ${kit.cols}, ${kit.span});`);
      packed[who] = res.marks;
      console.log(who.padEnd(10), String(res.marks.length).padStart(2) + " placed",
        res.skipped.length ? "| no room for: " + res.skipped.join(", ") : "");

      const url = await page.evaluate(
        `return await window.markPreview(${JSON.stringify(who)}, ${JSON.stringify(res.marks)});`);
      fs.writeFileSync(path.join(OUT, `place-${who}.jpg`), Buffer.from(url.split(",")[1], "base64"));
    }
    await page.close();
  } finally {
    await browser.close();
    await server.stop();
  }

  /* `h` is carried even though the layout does not need it - the browser gets
     the height from the artwork's own proportions - because the PRICE does.
     A spot is sold by area, so the showcase needs to know how much of the
     garment each mark actually covers. */
  const row = k =>
    `        { side: "${k.side}", x: ${k.x}, y: ${k.y}, w: ${k.w}, h: ${k.h}, logo: "${k.logo}", brand: "${k.brand}" },`;
  const lines = [];
  for (const p of ["p4", "p5", "p1", "p2", "p3"]) {
    const w = WEARER[p];
    lines.push(`    { person: "${p}", name: "${w.name}", where: "${w.where}", garment: "${w.garment}",`);
    lines.push(`      rate: ${w.rate}, frontX: ${w.frontX},`);
    lines.push("      marks: [");
    for (const side of ["front", "back"]) {
      for (const k of packed[`${p}-${side}`]) lines.push(row(Object.assign({ side }, k)));
      if (side === "front") lines.push("");
    }
    lines.push("      ],");
    lines.push("    },");
  }
  fs.writeFileSync(path.join(OUT, "marks.txt"), lines.join("\n"));
  console.log("\nwrote scratch/marks.txt and scratch/place-*.jpg");
  console.log("Look at the previews before pasting, and keep the comments already");
  console.log("in app.js - they say WHY a garment carries the marks it does.");
})().catch(e => { console.error(e); process.exit(1); });
