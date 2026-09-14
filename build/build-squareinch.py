# Builds squareinch.html = build/squareinch-shell.html (markup + CSS)
#                        + the tested market engine lifted from app.html,
#                          with copy rewritten for the Square Inch voice.
# Run from the repo root:  py build/build-squareinch.py

import io, os
os.chdir(r"C:\Users\evyat\OneDrive\Desktop\sponsors for fun")

h = io.open("build/squareinch-shell.html", encoding="utf-8").read()
s = io.open("app.html", encoding="utf-8").read()
js = s[s.index("<script>"):]

R = [
('<button class="btn ghost sm" id="nav-browse">Browse dresses</button>',
 '<button class="btn ghost sm" id="nav-browse">The book</button>'),
('<button class="btn sm" data-auth="client">Get started</button>',
 '<button class="btn sm red" data-auth="client">Price my dress</button>'),

# carousel caption -> settlement record
('''        <div class="cap"><div class="n">${s.n}</div><div class="m">${s.m}</div>
          <div class="r">\\u2726 ${s.r}</div></div>''',
 '''        <div class="cap"><div class="n">${s.n}</div>
          <div class="r">${s.r.replace(" raised","")}</div>
          <div class="m">${s.m}</div></div>'''),

# method copy - proud, rational, exact
('''    couple:[
      ["01","Photograph the dress","Upload a front-on photo. It stays in your browser \\u2014 we never need the original."],
      ["02","Set your floor and your date","Name the least you'll take per square inch, and the moment bidding stops."],
      ["03","Approve, then get paid","Brands bid against each other. You approve the winners. Money lands the morning after."]],
    brand:[
      ["01","Browse open dresses","Filter by guest count, city and closing time. Every listing shows what space is left."],
      ["02","Claim the space you want","Drag a rectangle on the dress and name your price per square inch."],
      ["03","Outbid, or get bitten","Pay more per inch than the brand holding a spot and you take it off them. They can do the same to you."]]''',
 '''    couple:[
      ["01","Measure it","One front-on photograph. We compute the sellable area to the square inch. The file never leaves your browser."],
      ["02","Set your terms","A floor rate, a minimum allocation, and the exact time bidding closes. Nothing clears below your floor."],
      ["03","Approve and settle","They bid against each other. You approve the names. Payment the morning after, less nothing until then."]],
    brand:[
      ["01","Read the book","Every open gown with its clearing rate, unsold area and closing time. No calls, no rate negotiation."],
      ["02","Mark your allocation","Draw the area you want and state your rate per square inch. You are quoted before you commit."],
      ["03","Outrate, or be outrated","A higher rate takes the inches off whoever holds them. They are refunded for what they lose, and can do it back."]]'''),

# voice
('toast("Listing ready \\u2014 add a photo and set your floor price.", "good");',
 'toast("Listing open. Add a photograph and set your floor rate.", "good");'),
('toast("Signed in as " + name + ". Pick a wedding to bid on.", "good");',
 'toast(name + " signed in. The book is open.", "good");'),
('toast("That photo is now the one brands bid on.", "good");',
 'toast("That photograph is now the one buyers bid against.", "good");'),
('toast("Bidding closed. Holdings are final.")', 'toast("Bidding closed. Allocations are final.")'),

('''    toast(bitten
      ? `Bid placed \\u2014 you took ${Math.round(bitten*SQIN)} sq in off ${Object.keys(ev.lostBy).length} brand(s).`
      : `Bid placed \\u2014 ${Math.round(ev.winArea)} sq in of open fabric is yours.`, "good");''',
 '''    toast(bitten
      ? `Bid accepted. ${Math.round(bitten*SQIN)} sq in taken from ${Object.keys(ev.lostBy).length} brand(s) at a higher rate.`
      : `Bid accepted. ${Math.round(ev.winArea)} sq in allocated.`, "good");'''),

('toast(name + " took " + Math.round(ev.bite.length*SQIN) + " sq in off you at " + money2(d) + "/in\\u00b2.", "bad");',
 'toast(name + " outrated you at " + money2(d) + "/in\\u00b2 \\u2014 " + Math.round(ev.bite.length*SQIN) + " sq in reallocated.", "bad");'),

('''    toast("Saved. Bidding is open for " + fmtClock(c.mkt.closesAt - Date.now()) + ".", "good");''',
 '''    toast("Terms published. Bidding closes in " + fmtClock(c.mkt.closesAt - Date.now()) + ".", "good");'''),

('''        if(current === "client" && session && c.id === session.coupleId)
          toast("Bidding closed. " + c.mkt.holders.filter(h=>h.cells>0).length + " brands are on your dress.", "good");''',
 '''        if(current === "client" && session && c.id === session.coupleId)
          toast("Closed. " + c.mkt.holders.filter(h=>h.cells>0).length +
                " brands hold allocations, settling " + money(raisedOf(c)) + ".", "good");'''),

('''    $("auth-title").textContent = authMode === "up" ? "Create your account" : "Welcome back";
    $("auth-lead").textContent  = authMode === "up"
      ? "First, which side of the aisle are you on?" : "Sign in as a couple or a brand.";
    $("name-label").textContent = authRole === "client" ? "Your names" : "Brand name";
    $("au-name").value = authRole === "client" ? "Maya & Tal" : "Caffeina";
    $("auth-go").textContent = authMode === "up"
      ? (authRole === "client" ? "Create my listing" : "Start browsing dresses")
      : "Sign in";
    $("auth-swap").innerHTML = authMode === "up"
      ? `Already have an account? <button id="auth-toggle">Sign in</button>`
      : `New here? <button id="auth-toggle">Create an account</button>`;''',
 '''    $("auth-title").textContent = authMode === "up" ? "Open an account" : "Welcome back";
    $("auth-lead").textContent  = authMode === "up"
      ? "Which side of the table are you on?" : "Sign in as a client or a buyer.";
    $("name-label").textContent = authRole === "client" ? "Your name" : "Brand name";
    $("au-name").value = authRole === "client" ? "Maya Aviram" : "Caffeina";
    $("auth-go").textContent = authMode === "up"
      ? (authRole === "client" ? "Open my listing" : "Open the book")
      : "Sign in";
    $("auth-swap").innerHTML = authMode === "up"
      ? `Already have an account? <button id="auth-toggle">Sign in</button>`
      : `New here? <button id="auth-toggle">Open an account</button>`;'''),
]

