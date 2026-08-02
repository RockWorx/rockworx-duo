// Airfoil Lab panel -- NeuralFoil polars drawn on <canvas> (no chart library; CSP-clean).
// Loaded once by the plugin loader, so these are globals and the panel's ids resolve via getElementById.

let AF_WIRED = false;
let AF_RAN = false;
let AF_DATA = null;   // last polar response, kept so the alpha slider can interpolate without re-solving
let AF_RAF = 0;       // requestAnimationFrame throttle for smooth slider dragging
let AF_AIRFOILS_LOADED = false;   // the searchable airfoil-name list (a static file pulled down once)

// --- tiny number formatter for axis ticks -----------------------------------
function afFmt(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function afInterp(xs, ys, x0) {
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    if ((a <= x0 && x0 <= b) || (b <= x0 && x0 <= a)) {
      const t = b === a ? 0 : (x0 - a) / (b - a);
      return ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return null;
}

function afCanvasSize(canvas) {
  const cssW = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 300;
  const cssH = canvas.clientHeight || 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  return { g, W: cssW, H: cssH };
}

// --- generic 2-D line plot ---------------------------------------------------
function afLine(canvas, series, opts) {
  opts = opts || {};
  const { g, W, H } = afCanvasSize(canvas);
  const padL = 46, padR = 12, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let xs = [], ys = [];
  series.forEach((s) => { xs = xs.concat(s.xs); ys = ys.concat(s.ys); });
  if (!xs.length) return;
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (xmin === xmax) { xmin -= 1; xmax += 1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const py = (ymax - ymin) * 0.08; ymin -= py; ymax += py;
  const sx = (v) => padL + (v - xmin) / (xmax - xmin) * plotW;
  const sy = (v) => padT + (1 - (v - ymin) / (ymax - ymin)) * plotH;

  g.font = "10px monospace"; g.textBaseline = "middle"; g.lineWidth = 1;
  const NT = 4;
  for (let i = 0; i <= NT; i++) {
    const yv = ymin + (ymax - ymin) * i / NT, yp = sy(yv);
    g.strokeStyle = "#1e293b"; g.beginPath(); g.moveTo(padL, yp); g.lineTo(padL + plotW, yp); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "right"; g.fillText(afFmt(yv), padL - 5, yp);
    const xv = xmin + (xmax - xmin) * i / NT, xp = sx(xv);
    g.strokeStyle = "#1e293b"; g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + plotH); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "center"; g.textBaseline = "top"; g.fillText(afFmt(xv), xp, padT + plotH + 5);
    g.textBaseline = "middle";
  }
  // zero line on Y if the range crosses zero
  if (ymin < 0 && ymax > 0) {
    g.strokeStyle = "#334155"; g.beginPath(); g.moveTo(padL, sy(0)); g.lineTo(padL + plotW, sy(0)); g.stroke();
  }
  series.forEach((s) => {
    g.strokeStyle = s.color; g.fillStyle = s.color; g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < s.xs.length; i++) {
      const X = sx(s.xs[i]), Y = sy(s.ys[i]);
      if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
    }
    g.stroke();
    if (s.dots) {
      for (let i = 0; i < s.xs.length; i++) { g.beginPath(); g.arc(sx(s.xs[i]), sy(s.ys[i]), 2.2, 0, 7); g.fill(); }
    }
  });
  if (opts.mark) {
    g.fillStyle = "#f43f5e"; g.beginPath(); g.arc(sx(opts.mark.x), sy(opts.mark.y), 4, 0, 7); g.fill();
  }
  g.fillStyle = "#94a3b8"; g.font = "10px monospace";
  g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(opts.xlabel || "", padL + plotW / 2, H);
  g.save(); g.translate(11, padT + plotH / 2); g.rotate(-Math.PI / 2);
  g.textAlign = "center"; g.textBaseline = "top"; g.fillText(opts.ylabel || "", 0, 0); g.restore();
}

// --- airfoil outline (equal aspect), rotated to the angle of attack ----------
function afShape(canvas, coords, alphaDeg) {
  const { g, W, H } = afCanvasSize(canvas);
  const cx = coords.x, cy = coords.y;
  if (!cx || !cx.length) return;
  const th = -(alphaDeg || 0) * Math.PI / 180;   // rotate about the quarter-chord to show AoA vs the freestream
  const c = Math.cos(th), s = Math.sin(th), xc = 0.25;
  const xs = [], ys = [];
  for (let i = 0; i < cx.length; i++) {
    xs.push(xc + (cx[i] - xc) * c - cy[i] * s);
    ys.push((cx[i] - xc) * s + cy[i] * c);
  }
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const midX = (xmin + xmax) / 2, midY = (ymin + ymax) / 2;
  const pad = 20;
  const spanX = (xmax - xmin) || 1, spanY = (ymax - ymin) || 1;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const X = (v) => W / 2 + (v - midX) * scale;
  const Y = (v) => H / 2 - (v - midY) * scale;   // flip: y up in airfoil coords, down on screen
  // freestream reference (horizontal, through the quarter-chord pivot)
  g.strokeStyle = "#334155"; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(X(xmin), Y(0)); g.lineTo(X(xmax), Y(0)); g.stroke(); g.setLineDash([]);
  // rotated chord line (LE -> TE) so the AoA is visible against the freestream
  g.strokeStyle = "#475569"; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(X(xc + (0 - xc) * c), Y((0 - xc) * s));
  g.lineTo(X(xc + (1 - xc) * c), Y((1 - xc) * s));
  g.stroke();
  // airfoil outline
  g.strokeStyle = "#38bdf8"; g.fillStyle = "rgba(56,189,248,0.12)"; g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < xs.length; i++) { const px = X(xs[i]), pyy = Y(ys[i]); if (i === 0) g.moveTo(px, pyy); else g.lineTo(px, pyy); }
  g.closePath(); g.fill(); g.stroke();
}

