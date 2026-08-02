// Conceptual Design capstone panel -- a guided sizing flow (tutorial worked-example -> your own project).
// Pure client rendering; the backend is stdlib-only, so this tab always works (no install tier).

let CD_WIRED = false;
let CD_RAN = false;

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
      + (isProp ? ("power " + c.cruise_power_hp + " hp") : ("T/W " + c.cruise_TW));
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
       "cd-ld", "cd-clmax", "cd-vstall", "cd-ar", "cd-taper", "cd-reserve"].forEach((id) => {
        const e = document.getElementById(id);
        if (e) e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") cdSize(); });
      });
      CD_WIRED = true;
    }
    if (!CD_RAN) { CD_RAN = true; setTimeout(cdSize, 40); }
  },
});
