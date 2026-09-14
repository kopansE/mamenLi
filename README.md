# Sponsor-a-Wedding

A marketplace where couples sell advertising space on a wedding dress and brands bid
for it, square inch by square inch.

**`app.html` is the product.** It is the full flow: landing page -> sign up as a couple or
a brand -> couples upload photos and watch who bid what -> brands browse every open dress
and bid on the ones they want. The other three files are earlier visual-direction studies,
kept for reference.

Every file is a **single HTML page with no build step and no dependencies** (fonts load
from Google Fonts). Photos are read locally with `FileReader` and never leave the browser.

## Run it

Double-click `app.html`, or from this folder:

```powershell
start app.html
```

To serve it instead (any static server works):

```powershell
py -m http.server 8000      # Python is installed under `py`, not `python`
npx serve .                 # or Node
```

Then open `http://localhost:8000/app.html`.

## The flow in `app.html`

1. **Landing** - hero, CTA, an auto-advancing carousel of finished weddings in arched
   frames, a brand marquee, how-it-works tabs for each side, figures, testimonials.
2. **Sign in / sign up** - pick your side of the aisle: getting married, or a brand.
3. **Couple dashboard** - raised so far, bids received, % of dress claimed, a live
   closing clock. Upload photos and pick which one brands bid on. A **who bid what**
   table showing every bid, the price per square inch, and whether that brand is still
   holding or has been outbid. Listing settings: floor price, minimum claim, closing date.
4. **Brand browse** - every open dress as a card with a live thumbnail of who holds what,
   a closing timer, % claimed and money raised. Search and filters.
5. **Brand listing** - drag a rectangle anywhere on the dress, set your price per square
   inch, and place the bid.

Rival brands bid against you every few seconds, so the market moves while you watch.

## The bite rule

The mechanic the whole marketplace runs on. The dress is a grid of ~1,300 claimable
cells clipped to the gown silhouette; each cell is a fixed number of square inches.

- A claim's **density** is `offer / area = $ per square inch`.
- Overlap is settled **cell by cell, not deal by deal**:
  - empty cell -> you take it
  - held cell, `your density > their density` -> **you bite it out of their shape**
  - held cell, `their density >= yours` -> **blocked**, you cannot have it
- You pay `your density x the area you actually landed` - never for space you were
  blocked from.
- The brand you bit is **refunded `their density x the area they lost`**, and their
  blended price per inch is recalculated.

So regions stop being rectangles almost immediately - they become Ls, rings and
staircases. The canvas draws each holder by outlining only the edges where the
neighbouring cell has a different owner, which is what makes the bites legible.

While you drag you get a live three-colour readout: **green** open fabric, **gold** space
you would take off a rival, **red hatch** space you are priced out of.

The engine is `evaluate()` and `commit()` in `app.html` - about 40 lines, no dependencies.

The couple controls the floor price per square inch, the smallest claim they will accept,
and when bidding closes.

## The earlier direction studies

| File | Direction | Auction model |
|---|---|---|
| `demo-a-something-borrowed.html` | Bridal atelier, quiet | Fixed named panels, open outcry, couple has veto |
| `demo-b-aisle-500.html` | Race-day scoreboard, loud | Fixed panels, live floor, hammer drops, confetti |
| `demo-c-bodice-exchange.html` | Trading terminal, dense | The bite rule, first version |

`app.html` takes the visual language of A and the mechanic of C, and puts both behind a
proper landing page.

## Not real

Every brand, couple, price, bid and statistic is invented for the demo. No real company
is depicted.
