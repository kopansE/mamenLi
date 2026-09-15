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

**The hero gown is real 3D.** It is a solid of revolution built with three.js from a
bust-waist-hem profile, on a mannequin stand, lit with the page's own magenta and aqua.
Drag it to spin; let go and it keeps turning. The sponsor panels are textured planes
sitting flush on the surface along the true surface normal, so they wrap with the dress -
including one on the back you only find by spinning it. If three.js or WebGL is
unavailable the hero falls back to the flat SVG gown automatically.

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
