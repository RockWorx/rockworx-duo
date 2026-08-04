// Conceptual Design capstone panel -- a guided sizing flow (tutorial worked-example -> your own project).
// Pure client rendering; the backend is stdlib-only, so this tab always works (no install tier).

let CD_WIRED = false;
let CD_RAN = false;
let cdFocusedHelp = null;

// Per-field teaching help: a short tip (the (i) icon's hover title) + the full "how to think about it"
// text (shown in the focus/hover help strip). Covers the design-assumption fields.
const CD_HELP_DEFAULT = "Hover the (i) icons, or click into a field, to see how to think about each value.";
const CD_HELP = {
  "cd-proptype": { name: "Propulsion", tip: "Prop or jet -- sets the fuel-burn model and how thrust is sized.",
    full: "Prop vs jet changes the physics: props burn fuel per unit power (BSFC), efficient at low speed; jets burn per unit thrust (TSFC), better high and fast. It also switches the matching chart between power loading (P/W) and thrust loading (T/W)." },
  "cd-bsfc": { name: "Prop BSFC", tip: "Fuel per horsepower-hour -- lower is more efficient.",
    full: "Brake specific fuel consumption: lb of fuel per hp per hour. Lower = more efficient. Piston ~0.4-0.5; turboprop ~0.5-0.6. Drives cruise fuel burn for props." },
  "cd-eta": { name: "Propeller efficiency", tip: "Prop efficiency (0-1) -- power turned into thrust.",
    full: "Fraction of shaft power the propeller converts to useful thrust in cruise. Fixed-pitch ~0.75; a good constant-speed prop ~0.80-0.85. Higher = more thrust per unit fuel." },
  "cd-tsfc": { name: "Jet TSFC", tip: "Fuel per lb of thrust per hour -- lower is more efficient.",
    full: "Thrust specific fuel consumption (per hour). Lower = more efficient. Old turbojet ~0.9; modern turbofan ~0.35-0.6 at cruise. Drives cruise fuel burn for jets." },
  "cd-ld": { name: "Cruise L/D", tip: "Lift-to-drag in cruise -- the biggest lever on range.",
    full: "Aerodynamic efficiency in cruise, and the single biggest driver of range (Breguet). Props 10-14, jets 15-18, sailplanes 40+. Keep it at or below the matching chart's polar (L/D)max." },
  "cd-clmax": { name: "CL max", tip: "Max lift with flaps -- sets how slow you can fly.",
    full: "Maximum lift coefficient, flaps down. Higher = lower stall/approach speed and more wing loading allowed. Plain wing ~1.5, slotted flaps ~2.5, airliner flaps 3+." },
  "cd-vstall": { name: "Stall speed", tip: "Slowest safe speed -- usually set by landing.",
    full: "The slowest you can fly at CLmax, usually driven by landing/approach safety. Lower is safer and shortens fields but forces a bigger wing -- it directly caps your wing loading (the stall line on the chart)." },
  "cd-ar": { name: "Aspect ratio", tip: "Wing slenderness (b^2/S) -- higher = less induced drag.",
    full: "b^2/S, the wing's slenderness. Higher = less induced drag and better L/D, but a heavier wing and slower roll. Trainers 6-8, airliners 9-11, sailplanes 20+." },
  "cd-taper": { name: "Taper ratio", tip: "Tip chord / root chord -- about 0.4 mimics an elliptical wing.",
    full: "Tip chord divided by root chord. About 0.35-0.5 approximates the ideal elliptical lift distribution (best span efficiency) while staying buildable. 1.0 = rectangular, 0 = pointed." },
  "cd-class": { name: "Empty-weight class", tip: "Aircraft category -- picks the empty-weight trend.",
    full: "Selects the historical empty-weight regression (We/W0 vs W0) for your category. Composite homebuilts run lighter, transports heavier. It anchors the weight-sizing loop -- pick the closest match." },
  "cd-reserve": { name: "Reserve fraction", tip: "Extra fuel beyond the mission (diversion/loiter).",
    full: "Reserve fuel as a fraction of mission fuel -- for diversion, loiter, and headwind margin. ~0.05-0.10 typical; regulations often set a minimum (e.g. 30-45 min loiter)." },
  "cd-cd0": { name: "Parasite CD0", tip: "Zero-lift drag -- the clean drag of the whole aircraft.",
    full: "Zero-lift (parasite) drag coefficient: skin friction + form drag with no lift. Clean sailplane ~0.010, clean GA ~0.020-0.030, fixed-gear or draggy 0.03+. Sets the flat floor of the drag polar." },
  "cd-e": { name: "Oswald efficiency", tip: "Span efficiency (0-1) -- how close to an ideal wing.",
    full: "Oswald span efficiency: how close the lift distribution is to ideal elliptical. ~0.8 typical; higher for clean, well-tapered wings. Lower e raises induced drag." },
  "cd-roc": { name: "Rate of climb", tip: "Required sea-level climb rate -- often sizes the engine.",
    full: "Required climb rate at sea level. Higher demands more installed thrust/power -- for many designs the climb curve is the binding constraint on the matching chart. Trainers ~700-1000 ft/min; fighters far more." },
  "cd-toroll": { name: "Takeoff roll", tip: "Ground run to lift off -- shorter needs more thrust.",
    full: "Ground run to lift-off. Shorter fields demand more thrust and/or lower wing loading (higher CLmax). Sets the takeoff line on the matching chart. Small GA ~1000-1800 ft." },
};

