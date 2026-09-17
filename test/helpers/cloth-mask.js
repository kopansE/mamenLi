"use strict";

/* =========================================================================
   Where the cloth is, in each garment photograph.

   This exists for one assertion: a sponsor's mark must sit ENTIRELY on the
   garment. Somebody has to print these and wear them to a real wedding, and a
   rectangle that laps over a shoulder is the one thing that makes the whole
   product look fake. The showcase table in app.js was packed against these
   masks in the first place; this is what keeps it honest when somebody moves
   a number by hand afterwards.

   It runs in the browser rather than in node, because node here has no JPEG
   decoder and Chrome has one built in. The test hands the source below to the
   page, which draws each photograph onto a canvas and reads it back.
   ========================================================================= */

const MASK_SOURCE = String.raw`

window.__mask = {};

window.buildMask = async function (who, o) {
  const img = new Image();
  img.src = "/assets/garments/" + who + ".jpg";
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const px = i => { const p = i * 4; return [d[p], d[p+1], d[p+2]]; };

  /* ---------------------------------------------------- 1. what is a body
     Two ways, because these photographs were not shot the same way. Nine of
     them are a person on a seamless studio backdrop, where growing a region
     inward from the border with a SMALL local step follows the backdrop's own
     gradient and dies at the edge of the garment. p1 was shot on a terrace in
     front of a villa, and there nothing automatic works: flooding the
     background dies in the first cypress, growing the gown outward leaks into
     the lawn, and no brightness threshold separates ivory lace from sunlit
     stone. Those two frames carry an outline measured by hand instead. */
  const body = new Uint8Array(n);
  const step = (a, b) => {
    const p = a * 4, r = b * 4;
    return Math.abs(d[p]-d[r]) + Math.abs(d[p+1]-d[r+1]) + Math.abs(d[p+2]-d[r+2]);
  };
  if (o.mode === "ribbon") {
    /* Measured off the photograph by hand, as a left and a right edge every
       few percent of height, interpolated between. p1 is the only frame that
       needs this and it earns it: she is standing on a terrace in front of a
       villa, so there is no backdrop to flood and no threshold that separates
       ivory lace from sunlit stone. Every other frame is a person on seamless
       paper and the machine does it better than a hand would.

       The rows are deliberately a point or two INSIDE the real edge. The
       erode step then pulls further in again, and a printed patch that sits a
       little inboard of the hem looks like a decision. One that laps over it
       looks like a bug - which is the whole complaint. */
    const rows = o.rows;
    const spanAt = pct => {
      if (pct <= rows[0][0]) return null;
      if (pct >= rows[rows.length - 1][0]) return null;
      for (let k = 1; k < rows.length; k++) {
        if (pct <= rows[k][0]) {
          const [aY, aL, aR] = rows[k - 1], [bY, bL, bR] = rows[k];
          const t = (pct - aY) / (bY - aY);
          return [aL + (bL - aL) * t, aR + (bR - aR) * t];
        }
      }
      return null;
    };
    for (let y = 0; y < H; y++) {
      const span = spanAt(y / H * 100);
      if (!span) continue;
      const xa = Math.round(span[0] / 100 * W), xb = Math.round(span[1] / 100 * W);
      for (let x = xa; x <= xb; x++) body[y * W + x] = 1;
    }
  } else {
    const bg = new Uint8Array(n);
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    const push = i => { if (!bg[i]) { bg[i] = 1; q[tail++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      if (x > 0 && !bg[i-1] && step(i-1, i) <= o.tol) push(i-1);
      if (x < W-1 && !bg[i+1] && step(i+1, i) <= o.tol) push(i+1);
      if (y > 0 && !bg[i-W] && step(i-W, i) <= o.tol) push(i-W);
      if (y < H-1 && !bg[i+W] && step(i+W, i) <= o.tol) push(i+W);
    }
    for (let i = 0; i < n; i++) body[i] = bg[i] ? 0 : 1;
  }

  /* --------------------------------------- 2. only the blob she is standing in
     Throws away every speck the first pass found elsewhere in the frame - a
     shadow on the backdrop, a balustrade, a cypress. Seeded on the garment
     itself, so whatever survives is one continuous piece of cloth. */
  const seed = Math.round(o.seedY / 100 * H) * W + Math.round(o.seedX / 100 * W);
  if (!body[seed]) return { who, W, H, error: "the seed point is not on the body" };
  const one = new Uint8Array(n);
  {
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    one[seed] = 1; q[tail++] = seed;
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      if (x > 0 && body[i-1] && !one[i-1]) { one[i-1] = 1; q[tail++] = i-1; }
      if (x < W-1 && body[i+1] && !one[i+1]) { one[i+1] = 1; q[tail++] = i+1; }
      if (y > 0 && body[i-W] && !one[i-W]) { one[i-W] = 1; q[tail++] = i-W; }
      if (y < H-1 && body[i+W] && !one[i+W]) { one[i+W] = 1; q[tail++] = i+W; }
    }
  }

  /* ------------------------------------------------- 3. cloth, not the person
     Skin is warm - red over green over blue by a margin neither ivory satin
     nor navy worsted reaches - and heads, collars, shoes and the train on the
     floor are cut off by the two horizontals. */
  const yTop = Math.round(o.yTop / 100 * H), yBot = Math.round(o.yBot / 100 * H);
  const cloth = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!one[i]) continue;
    const y = (i / W) | 0;
    if (y < yTop || y > yBot) continue;
    const [R, G, B] = px(i);
    if (R > G && G > B && (R - B) > o.warmth && R > 55) continue;
    cloth[i] = 1;
  }

  /* --------------------------------------------- 3a. the bits of it nobody prints on
     Rectangles struck out by hand, for the parts of a garment that are inside
     the silhouette, are unarguably cloth, and are still no place for a printed
     patch.

     Sleeves are the whole reason this exists. On a fitted suit the arm touches
     the ribs, so no backdrop shows between them, so no amount of looking at
     pixels will tell you where the jacket body stops and the sleeve begins -
     and the packer, seeing one wide panel, lays a mark straight across the
     crease. On the page that reads as a logo floating in the gap between the
     arm and the body, which is the one thing a printed garment cannot do.
     Also here: a bride's clasped hands, and an arm hanging clear of a skirt. */
  for (const [ex0, ey0, ex1, ey1] of (o.cutouts || [])) {
    const cy0 = Math.max(0, Math.round(ey0 / 100 * H));
    const cy1 = Math.min(H - 1, Math.round(ey1 / 100 * H));
    const cx0 = Math.max(0, Math.round(ex0 / 100 * W));
    const cx1 = Math.min(W - 1, Math.round(ex1 / 100 * W));
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) cloth[y * W + x] = 0;
  }

  /* ------------------------------------------------------- 3b. close pinholes
     Champagne lace goes warm in its own shadows, so the skin test punches
     freckles out of the middle of a skirt, and they block placements that are
     perfectly good. Any pocket of not-cloth entirely surrounded by cloth gets
     filled back in - but ONLY if it is compact in both directions.

     That second condition is load-bearing and was learned the hard way. The
     sliver of backdrop showing between a man's arm and his ribs is also fully
     enclosed, and it is small by area: ten pixels wide and four hundred tall.
     A rule that only looked at area filled it in, and marks were then packed
     into the gap between the arm and the body - printed on nothing, which is
     the exact thing this mask exists to prevent. A freckle is round. A gap
     beside an arm is a slot. Measure both sides. */
  {
    const seen = new Uint8Array(n);
    const q = new Int32Array(n);
    const maxW = Math.round(0.035 * W), maxH = Math.round(0.035 * H);
    for (let start = 0; start < n; start++) {
      if (cloth[start] || seen[start]) continue;
      let headL = 0, tailL = 0, open = false;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      const comp = [];
      seen[start] = 1; q[tailL++] = start;
      while (headL < tailL) {
        const i = q[headL++], x = i % W, y = (i / W) | 0;
        comp.push(i);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        const look = j => { if (!cloth[j] && !seen[j]) { seen[j] = 1; q[tailL++] = j; } };
        if (x > 0) look(i - 1); else open = true;
        if (x < W - 1) look(i + 1); else open = true;
        if (y > 0) look(i - W); else open = true;
        if (y < H - 1) look(i + W); else open = true;
      }
      if (!open && (x1 - x0) <= maxW && (y1 - y0) <= maxH) {
        for (const i of comp) cloth[i] = 1;
      }
    }
  }

  /* --------------------------------------------------------------- 4. erode
     A mark may not be placed against the silhouette. Requiring 'pad' cloth
     pixels in every direction pulls the whole usable area in by that much,
     which is what keeps a printed patch on the fabric and off the sky. */
  const pad = Math.max(1, Math.round(o.margin / 100 * W));
  const rows = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let run = 0;
    for (let x = 0; x < W; x++) { run = cloth[base+x] ? run + 1 : 0; rows[base+x] = run >= pad ? 1 : 0; }
    run = 0;
    for (let x = W - 1; x >= 0; x--) { run = cloth[base+x] ? run + 1 : 0; if (run < pad) rows[base+x] = 0; }
  }
  const keep = new Uint8Array(n);
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y < H; y++) { const i = y*W+x; run = rows[i] ? run + 1 : 0; keep[i] = run >= pad ? 1 : 0; }
    run = 0;
    for (let y = H - 1; y >= 0; y--) { const i = y*W+x; run = rows[i] ? run + 1 : 0; if (run < pad) keep[i] = 0; }
  }

  /* A summed-area table over 'keep', so "is this whole rectangle cloth?" is
     four lookups instead of a loop. The packer asks it tens of millions of
     times. */
  const sat = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += keep[y * W + x];
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + rowSum;
    }
  }

  window.__mask[who] = { W, H, keep, sat };
  let on = 0; for (let i = 0; i < n; i++) on += keep[i];
  return { who, W, H, pad, coverage: Math.round(1000 * on / n) / 10 };
};

/* Every pixel of the rectangle is cloth? */
window.allCloth = function (m, x0, y0, w, h) {
  if (x0 < 0 || y0 < 0 || x0 + w > m.W || y0 + h > m.H) return false;
  const S = m.sat, P = m.W + 1;
  const a = S[y0 * P + x0], b = S[y0 * P + x0 + w];
  const c = S[(y0 + h) * P + x0], e = S[(y0 + h) * P + x0 + w];
  return (e - b - c + a) === w * h;
};
`;

