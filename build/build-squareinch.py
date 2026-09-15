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

  /* headline: word-by-word entrance, then a highlighter sweep on the payoff */
  (function heroWords(){
    const el = $("hero-h1");
    if(!el) return;
    const line = ["You", "own", "the", "most", "photographed", "surface", "in", "the", "room."];
    const last = 0.05 + line.length * 0.055;
    el.innerHTML =
      line.map((w,i) => `<span class="w" style="animation-delay:${0.05 + i*0.055}s">${w}</span>`).join(" ") +
      ` <span class="w hl" id="hl" style="animation-delay:${last}s">` +
        `<span class="hl-bg"></span><span class="hl-t grad">Charge for it.</span></span>`;

    const hl = $("hl");
    if(!hl || reduced) return;
    const sweep = () => { hl.classList.remove("go"); void hl.offsetWidth; hl.classList.add("go"); };
    setTimeout(sweep, (last + 0.7) * 1000);
    setInterval(sweep, 9000);
    hl.addEventListener("mouseenter", sweep);
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

  /* ============================================================
     THE HERO GOWN IN 3D
     A solid of revolution built from the same profile the market uses,
     so the thing you spin is the thing you bid on. Drag to rotate.
     ============================================================ */
  const HERO_PANELS = [
    {v:0.30, a:0.00,        name:"BODICE",  area:28, rate:24.00, col:"#FF2E93"},
    {v:0.45, a:0.95,        name:"SASH",    area:22, rate:19.00, col:"#C08BFF"},
    {v:0.66, a:-0.85,       name:"SKIRT L", area:64, rate:11.00, col:"#2BE8C5"},
    {v:0.88, a:0.25,        name:"TRAIN",   area:96, rate:14.50, col:"#FFAE2B"},
    {v:0.55, a:Math.PI,     name:"BACK",    area:40, rate:12.50, col:"#C6F32B"}
  ];

  function patchTexture(p){
    const c = document.createElement("canvas");
    c.width = 512; c.height = 152;
    const x = c.getContext("2d");
    const r = 26;
    x.fillStyle = "rgba(18,6,32,.93)";
    x.beginPath();
    x.moveTo(r,0); x.arcTo(512,0,512,152,r); x.arcTo(512,152,0,152,r);
    x.arcTo(0,152,0,0,r); x.arcTo(0,0,512,0,r); x.closePath(); x.fill();
    x.lineWidth = 6; x.strokeStyle = p.col; x.stroke();
    x.textAlign = "center";
    x.fillStyle = p.col;
    x.font = "700 52px 'IBM Plex Mono', monospace";
    x.fillText(p.name, 256, 62);
    x.fillStyle = "#EFE4F8";
    x.font = "500 36px 'IBM Plex Mono', monospace";
    x.fillText(p.area + " in\u00b2  \u00b7  " + money(p.area * p.rate), 256, 112);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }

  function hero3D(){
    const host = $("hero-flat");
    if(!host || !window.THREE) return false;

    const V_TOP = 0.19, V_HEM = 0.985, Y_TOP = 1.50, Y_HEM = -2.00;
    const yAt = v => Y_TOP - (v - V_TOP) / (V_HEM - V_TOP) * (Y_TOP - Y_HEM);
    const mix = (a,b,k) => a + (b-a)*k;
    /* A gown profile, not a cone: bust, nipped waist, then the skirt opens up. */
    const rAt = v => {
      if(v < 0.30) return mix(0.70, 0.80, (v-0.19)/0.11);
      if(v < 0.44) return mix(0.80, 0.46, (v-0.30)/0.14);
      return 0.46 + Math.pow((v-0.44)/0.545, 1.28) * (2.05-0.46);
    };
    /* Fabric, not a cone. Vertical drape folds that open toward the hem,
       a second slower wave so they are not mechanical, and a train at the back. */
    const FOLDS = 13, FOLDS2 = 5;
    const foldAmp = v => 0.085 * Math.pow(Math.max(0,(v-0.40))/0.585, 0.85) + 0.014;
    const trainAt = (v, th) => {
      const dist = Math.PI - Math.abs(th);                 // 0 at the back
      const across = Math.exp(-Math.pow(dist/0.80, 2));
      const down = Math.pow(Math.max(0,(v-0.70))/0.285, 1.6);
      return {r: 0.95*across*down, y: -0.30*across*down};
    };
    /* radius of the finished surface at (height, angle) */
    const surfR = (v, th) => {
      const base = rAt(v), a = foldAmp(v);
      const w = Math.sin(FOLDS*th + v*1.6) * a + Math.sin(FOLDS2*th - v*0.9) * a * 0.45;
      return base * (1 + w) + trainAt(v, th).r;
    };

    /* outward surface normal at v, in the (radius, height) plane */
    const normAt = v => {
      const d = 0.008;
      const dr = rAt(Math.min(V_HEM,v+d)) - rAt(Math.max(V_TOP,v-d));
      const dy = yAt(Math.min(V_HEM,v+d)) - yAt(Math.max(V_TOP,v-d));
      const nr = -dy, ny = dr, L = Math.hypot(nr, ny) || 1;
      return {r:nr/L, y:ny/L};
    };

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 3/4, 0.1, 100);
    cam.position.set(0, 0.30, 12.1);
    cam.lookAt(0, -0.42, 0);

    const gl = new THREE.WebGLRenderer({antialias:true, alpha:true});
    gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    /* without these the silk clips to flat white and every fold disappears */
    gl.outputEncoding = THREE.sRGBEncoding;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    host.appendChild(gl.domElement);

    const rig = new THREE.Group();
    scene.add(rig);

    /* the gown */
    const pts = [];
    for(let k=0;k<=72;k++){
      const v = V_TOP + (V_HEM - V_TOP) * k/72;
      pts.push(new THREE.Vector2(Math.max(0.02, rAt(v)), yAt(v)));
    }
    const geo = new THREE.LatheGeometry(pts, 168);
    (function drape(){
      const P = geo.attributes.position, yTop = Y_TOP, yHem = Y_HEM;
      for(let i=0;i<P.count;i++){
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        const r0 = Math.hypot(x, z);
        if(r0 < 1e-4) continue;
        const th = Math.atan2(x, z);
        const v = V_TOP + (yTop - y) / (yTop - yHem) * (V_HEM - V_TOP);
        const r = surfR(v, th), t = trainAt(v, th);
        /* sweetheart dip at the very top */
        const dip = v < V_TOP + 0.012 ? -0.11 * Math.pow(Math.cos(th), 2) : 0;
        P.setXYZ(i, Math.sin(th)*r, y + t.y + dip, Math.cos(th)*r);
      }
      P.needsUpdate = true;
      geo.computeVertexNormals();
    })();

    const silkMat = new THREE.MeshPhysicalMaterial({
      color:0xEFE4F2, roughness:.62, metalness:.0,
      clearcoat:.4, clearcoatRoughness:.5,
      side:THREE.DoubleSide, flatShading:false
    });
    const gown = new THREE.Mesh(geo, silkMat);
    rig.add(gown);

    /* a satin band at the waist - small detail, big believability */
    const waistV = 0.44, sash = new THREE.Mesh(
      new THREE.TorusGeometry(rAt(waistV)*1.01, .045, 12, 96),
      new THREE.MeshPhysicalMaterial({color:0xE6D4F2, roughness:.3, metalness:.15, clearcoat:.7})
    );
    sash.rotation.x = Math.PI/2; sash.position.y = yAt(waistV); rig.add(sash);

    /* a hem disc so the skirt doesn't read as hollow */
    const hem = new THREE.Mesh(
      new THREE.CircleGeometry(rAt(V_HEM)*0.99, 96),
      new THREE.MeshStandardMaterial({color:0xC6B2D8, roughness:.9, side:THREE.DoubleSide})
    );
    hem.rotation.x = Math.PI/2; hem.position.y = yAt(V_HEM) + .02;
    rig.add(hem);

    /* a couture dress form: rounded bust cap, no head - reads as product, not cartoon */
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(rAt(V_TOP)*0.995, 64, 40, 0, Math.PI*2, 0, Math.PI*0.5), silkMat);
    cap.scale.set(1, 0.66, 1); cap.position.y = Y_TOP - .03; rig.add(cap);

    /* the stand it sits on */
    const steel = new THREE.MeshStandardMaterial({color:0x6E5A82, roughness:.35, metalness:.75});
    const post = new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.9,24), steel);
    post.position.y = Y_HEM - .42; rig.add(post);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(.62,.72,.1,48), steel);
    base.position.y = Y_HEM - .9; rig.add(base);

    /* sponsor panels, sitting on the surface and turning with it */
    HERO_PANELS.forEach(p => {
      const r = rAt(p.v), y = yAt(p.v);
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1.12, 0.335),
        new THREE.MeshBasicMaterial({map:patchTexture(p), transparent:true, side:THREE.DoubleSide})
      );
      /* clear the fold ridges, otherwise the panel sinks into the fabric */
      const n = normAt(p.v), off = .07 + foldAmp(p.v) * rAt(p.v) * 1.25;
      const rr = surfR(p.v, p.a) + n.r*off;
      const ty = trainAt(p.v, p.a).y;
      const x = Math.sin(p.a) * rr, z = Math.cos(p.a) * rr;
      m.position.set(x, y + ty + n.y*off, z);
      m.lookAt(x + Math.sin(p.a)*n.r*3, y + ty + n.y*off + n.y*3, z + Math.cos(p.a)*n.r*3);
      rig.add(m);
    });

    /* light it like the page */
    scene.add(new THREE.HemisphereLight(0xCBAAF2, 0x1E0C31, .55));
    const key = new THREE.DirectionalLight(0xFFF6FF, .85); key.position.set(4.5,5.5,4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xB79BE0, .3); fill.position.set(-5,.5,3.5); scene.add(fill);
    const rimA = new THREE.PointLight(0xFF2E93, 1.8, 18); rimA.position.set(-3.4,.9,-1.6); scene.add(rimA);
    const rimB = new THREE.PointLight(0x2BE8C5, 1.3, 18); rimB.position.set(3.6,-.8,-1.8); scene.add(rimB);

    /* spin it */
    let drag = false, lastX = 0, vel = 0.0045, idle = 0;
    const onDown = e => { drag = true; lastX = e.clientX; idle = 0;
      host.classList.add("grabbing"); host.setPointerCapture(e.pointerId);
      const h = host.querySelector(".spinhint"); if(h) h.classList.add("gone"); };
    const onMove = e => { if(!drag) return;
      const dx = e.clientX - lastX; lastX = e.clientX;
      rig.rotation.y += dx * 0.0095; vel = dx * 0.0022; };
    const onUp = () => { drag = false; host.classList.remove("grabbing"); };
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);

    function size(){
      const w = host.clientWidth, h = host.clientHeight;
      if(!w || !h) return;
      gl.setSize(w, h, false);
      cam.aspect = w/h; cam.updateProjectionMatrix();
    }
    new ResizeObserver(size).observe(host);
    size();

    let visible = true;
    new IntersectionObserver(es => visible = es[0].isIntersecting, {threshold:0})
      .observe(host);

    (function loop(){
      requestAnimationFrame(loop);
      if(!visible) return;
      if(!drag){
        if(!reduced){
          idle += 1;
          const target = idle > 45 ? 0.0045 : vel;
          vel += (target - vel) * 0.04;
          rig.rotation.y += vel;
        }
      }
      gl.render(scene, cam);
    })();

    host.insertAdjacentHTML("beforeend",
      '<span class="spinhint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>Drag to spin</span>');
    return true;
  }

  /* flat fallback if WebGL or the CDN is unavailable */
  function heroFlatFallback(){
    const el = $("hero-flat");
    if(!el) return;
    el.style.cursor = "default";
    el.insertAdjacentHTML("afterbegin", gownSVG());
    HERO_PANELS.filter(p => p.name !== "BACK").forEach((p,i) => {
      const x = 50 + Math.sin(p.a) * 16;
      el.insertAdjacentHTML("beforeend",
        `<span class="hp" style="left:${x}%;top:${p.v*100}%;animation-delay:${0.5 + i*0.14}s;
           border-color:${p.col};color:${p.col}">
           ${p.name} &middot; ${p.area} in&sup2; &middot; <b>${money(p.area*p.rate)}</b></span>`);
    });
  }

  function heroArt(){ if(!hero3D()) heroFlatFallback(); }

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
                'buildCarousel(); restartCar(); renderSteps("couple"); renderNavRight(); syncAuth(); spec(); heroArt();', 1)

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