function cdVal(id, d) { const e = document.getElementById(id); return e ? String(e.value).trim() : d; }
function cdSet(id, v) { const e = document.getElementById(id); if (e) e.value = v; }

function cdTable(el, rows) {
  if (!el) return;
  el.textContent = "";
  for (const row of rows) {
    const k = row[0], v = row[1], cls = row[2];
    const r = document.createElement("div"); r.className = "cd-row";
    const a = document.createElement("span"); a.className = "cd-k"; a.textContent = k;
    const b = document.createElement("span"); b.className = "cd-v" + (cls ? " " + cls : ""); b.textContent = v;
    r.appendChild(a); r.appendChild(b); el.appendChild(r);
  }
}

// --- constraint / matching diagram (canvas-2D; no chart library, CSP-clean) ------------------------
function cdCanvas(canvas) {
  const W = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 600;
  const H = canvas.clientHeight || 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  return { g, W, H };
}

function cdFmt(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function cdMatchingChart(cn) {
  const canvas = document.getElementById("cd-matching");
  if (!canvas || !cn) return;
  const { g, W, H } = cdCanvas(canvas);
  const padL = 54, padR = 14, padT = 12, padB = 34, pw = W - padL - padR, ph = H - padT - padB;
  const xs = cn.ws_lbft2, cr = cn.cruise, cl = cn.climb, to = cn.takeoff, stall = cn.stall_ws_lbft2, dz = cn.design;
  const xmin = 0, xmax = Math.max(xs[xs.length - 1], stall * 1.02);
  let envAtStall = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i] <= stall) envAtStall = Math.max(envAtStall, cr[i], cl[i], to[i]);
  const yTop = Math.max(2.2 * dz.y, 1.25 * envAtStall, 1e-6);
  const sx = (v) => padL + (v - xmin) / (xmax - xmin) * pw;
  const sy = (v) => padT + (1 - Math.min(v, yTop) / yTop) * ph;

  g.font = "10px monospace"; g.textBaseline = "middle"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yv = yTop * i / 4, yp = padT + (1 - i / 4) * ph;
    g.strokeStyle = "#16233c"; g.beginPath(); g.moveTo(padL, yp); g.lineTo(padL + pw, yp); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "right"; g.fillText(cdFmt(yv), padL - 6, yp);
    const xv = xmin + (xmax - xmin) * i / 4, xp = sx(xv);
    g.strokeStyle = "#16233c"; g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + ph); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "center"; g.textBaseline = "top"; g.fillText(cdFmt(xv), xp, padT + ph + 6);
    g.textBaseline = "middle";
  }
  // feasible wedge: x <= stall AND y >= envelope
  g.fillStyle = "rgba(34,197,94,0.10)"; g.beginPath();
  let started = false;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > stall) break;
    const env = Math.min(Math.max(cr[i], cl[i], to[i]), yTop);
    const X = sx(xs[i]), Y = sy(env);
    if (!started) { g.moveTo(X, Y); started = true; } else g.lineTo(X, Y);
  }
  g.lineTo(sx(stall), sy(yTop)); g.lineTo(sx(xmin), sy(yTop)); g.closePath(); g.fill();
  // curves
  const draw = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < xs.length; i++) { const X = sx(xs[i]), Y = sy(arr[i]); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.stroke();
  };
  draw(to, "#a78bfa"); draw(cr, "#38bdf8"); draw(cl, "#f59e0b");
  // stall limit
  g.strokeStyle = "#ef4444"; g.lineWidth = 2; g.setLineDash([5, 4]);
  g.beginPath(); g.moveTo(sx(stall), padT); g.lineTo(sx(stall), padT + ph); g.stroke(); g.setLineDash([]);
  // design point
  const DX = sx(dz.ws), DY = sy(dz.y);
  g.beginPath(); g.arc(DX, DY, 6, 0, Math.PI * 2); g.fillStyle = "#0b1120"; g.fill();
  g.lineWidth = 2.5; g.strokeStyle = "#22c55e"; g.stroke();
  g.beginPath(); g.arc(DX, DY, 2.5, 0, Math.PI * 2); g.fillStyle = "#e2e8f0"; g.fill();
  g.fillStyle = "#e2e8f0"; g.textAlign = "right"; g.textBaseline = "middle"; g.fillText("design", DX - 9, DY);
  // legend + tags
  const leg = [["cruise", "#38bdf8"], ["climb", "#f59e0b"], ["takeoff", "#a78bfa"], ["stall", "#ef4444"]];
  g.textAlign = "left"; g.textBaseline = "middle"; let ly = padT + 8;
  leg.forEach((it) => {
    g.strokeStyle = it[1]; g.lineWidth = 2; if (it[0] === "stall") g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(padL + pw - 72, ly); g.lineTo(padL + pw - 58, ly); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#cbd5e1"; g.fillText(it[0], padL + pw - 52, ly); ly += 14;
  });
  g.fillStyle = "#22c55e"; g.textAlign = "left"; g.fillText("feasible", padL + 8, padT + 10);
  g.fillStyle = "#94a3b8"; g.textAlign = "center"; g.textBaseline = "bottom";
  g.fillText("Wing loading  W/S (lb/ft^2)", padL + pw / 2, H);
  g.save(); g.translate(12, padT + ph / 2); g.rotate(-Math.PI / 2);
  g.textAlign = "center"; g.textBaseline = "top"; g.fillText(cn.y_label, 0, 0); g.restore();
}

