# Sponsor-a-Wedding

A marketplace where a woman sells advertising space on her wedding dress, and brands
bid for it square inch by square inch.

**`squareinch.html` is the current direction.** Open that one first.

Every file is a **single HTML page, no build step, no dependencies** (fonts load from
Google Fonts). Photographs are read locally with `FileReader` and never leave the browser.

## Run it

Double-click `squareinch.html`, or from this folder:

```powershell
start squareinch.html
```

To serve it instead:

```powershell
py -m http.server 8000      # Python is installed under `py`, not `python`
npx serve .                 # or Node
```

Then open `http://localhost:8000/squareinch.html`.

## Square Inch

Proud, rational, exact - and loud about it. The audience is a woman who has costed her
own wedding and worked out that the dress is the only line item that can earn. Nothing
about the page apologises for that, and nothing is cute.

The look is a jewel box that runs a market: deep violet ground, magenta and amber and
aqua, drifting light behind everything. Bodoni Moda carries the voice, Outfit carries
the interface, IBM Plex Mono carries every measurement. The precision lives in the
numbers, not the palette.

Motion: the headline assembles word by word and a white highlighter sweeps across
"Charge for it." on a loop, sections rise as you reach them, the season figures count up,
rate-card heat bars fill, holders land with a spring, and confetti fires when you take
ground off a rival. All of it respects `prefers-reduced-motion`.

**The hero gown is real 3D.** Built with three.js on a mannequin stand: a
bust-waist-hem profile turned into a surface, then displaced into draped satin - two
overlaid fold waves that open toward the hem, a scalloped hem edge, a satin waist sash,
and a cathedral train that sweeps out at the back (spin it to see it). Rendered with
ACES tone mapping and sRGB output, because without those the silk clips to flat white
and every fold disappears.

Drag to spin; let go and it keeps turning. The sponsor panels are textured planes placed
along the true surface normal and lifted clear of the fold ridges, so they sit flush and
wrap with the dress - including one on the back you only find by spinning it. If WebGL
or the CDN is unavailable the hero falls back to the flat SVG gown automatically.

### Using a real gown model

**Drop a `.glb` at `assets/gown.glb` and the hero uses it automatically.** No code
change. The page auto-scales and centres it, applies the environment map, and places the
sponsor panels by **raycasting onto the actual mesh**, so they land on the real surface
wherever it happens to be. If the file is absent, the procedural gown is used instead.
The path was verified end to end with a Khronos sample model.

To publish it as an artifact the file has to be published alongside the page - pass it as
a supporting file rather than relying on the local folder.

Why there isn't one in the repo: every CC0 source checked gates downloads behind a free
account (Meshy, Sketchfab), Poly Pizza's only dress is a low-poly game character that
would look *more* cartoonish, and Smithsonian Open Access - which does hold CC0 scans of
real garments - sits behind bot verification. A licensed model has to come from a human
with an account.

The flow:

1. **Landing** - the gown drawn as a technical flat with real dimension callouts and its
   sellable area; a live spec bar; a **rate card** showing what each panel actually
   clears at; settled listings in a filmstrip; method, figures, clients.
2. **Open an account** - it's my dress, or I'm buying.
3. **Client** - under contract, bids received, area sold, closing clock. Upload
   photographs and choose which one buyers bid against. A full **bid history** with each
   brand's rate, allocation, who they took area from, and whether they still hold it.
   Terms: floor rate, minimum allocation, closing time.
4. **The book** - every open gown with its clearing rate, unsold area and closing timer.
5. **Listing** - mark out an allocation on the gown, state your rate per square inch,
   see the quote, place the bid.

Rival buyers bid every few seconds, so the market moves while you watch.

## The rule the market runs on

The gown is a grid of ~1,300 claimable cells clipped to the silhouette; each cell is a
fixed number of square inches.

- A bid's **rate** is `offer / area = $ per square inch`.
- Overlap settles **cell by cell, not deal by deal**:
  - unsold cell -> allocated to you
  - held cell, `your rate > their rate` -> **reallocated to you**
  - held cell, `their rate >= yours` -> **priced out**, you cannot have it
- You pay `your rate x the area you actually landed` - never for area you were priced
  out of.
- The brand you took area from is **refunded `their rate x the area lost`**, and their
  blended rate is recalculated.

Allocations therefore stop being rectangles almost immediately. The canvas outlines only
the edges where the neighbouring cell has a different owner, which is what makes the
shapes legible. While you drag: **green** unsold, **gold** area you would take, **red
hatch** area you are priced out of.

The engine is `evaluate()` and `commit()` - about 40 lines, no dependencies. Your own
brand always renders in a reserved blue so it never collides with a rival's colour.


## Listings carry real numbers

A brand can't decide on vibes, so every listing states what it's buying:

| Publisher fills in | Brands see |
|---|---|
| Invited / confirmed, venue + type, who's shooting it, gallery, social reach, hashtag, press, livestream yes/no | The same, plus estimated impressions broken into *in the room*, *social + gallery*, *livestream*, and a **cost per thousand** at the current clearing rate |

The estimate is deliberately conservative and shown as a workings rather than one
unaccountable number: guests x exposures across the day, social reach x the share that
actually surfaces, gallery views, and a livestream term only when there is one.

## Gowns and suits

A publisher lists either. Each garment is a silhouette predicate rasterised into the
trading grid, so the market, the drawing and the area maths always agree. Switching
garment restarts bidding, because the shape - and therefore what anyone bought - changes.

## Payments

Card details never touch the page. The server creates a **Stripe Checkout Session** and
the browser is handed to Stripe's hosted page; the secret key stays on the server.

```
cp .env.example .env     # already done - the keys are blank, fill them in
cd server && npm install && npm start
```

Then open `http://localhost:8787`. With blank keys everything still runs and the
checkout drops to **demo mode**; add `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`
and it takes real money.

- `GET /api/config` - publishable key and platform fee, never the secret
- `POST /api/checkout` - **recomputes the amount server-side** from its own copy of the
  listing and validates against that listing's floor rate and minimum allocation. The
  client is never trusted for price.
- `POST /api/webhook` - signature-verified, where you'd mark a placement paid

`.env` is gitignored. `helmet` sets a CSP that admits Stripe and nothing else; `/api` is
rate limited.

## Files

| File | What it is |
|---|---|
| `squareinch.html` | **Current direction.** Precise, proud, adult. |
| `app.html` | Same product, softer bridal-marketplace styling. |
| `demo-a-something-borrowed.html` | Early study: bridal atelier, fixed named panels |
| `demo-b-aisle-500.html` | Early study: race-day auction floor |
| `demo-c-bodice-exchange.html` | Early study: trading terminal, first bite engine |

`build/build-squareinch.py` regenerates `squareinch.html` from
`build/squareinch-shell.html` (markup and CSS) plus the market engine in `app.html`.
Run it from the repo root with `py build/build-squareinch.py`. Edit the shell or
`app.html`, then rebuild - do not hand-edit `squareinch.html`.

## Not real

Every brand, client, rate, bid and statistic is invented for the demo. No real company
is depicted.
