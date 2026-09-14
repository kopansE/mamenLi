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
 '''    const r = $("lst-submit").getBoundingClientRect();
    burst(r.left + r.width/2, r.top);
    toast(bitten
      ? `Yours. ${Math.round(bitten*SQIN)} sq in ripped off ${Object.keys(ev.lostBy).length} brand(s).`
      : `Yours. ${Math.round(ev.winArea)} sq in of open fabric.`, "good");'''),

('toast(name + " took " + Math.round(ev.bite.length*SQIN) + " sq in off you at " + money2(d) + "/in\\u00b2.", "bad");',
 'toast(name + " outrated you at " + money2(d) + "/in\\u00b2 \\u2014 " + Math.round(ev.bite.length*SQIN) + " sq in reallocated.", "bad");'),

('''    toast("Saved. Bidding is open for " + fmtClock(c.mkt.closesAt - Date.now()) + ".", "good");''',
 '''    toast("Terms published. Bidding closes in " + fmtClock(c.mkt.closesAt - Date.now()) + ".", "good");'''),

('''        if(current === "client" && session && c.id === session.coupleId)
          toast("Bidding closed. " + c.mkt.holders.filter(h=>h.cells>0).length + " brands are on your dress.", "good");''',
 '''        if(current === "client" && session && c.id === session.coupleId){
          burst();
          toast("Sold. " + c.mkt.holders.filter(h=>h.cells>0).length +
                " brands on your dress, " + money(raisedOf(c)) + " in the bank.", "good");
        }'''),

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
('  const PALETTE = ["#6C3483","#B03A2E","#117A65","#B9770E","#A23A73","#5F6B1F","#34495E","#8A5A2B"];\n  const MINE_COLOR = "#1E4B7A";',
 '  /* Bright, well-separated hues - these sit on a deep violet ground, not white. */\n  const PALETTE = ["#FF6A9F","#FFAE2B","#7FD4FF","#C6F32B","#FF8A5B","#59E0A8","#FFD166","#8AA0FF"];\n  const MINE_COLOR = "#C08BFF";'),
]

for a, b in R:
    n = js.replace(a, b, 1)
    if n == js:
        raise SystemExit("MISS: " + a[:80])
    js = n

EXTRA = r'''
  /* ============================================================
     MOTION LAYER
     ============================================================ */
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* headline: word-by-word entrance */
  (function heroWords(){
    const el = $("hero-h1");
    if(!el) return;
    const line = ["You", "own", "the", "most", "photographed", "surface", "in", "the", "room."];
    el.innerHTML = line.map((w,i) =>
      `<span class="w" style="animation-delay:${0.05 + i*0.055}s">${w}</span>`).join(" ") +
      ` <em class="w grad" style="animation-delay:${0.05 + line.length*0.055}s">Charge for it.</em>`;
  })();

  /* reveal on scroll */
  (function reveals(){
    const io = new IntersectionObserver(es => es.forEach(e => {
      if(e.isIntersecting){ e.target.classList.add("shown"); io.unobserve(e.target); }
    }), {threshold:.12, rootMargin:"0px 0px -8%"});
    document.querySelectorAll(".rv").forEach(el => io.observe(el));
  })();

  /* count-ups + rate-card heat bars, once they scroll into view */
  (function counters(){
    const run = el => {
      const target = +el.dataset.count, pre = el.dataset.prefix || "", suf = el.dataset.suffix || "";
      if(reduced){ el.textContent = pre + target.toLocaleString("en-US") + suf; return; }
      const t0 = performance.now(), dur = 1400;
      (function step(t){
        const k = Math.min(1, (t-t0)/dur), e = 1 - Math.pow(1-k, 3);
        el.textContent = pre + Math.round(target*e).toLocaleString("en-US") + suf;
        if(k < 1) requestAnimationFrame(step);
      })(t0);
    };
    const io = new IntersectionObserver(es => es.forEach(e => {
      if(!e.isIntersecting) return;
      e.target.querySelectorAll("[data-count]").forEach(run);
      e.target.querySelectorAll("[data-heat]").forEach(b => b.style.width = b.dataset.heat + "%");
      io.unobserve(e.target);
    }), {threshold:.3});
    document.querySelectorAll(".figures, .ratecard").forEach(el => io.observe(el));
  })();

  /* the hero gown you can actually poke */
  function heroFlat(){
    const el = $("hero-flat");
    if(!el) return;
    const tags = [
      {x:50, y:31, c:"m", n:"BODICE",  a:28, r:24.00},
      {x:35, y:63, c:"a", n:"SKIRT L", a:64, r:11.00},
      {x:66, y:52, c:"l", n:"SASH",    a:22, r:19.00},
      {x:50, y:88, c:"m", n:"TRAIN",   a:96, r:14.50}
    ];
    el.insertAdjacentHTML("afterbegin", gownSVG());
    tags.forEach((t,i) => {
      el.insertAdjacentHTML("beforeend",
        `<span class="hp ${t.c}" style="left:${t.x}%;top:${t.y}%;animation-delay:${0.5 + i*0.14}s"
               title="${t.n}: ${t.a} sq in at ${money2(t.r)} per square inch">
           ${t.n} &middot; ${t.a} in&sup2; &middot; <b>${money(t.a*t.r)}</b></span>`);
    });
  }

  /* ticker */
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
    $("k-rate").textContent  = cells ? money2(under/(cells*SQIN)) + "/in²" : "—";
    $("k-next").textContent  = soon < Infinity ? fmtClock(soon - Date.now()) : "—";
  }
  setInterval(spec, 1000);

  /* confetti when you take ground, or when a gown settles */
  const cfc = $("confetti"), cfx = cfc.getContext("2d");
  let bits = [], cfRaf = null;
  function burst(x, y){
    if(reduced) return;
    cfc.width = innerWidth; cfc.height = innerHeight;
    const cols = ["#FF2E93","#FFAE2B","#2BE8C5","#C08BFF","#C6F32B"];
    const ox = x == null ? innerWidth/2 : x, oy = y == null ? innerHeight*0.6 : y;
    for(let i=0;i<160;i++)
      bits.push({x:ox, y:oy, vx:(Math.random()-.5)*14, vy:-Math.random()*13-4,
        s:3+Math.random()*6, c:cols[i%cols.length], r:Math.random()*6,
        vr:(Math.random()-.5)*.34, life:1});
    if(!cfRaf) cfRaf = requestAnimationFrame(cfStep);
  }
  function cfStep(){
    cfx.clearRect(0,0,cfc.width,cfc.height);
    bits = bits.filter(b => b.life > 0);
    bits.forEach(b => {
      b.vy += .34; b.x += b.vx; b.y += b.vy; b.r += b.vr; b.life -= .0095;
      cfx.save(); cfx.translate(b.x,b.y); cfx.rotate(b.r);
      cfx.globalAlpha = Math.max(0,b.life); cfx.fillStyle = b.c;
      cfx.fillRect(-b.s/2,-b.s/2,b.s,b.s*1.7); cfx.restore();
    });
    if(bits.length) cfRaf = requestAnimationFrame(cfStep);
    else { cfRaf = null; cfx.clearRect(0,0,cfc.width,cfc.height); }
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