function cdBindingTable(cn) {
  const isTW = cn.mode === "T/W";
  cdTable(document.getElementById("cd-binding"), [
    ["Design point W/S", cn.design.ws + " lb/ft^2", "big"],
    [isTW ? "Installed T/W (required)" : "Installed P/W (required)", cn.design.y + (isTW ? "" : " hp/lb"), "big"],
    ["Binding constraint", cn.design.binding],
    ["(L/D)max from polar", cn.maxld_polar + "  (you assumed " + cn.assumed_ld + ")",
     cn.assumed_ld > cn.maxld_polar ? "bad" : "good"],
  ]);
}

// --- per-field teaching help: (i) icons + a focus/hover help strip --------------------------------
function cdSetHelp(id) {
  const strip = document.getElementById("cd-help-strip");
  if (!strip) return;
  strip.textContent = "";
  const h = id && CD_HELP[id];
  if (!h) { strip.textContent = CD_HELP_DEFAULT; return; }
  const b = document.createElement("b"); b.textContent = h.name;
  strip.appendChild(b); strip.appendChild(document.createTextNode(" -- " + h.full));
}

function cdWireHelp() {
  for (const id in CD_HELP) {
    const inp = document.getElementById(id);
    if (!inp) continue;
    const label = inp.closest ? inp.closest("label") : inp.parentElement;
    if (label && !label.querySelector(".cd-help-ic")) {
      const ic = document.createElement("span");
      ic.className = "cd-help-ic"; ic.textContent = "i"; ic.title = CD_HELP[id].tip;
      ic.addEventListener("mouseenter", () => cdSetHelp(id));
      ic.addEventListener("mouseleave", () => cdSetHelp(cdFocusedHelp));
      label.appendChild(ic);
    }
    inp.addEventListener("focus", () => { cdFocusedHelp = id; cdSetHelp(id); });
    inp.addEventListener("blur", () => { cdFocusedHelp = null; cdSetHelp(null); });
    inp.addEventListener("mouseenter", () => cdSetHelp(id));
    inp.addEventListener("mouseleave", () => cdSetHelp(cdFocusedHelp));
  }
}