/* How each photograph is turned into a cloth mask.

   mode   - "flood" for the eight studio frames (background grown inward from
            the border), "ribbon" for p1, measured by hand
   tol    - local step for the flood; small, because a seamless backdrop is a
            smooth gradient and the edge of a garment is not
   seedX/Y- a point that is definitely on the garment, used to throw away
            every blob that is not the one being worn
   yTop   - nothing above this is cloth: head, collar, bare shoulders, the
            sheer illusion panels several of these gowns carry
   yBot   - nothing below: shoes, and the train pooled on the floor
   warmth - how far into red (R minus B) a pixel may go before it is called
            skin. Measured, not guessed: on these frames bare skin runs 37 to
            82 and fabric tops out at 29, so the gowns sit at 33 - champagne
            satin is warm, and a threshold set for navy worsted eats holes in
            it. The suits can be stricter because navy and grey are cold. p1 is
            999, because its hand-drawn ribbon already excludes every inch of
            her that is not gown, and any threshold low enough to catch an arm
            would eat her champagne lace.
   cutouts - [x0, y0, x1, y1] rectangles struck out by hand, for cloth that is
            genuinely cloth and still no place for a printed patch. Sleeves,
            mostly: on a fitted suit the arm touches the ribs, so no backdrop
            shows between them and nothing in the pixels says where the jacket
            body ends. Without these the packer lays a mark across the crease
            and it reads as a logo floating in the gap beside the arm.
   margin - percent of the frame width eroded off every edge of the mask */
