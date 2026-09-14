# Sponsor-a-Wedding — three concept demos

Three self-contained prototypes of a marketplace where couples sell advertising space on
a wedding dress and brands bid for it. Pick a direction, then we build it for real.

Each demo is a **single HTML file with no build step and no dependencies** (fonts come from
Google Fonts over the network). Everything runs in the browser — no server, no accounts,
no data leaves the page. Photo uploads are read locally with `FileReader` and never sent
anywhere.

## Run it

Double-click any of the three `.html` files, or:

```bash
# from this folder
start demo-a-something-borrowed.html      # Windows
```

If you'd rather serve them (recommended, so the browser treats them as a normal site):

```bash
python -m http.server 8000
# then open http://localhost:8000/demo-a-something-borrowed.html
```

Any static server works — `npx serve .`, VS Code Live Server, whatever you already have.

## The three demos

| File | Name | Aesthetic | Auction model |
|---|---|---|---|
| `demo-a-something-borrowed.html` | **Something Borrowed** | Bridal atelier — Italiana/Karla, oyster + bordeaux, quiet | Fixed panels, open outcry, couple has veto |
| `demo-b-aisle-500.html` | **Aisle 500** | Race-day scoreboard — Anton, neon on black, loud | Fixed panels, live auction floor, hammer drops |
| `demo-c-bodice-exchange.html` | **Bodice Exchange** | Trading terminal — Instrument Serif + IBM Plex, dense | Free-form land grab, price per square inch |

### A — Something Borrowed
Genteel. Six named panels (veil, bodice, sash, skirts, cathedral hem). The couple opens a
panel, sets an opening price and a closing window, and brands raise each other. Two things
make it *bridal* rather than *commercial*: the couple may **accept any bidder on the
ledger, not just the highest**, and a bid in the last 30 seconds pushes the clock back so
nobody snipes a wedding.

### B — Aisle 500
Maximum fun. An arena: live bid ticker across every wedding on the card, quick-bid chips,
auto-bid with a cap, outbid sirens, a leaderboard of who's actually spending, an F1
lights-out sequence when the couple opens a panel, and confetti when the hammer drops.

### C — Bodice Exchange — *the one with your overlap rule*
This is where the "brands can bite into each other's space" mechanic lives.

- The gown is a grid of ~1,400 claimable cells, each worth a fixed number of square inches.
- A brand **drags any rectangle** on the dress and names a price. That gives a
  **density**: `offer ÷ area = $ per square inch`.
- The overlap is settled **cell by cell, not deal by deal**:
  - empty cell → you take it
  - held cell where `your density > their density` → **you bite it out of their shape**
  - held cell where `their density ≥ yours` → **blocked**, you can't have it
- You pay `your density × the area you actually landed` — never for space you were
  blocked from.
- The brand you bit is **refunded `their density × the area they lost`** and their
  blended price per inch is recalculated. Their shape is now an L, or a ring, or worse.
- While you drag you get a live three-colour readout: green = open fabric, gold = you'd
  bite it, red hatch = priced out. That's the fun part.

Because of all this, **regions stop being rectangles almost immediately** — which is the
point. The canvas draws each holder's region by outlining only the edges where the
neighbouring cell has a different owner, so the bites read clearly.

Rules the couple controls from the Couple desk: floor price per square inch, smallest
claim they'll accept, and when bidding closes.

## Notes on the fork

A and B use **fixed panels**; C uses the **free-form land grab**. That's a real product
decision, not just a visual one:

- Fixed panels are easier to explain, easier to price, and easier for a seamstress to
  actually execute. Better for the first version.
- The land grab is far more fun and creates genuine competitive tension, but every claim
  is a different irregular shape someone has to physically make.

The bite engine in C is self-contained (`evaluate()` and `commit()` in
`demo-c-bodice-exchange.html`) and ports cleanly onto A or B if you like one of those
looks better.

## Not real

Every brand, couple, price, bid and statistic in these files is invented for the demo.
No real company is depicted.