// --- data + render -----------------------------------------------------------
function afShowInstall(hint) {
  const install = document.getElementById("af-install");
  const body = document.getElementById("af-body");
  if (body) body.style.display = "none";
  if (!install) return;
  install.style.display = "block";
  install.textContent = "";
  const b = document.createElement("b"); b.textContent = "Airfoil Lab needs NeuralFoil.";
  install.appendChild(b);
  install.appendChild(document.createTextNode(
    " Install it into the harness's Python environment, then restart the harness:"));
  install.appendChild(document.createElement("br"));
  const code = document.createElement("code");
  code.textContent = hint || "pip install -r plugins/airfoil-lab/requirements.txt";
  install.appendChild(code);
}

function afSummary(d) {
  const el = document.getElementById("af-summary");
  if (!el) return;
  el.textContent = "";
  const cl0 = afInterp(d.alpha, d.CL, 0);
  const rows = [
    ["Best L/D", d.best_ld.ld + " at alpha " + d.best_ld.alpha + " deg (CL " + d.best_ld.cl + ")"],
    ["CL max (in range)", d.clmax.cl + " at alpha " + d.clmax.alpha + " deg"],
    ["CD min (in range)", d.cdmin.cd + " at alpha " + d.cdmin.alpha + " deg"],
    ["CL at alpha = 0", cl0 == null ? "(out of range)" : cl0.toFixed(3)],
    ["Sweep", d.alpha.length + " points, Re " + Number(d.re).toExponential(1) + ", model " + d.model],
  ];
  for (const [k, v] of rows) {
    const line = document.createElement("div");
    const b = document.createElement("b"); b.textContent = k + ": ";
    line.appendChild(b); line.appendChild(document.createTextNode(v));
    el.appendChild(line);
  }
}

// --- interactive alpha slider: interpolate the fetched sweep, redraw with a live marker ----------
function afInterpAt(d, a) {
  const A = d.alpha;
  let i = 0;
  while (i < A.length - 1 && A[i + 1] < a) i++;
  const lo = Math.max(0, Math.min(i, A.length - 2));
  const denom = A[lo + 1] - A[lo];
  const t = Math.max(0, Math.min(1, denom ? (a - A[lo]) / denom : 0));
  const lerp = (arr) => arr[lo] + t * (arr[lo + 1] - arr[lo]);
  return { cl: lerp(d.CL), cd: lerp(d.CD), cm: lerp(d.CM), ld: lerp(d.LD) };
}

function afConfigureSlider(d) {
  const sl = document.getElementById("af-alpha-slider");
  const row = document.getElementById("af-slider-row");
  if (!sl) return;
  sl.min = d.alpha[0];
  sl.max = d.alpha[d.alpha.length - 1];
  sl.step = 0.1;
  let v = d.best_ld ? d.best_ld.alpha : 0;
  v = Math.max(parseFloat(sl.min), Math.min(parseFloat(sl.max), v));
  sl.value = v;
  if (row) row.style.display = "flex";
}

function afDraw(d, aMark) {
  const p = afInterpAt(d, aMark);
  afShape(document.getElementById("af-shape"), d.coords, aMark);
  afLine(document.getElementById("af-cl"), [{ xs: d.alpha, ys: d.CL, color: "#38bdf8" }],
    { xlabel: "alpha (deg)", ylabel: "CL", mark: { x: aMark, y: p.cl } });
  afLine(document.getElementById("af-dp"), [{ xs: d.CD, ys: d.CL, color: "#a78bfa", dots: true }],
    { xlabel: "CD", ylabel: "CL", mark: { x: p.cd, y: p.cl } });
  afLine(document.getElementById("af-ld"), [{ xs: d.alpha, ys: d.LD, color: "#34d399" }],
    { xlabel: "alpha (deg)", ylabel: "L/D", mark: { x: aMark, y: p.ld } });
  afLine(document.getElementById("af-cm"), [{ xs: d.alpha, ys: d.CM, color: "#f59e0b" }],
    { xlabel: "alpha (deg)", ylabel: "CM", mark: { x: aMark, y: p.cm } });
  const ro = document.getElementById("af-alpha-readout");
  if (ro) {
    ro.textContent = "alpha " + aMark.toFixed(1) + " deg   ->   CL " + p.cl.toFixed(3)
      + "    CD " + p.cd.toFixed(5) + "    L/D " + p.ld.toFixed(1) + "    CM " + p.cm.toFixed(3);
  }
}