function cdRecord(d) {
  const el = document.getElementById("cd-record");
  if (!el) return;
  const i = d.inputs, w = d.weights, wing = d.wing, c = d.closure, isProp = i.prop_type === "prop";
  el.textContent =
    "RockWorx Duo -- Conceptual Design record\n" +
    "Mission: " + i.range_nm + " nm, " + i.cruise_kt + " kt (M" + i.mach + ") @ " + i.cruise_alt_ft + " ft; "
      + "payload " + i.payload_lb + " lb, crew " + i.crew_lb + " lb\n" +
    "Class: " + i.empty_class + " (" + i.prop_type + "), L/D " + i.ld_cruise + ", CLmax " + i.clmax
      + ", AR " + i.ar + ", taper " + i.taper + "\n" +
    "Weights: MTOW " + w.mtow_lb + " lb | empty " + w.empty_lb + " | fuel " + w.fuel_lb + " | useful " + w.useful_load_lb + "\n" +
    "Wing: S " + wing.area_ft2 + " ft^2, b " + wing.span_ft + " ft, W/S " + wing.wing_loading_lbft2
      + " lb/ft^2, chords " + wing.root_chord_ft + "/" + wing.tip_chord_ft + " ft\n" +
    "Closure: Vstall " + c.stall_speed_kt + " kt, cruise CL " + c.cruise_CL + ", "
      + (isProp ? ("power " + c.cruise_power_hp + " hp") : ("T/W " + c.cruise_TW)) +
    (d.constraints ? ("\n" +
      "Matching: design W/S " + d.constraints.design.ws + " lb/ft^2, " +
      (d.constraints.mode === "T/W" ? ("T/W " + d.constraints.design.y)
        : ("P/W " + d.constraints.design.y + " hp/lb")) +
      " (" + d.constraints.design.binding + "-limited); (L/D)max polar " + d.constraints.maxld_polar +
      " (assumed " + d.constraints.assumed_ld + ")") : "");
}