const PHOTOS = {
  "p1-front": {
    mode: "ribbon", seedX: 50, seedY: 65, yTop: 32, yBot: 85, warmth: 999, margin: 1.3,
    /* Read off a 2% grid laid over the rendered panel, right edge and left
       edge at each row. The first attempt at this was eyeballed off a
       screenshot and ran three to five points wide down the whole right side,
       which put a Pepsi roundel half on the terrace. Measure it. */
    rows: [
      /* The first three rows are the beaded bodice, and they are measured to
         the edge of the opaque lace rather than a point inside it - a wordmark
         across the bust is the spot on this gown, and at a point narrower
         nothing legible fits between the sheer sleeves. */
      [32, 43, 57], [38, 42, 58], [42, 41, 58], [46, 41, 57], [50, 40, 57],
      [55, 38, 58], [60, 36, 60], [65, 35, 61], [70, 34, 63], [75, 32, 64],
      [80, 31, 65], [86, 30, 67],
    ],
    /* her hands are clasped across the centre of the skirt */
    cutouts: [[41, 45, 55, 57]],
  },
  "p1-back": {
    mode: "ribbon", seedX: 50, seedY: 65, yTop: 40, yBot: 83, warmth: 999, margin: 1.3,
    rows: [
      [40, 46, 54], [45, 44, 55], [50, 42, 57], [55, 40, 59], [60, 38, 61],
      [65, 36, 63], [70, 33, 65], [75, 31, 68], [80, 28, 71], [84, 27, 73],
    ],
    /* her right arm hangs clear of the gown down to the hip */
    cutouts: [[60, 39, 70, 54]],
  },
  /* Both of p2's sleeves are sheer illusion lace over bare arm, and that is
     the one thing no colour test can catch: measured, the lace-over-skin sits
     at saturation 24 and the gown's own champagne satin at 21, so any
     threshold that removes the arm removes the dress. A logo landed on her
     forearm and it looked exactly as bad as it sounds. Struck out by hand. */
  "p2-front": { mode: "flood", tol: 8, seedX: 50, seedY: 60, yTop: 27, yBot: 85, warmth: 33, margin: 1.3,
    cutouts: [[32, 24, 43.5, 58], [56.5, 24, 68, 58]] },
  "p2-back":  { mode: "flood", tol: 8, seedX: 50, seedY: 60, yTop: 39, yBot: 83, warmth: 33, margin: 1.3,
    cutouts: [[32, 24, 43, 58], [57, 24, 68, 58]] },
  "p3-front": { mode: "flood", tol: 8, seedX: 50, seedY: 60, yTop: 25, yBot: 90, warmth: 33, margin: 1.3,
    /* her right hand rests on the skirt, and the bodice is cut away under
       each bare arm */
    cutouts: [[53, 47, 63, 58], [36, 26, 44, 40], [57, 26, 65, 40]] },
  "p3-back":  { mode: "flood", tol: 8, seedX: 50, seedY: 60, yTop: 30, yBot: 85, warmth: 33, margin: 1.3,
    /* Her arms, and then the zip: a metal zip tape and a vertical line of
       crystal buttons run down the centre of the satin band and on into the
       skirt. garments/manifest.json already says so. Ink does not cross a zip,
       so the centre line is struck out and the back is two panels. */
    cutouts: [[33, 33, 41, 46], [58, 33, 66, 46], [48.5, 29, 51.5, 52]] },

  /* The four suit frames. The sleeves are struck out of all of them: a
     fitted jacket leaves no backdrop between the arm and the ribs, so the
     mask cannot find the crease on its own. Numbers read off the runs the
     background flood DOES find lower down, where the arm swings clear.
     The two fronts also start at y31 rather than y22, which is below the tie
     knot - a jacket hangs open, so above that line the centre of the frame is
     shirt and necktie, and a sponsor has not bought those. */
  "p4-front": { mode: "flood", tol: 8, seedX: 50, seedY: 45, yTop: 31, yBot: 88, warmth: 22, margin: 1.3,
    cutouts: [[26, 20, 45, 58], [66, 20, 80, 58]] },
  "p4-back":  { mode: "flood", tol: 8, seedX: 48, seedY: 35, yTop: 20, yBot: 90, warmth: 22, margin: 1.3,
    cutouts: [[24, 18, 39, 58], [58, 18, 74, 58]] },
  /* p5 is not wearing a jacket - waistcoat, shirt and trousers - so the shapes
     here are nothing like p4's. What is struck out is the SHIRT sleeves: they
     are a different garment from the one being sold, they are pale where the
     waistcoat is mid-grey, and they hang clear of the body with backdrop
     showing between forearm and hip. The upside is that a waistcoat back is
     one flat unbroken panel, which is the best surface either man has.

     The third rectangle on each is the waistcoat hem. A waistcoat ends and the
     trousers begin, and a mark laid across that line spans two garments. */
  "p5-front": { mode: "flood", tol: 8, seedX: 50, seedY: 42, yTop: 31, yBot: 90, warmth: 22, margin: 1.3,
    cutouts: [[20, 17, 41, 50], [59, 17, 80, 50], [39, 45, 61, 53]] },
  "p5-back":  { mode: "flood", tol: 8, seedX: 48, seedY: 30, yTop: 20, yBot: 92, warmth: 22, margin: 1.3,
    cutouts: [[20, 17, 39, 50], [58, 17, 80, 50], [35, 44, 61, 50]] },
};

module.exports = { MASK_SOURCE, PHOTOS };