function afSliderMove() {
  if (AF_RAF || !AF_DATA) return;
  AF_RAF = requestAnimationFrame(() => {
    AF_RAF = 0;
    const sl = document.getElementById("af-alpha-slider");
    if (sl && AF_DATA) afDraw(AF_DATA, parseFloat(sl.value));
  });
}

async function afRun() {
  const status = document.getElementById("af-status");
  const val = (id, dflt) => { const el = document.getElementById(id); return (el && String(el.value).trim()) || dflt; };
  const q = new URLSearchParams({
    airfoil: val("af-name", "naca2412"),
    re: val("af-re", "1e6"),
    amin: val("af-amin", "-5"),
    amax: val("af-amax", "15"),
    astep: val("af-astep", "1"),
    model: val("af-model", "medium"),
  });
  if (status) status.textContent = "computing…";
  let d;
  try {
    d = await Harness.api("/api/plugin/airfoil-lab/polar?" + q.toString());
  } catch (e) {
    if (status) status.textContent = "error: " + e.message;
    return;
  }
  if (d && d.error) {
    if (status) status.textContent = d.error;
    if (d.available === false) afShowInstall(d.hint);
    return;
  }
  const minConf = d.confidence && d.confidence.length ? Math.min.apply(null, d.confidence) : 1;
  if (status) status.textContent = d.airfoil + " · Re " + Number(d.re).toExponential(1)
    + " · " + d.model + " · confidence >= " + Math.round(minConf * 100) + "%";
  AF_DATA = d;
  afConfigureSlider(d);
  afSummary(d);
  const sl = document.getElementById("af-alpha-slider");
  afDraw(d, sl ? parseFloat(sl.value) : (d.best_ld ? d.best_ld.alpha : 0));
}

// Populate the searchable airfoil list from a static file shipped in the repo (no dependency needed to
// browse -- only computing a polar needs NeuralFoil). Pulled down once and cached in the datalist.
async function afLoadAirfoils() {
  if (AF_AIRFOILS_LOADED) return;
  const dl = document.getElementById("af-airfoils");
  if (!dl) return;
  try {
    const res = await fetch("/plugin/airfoil-lab/airfoils.json");
    if (!res.ok) return;
    const data = await res.json();
    const names = (data.popular || []).concat(data.all || []);
    const seen = {}, frag = document.createDocumentFragment();
    for (const n of names) {
      if (seen[n]) continue;
      seen[n] = 1;
      const o = document.createElement("option");
      o.value = n;
      frag.appendChild(o);
    }
    dl.appendChild(frag);
    AF_AIRFOILS_LOADED = true;
  } catch (e) { /* the input still works as free text */ }
}

async function afInit() {
  let st;
  try { st = await Harness.api("/api/plugin/airfoil-lab/status"); }
  catch (e) { st = { available: false }; }
  if (!st || !st.available) { afShowInstall(st && st.hint); return; }
  const install = document.getElementById("af-install");
  const body = document.getElementById("af-body");
  if (install) install.style.display = "none";
  if (body) body.style.display = "block";
  afLoadAirfoils();
  if (!AF_RAN) { AF_RAN = true; setTimeout(afRun, 40); }   // populate with the default airfoil once
}

Harness.registerPanel("airfoil-lab", {
  onActivate() {
    if (!AF_WIRED) {
      const run = document.getElementById("af-run");
      if (run) run.addEventListener("click", afRun);
      ["af-name", "af-re", "af-amin", "af-amax", "af-astep"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") afRun(); });
      });
      const slider = document.getElementById("af-alpha-slider");
      if (slider) slider.addEventListener("input", afSliderMove);
      // Reveal the full airfoil list on click: a datalist filters its options by the field's current
      // value, so a pre-filled "naca2412" hides everything else. Clear on focus, restore on blur if
      // the user didn't pick/type anything.
      const nameEl = document.getElementById("af-name");
      if (nameEl) {
        nameEl.addEventListener("focus", () => { nameEl.dataset.prev = nameEl.value; nameEl.value = ""; });
        nameEl.addEventListener("blur", () => { if (!nameEl.value && nameEl.dataset.prev) nameEl.value = nameEl.dataset.prev; });
      }
      AF_WIRED = true;
    }
    afInit();
  },
});