async function cdSize() {
  const status = document.getElementById("cd-status");
  const q = new URLSearchParams({
    payload_lb: cdVal("cd-payload", "400"), crew_lb: cdVal("cd-crew", "400"), range_nm: cdVal("cd-range", "500"),
    cruise_alt_ft: cdVal("cd-alt", "8000"), cruise_speed: cdVal("cd-speed", "140"), speed_type: cdVal("cd-speedtype", "kt"),
    prop_type: cdVal("cd-proptype", "prop"), bsfc_lbhphr: cdVal("cd-bsfc", "0.45"), eta_p: cdVal("cd-eta", "0.8"),
    tsfc_1hr: cdVal("cd-tsfc", "0.5"), ld_cruise: cdVal("cd-ld", "12"), clmax: cdVal("cd-clmax", "1.8"),
    vstall_kt: cdVal("cd-vstall", "50"), ar: cdVal("cd-ar", "8"), taper: cdVal("cd-taper", "0.6"),
    empty_class: cdVal("cd-class", "GA single-engine"), reserve_frac: cdVal("cd-reserve", "0.06"),
    cd0: cdVal("cd-cd0", "0.025"), oswald_e: cdVal("cd-e", "0.80"),
    roc_fpm: cdVal("cd-roc", "800"), takeoff_roll_ft: cdVal("cd-toroll", "1500"),
  });
  if (status) status.textContent = "sizing…";
  let d;
  try { d = await Harness.api("/api/plugin/conceptual-design/size?" + q.toString()); }
  catch (e) { if (status) status.textContent = "error: " + e.message; return; }
  const results = document.getElementById("cd-results");
  if (d && d.error) { if (status) status.textContent = d.error; if (results) results.style.display = "none"; return; }

  const w = d.weights, wing = d.wing, c = d.closure, isProp = d.inputs.prop_type === "prop";
  if (status) status.textContent = "MTOW " + w.mtow_lb + " lb" + (w.converged ? "" : " (did not fully converge)");
  cdTable(document.getElementById("cd-weights"), [
    ["Take-off weight (MTOW)", w.mtow_lb + " lb", "big"],
    ["Empty weight", w.empty_lb + " lb  (We/W0 " + w.we_w0 + ")"],
    ["Fuel weight", w.fuel_lb + " lb  (Wf/W0 " + w.wf_w0 + ")"],
    ["Useful load", w.useful_load_lb + " lb"],
    ["Cruise fuel fraction", w.cruise_fuel_fraction],
    ["Converged", (w.converged ? "yes" : "no") + " (" + w.iterations + " iters)"],
  ]);
  cdTable(document.getElementById("cd-wing"), [
    ["Wing loading W/S", wing.wing_loading_lbft2 + " lb/ft^2", "big"],
    ["stall-limit W/S", wing.stall_limit_wing_loading_lbft2 + " lb/ft^2"],
    ["Wing area S", wing.area_ft2 + " ft^2"],
    ["Span b", wing.span_ft + " ft"],
    ["Root / tip chord", wing.root_chord_ft + " / " + wing.tip_chord_ft + " ft"],
    ["Aspect ratio", wing.aspect_ratio],
  ]);
  cdTable(document.getElementById("cd-closure"), [
    ["Stall speed (at MTOW)", c.stall_speed_kt + " kt"],
    ["Cruise CL", c.cruise_CL],
    isProp ? ["Cruise power required", c.cruise_power_hp + " hp"] : ["Cruise thrust required", c.cruise_thrust_lb + " lb"],
    isProp ? ["Cruise thrust", c.cruise_thrust_lb + " lb"] : ["Cruise T/W", c.cruise_TW],
  ]);
  cdRecord(d);
  if (results) results.style.display = "flex";
  if (d.constraints) { cdMatchingChart(d.constraints); cdBindingTable(d.constraints); }
}

function cdCopy() {
  const el = document.getElementById("cd-record");
  if (!el || !navigator.clipboard) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const s = document.getElementById("cd-status"); if (s) s.textContent = "design summary copied to clipboard";
  }).catch(() => {});
}

function cdLoadExample() {
  const ex = {
    "cd-payload": "120", "cd-crew": "340", "cd-range": "500", "cd-alt": "8000", "cd-speed": "120",
    "cd-speedtype": "kt", "cd-proptype": "prop", "cd-bsfc": "0.45", "cd-eta": "0.8", "cd-tsfc": "0.5",
    "cd-ld": "11", "cd-clmax": "2.0", "cd-vstall": "48", "cd-ar": "7.3", "cd-taper": "0.7",
    "cd-class": "GA single-engine", "cd-reserve": "0.06",
    "cd-cd0": "0.028", "cd-e": "0.80", "cd-roc": "700", "cd-toroll": "1200",
  };
  for (const id in ex) cdSet(id, ex[id]);
  const s = document.getElementById("cd-status"); if (s) s.textContent = "loaded a light 2-seat trainer -- sizing…";
  cdSize();
}

Harness.registerPanel("conceptual-design", {
  onActivate() {
    if (!CD_WIRED) {
      const run = document.getElementById("cd-run"); if (run) run.addEventListener("click", cdSize);
      const ex = document.getElementById("cd-example"); if (ex) ex.addEventListener("click", cdLoadExample);
      const cp = document.getElementById("cd-copy"); if (cp) cp.addEventListener("click", cdCopy);
      ["cd-payload", "cd-crew", "cd-range", "cd-alt", "cd-speed", "cd-bsfc", "cd-eta", "cd-tsfc",
       "cd-ld", "cd-clmax", "cd-vstall", "cd-ar", "cd-taper", "cd-reserve",
       "cd-cd0", "cd-e", "cd-roc", "cd-toroll"].forEach((id) => {
        const e = document.getElementById(id);
        if (e) e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") cdSize(); });
      });
      cdWireHelp();
      CD_WIRED = true;
    }
    if (!CD_RAN) { CD_RAN = true; setTimeout(cdSize, 40); }
  },
});