for a, b in R:
    n = js.replace(a, b, 1)
    if n == js:
        raise SystemExit("MISS: " + a[:80])
    js = n

EXTRA = r'''
  /* ============================================================
     SPEC BAR + HERO TECHNICAL FLAT
     ============================================================ */
  function spec(){
    let under = 0, bids = 0, lots = 0, cells = 0, soon = Infinity;
    COUPLES.forEach(c => {
      under += raisedOf(c);
      bids  += c.mkt.bids.length;
      cells += claimedOf(c);
      if(c.mkt.open){ lots++; soon = Math.min(soon, c.mkt.closesAt); }
    });
    $("k-purse").textContent = money(under);
    $("k-lots").textContent  = lots;
    $("k-bids").textContent  = bids;
    $("k-rate").textContent  = cells ? money2(under/(cells*SQIN)) + "/in\u00b2" : "\u2014";
    $("k-next").textContent  = soon < Infinity ? fmtClock(soon - Date.now()) : "\u2014";
  }
  setInterval(spec, 1000);

  /** The hero gown, drawn as a technical flat with real dimensions on it. */
  function heroFlat(){
    const el = $("hero-flat");
    if(!el) return;
    const sellable = Math.round(TOTAL_CELLS * SQIN);
    el.innerHTML = gownSVG() +
      '<div class="dimv"><span>58 in</span></div>' +
      '<div class="dimh"><span>44 in at the hem</span></div>' +
      callout(50, 31, "right", "BODICE &middot; 28 in\u00b2") +
      callout(35, 63, "left",  "SKIRT L &middot; 64 in\u00b2") +
      callout(50, 88, "right", "TRAIN &middot; 96 in\u00b2") +
      '<div class="callout" style="left:50%;top:6%;transform:translateX(-50%)">' +
        '<span class="txt" style="border-color:var(--red);color:var(--red)">' +
        sellable.toLocaleString("en-US") + ' in\u00b2 SELLABLE</span></div>';
  }
  function callout(x, y, side, text){
    const pos = side === "left" ? `right:${100-x}%` : `left:${x}%`;
    return `<div class="callout ${side}" style="${pos};top:${y}%;transform:translateY(-50%)">
      <span class="dot"></span><span class="lead"></span><span class="txt">${text}</span></div>`;
  }

'''

marker = '  /* ============================================================\n     BOOT'
if marker not in js:
    raise SystemExit("boot marker missing")
js = js.replace(marker, EXTRA + marker, 1)
js = js.replace('buildCarousel(); restartCar(); renderSteps("couple"); renderNavRight(); syncAuth();',
                'buildCarousel(); restartCar(); renderSteps("couple"); renderNavRight(); syncAuth(); spec(); heroFlat();', 1)

out = h + js
i = out.index("<script>")
head, body = out[:i], out[i:]
named = {0x2014:"&mdash;",0xb7:"&middot;",0xb2:"&sup2;",0x201c:"&ldquo;",0x201d:"&rdquo;",
         0x2192:"&rarr;",0x2190:"&larr;",0xe9:"&eacute;",0x2212:"&minus;",0x2019:"&rsquo;",
         0x2013:"&ndash;",0xd7:"&times;",0x2026:"&hellip;"}
ESC = chr(92) + "u%04x"
head = "".join(named.get(ord(c), "&#%d;" % ord(c)) if ord(c) > 127 else c for c in head)
body = "".join(ESC % ord(c) if ord(c) > 127 else c for c in body)
io.open("squareinch.html", "w", encoding="ascii", newline="").write(head + body)
print("wrote squareinch.html; non-ascii bytes:",
      sum(1 for x in open("squareinch.html", "rb").read() if x > 127))
