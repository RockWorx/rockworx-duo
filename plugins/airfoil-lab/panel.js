// Airfoil Lab panel -- NeuralFoil polars drawn on <canvas> (no chart library; CSP-clean).
// Loaded once by the plugin loader, so these are globals and the panel's ids resolve via getElementById.

let AF_WIRED = false;
let AF_RAN = false;

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

// --- airfoil outline (equal aspect) -----------------------------------------
function afShape(canvas, coords) {
  const { g, W, H } = afCanvasSize(canvas);
  const xs = coords.x, ys = coords.y;
  if (!xs || !xs.length) return;
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const midX = (xmin + xmax) / 2, midY = (ymin + ymax) / 2;
  const pad = 16;
  const spanX = (xmax - xmin) || 1, spanY = (ymax - ymin) || 1;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const X = (v) => W / 2 + (v - midX) * scale;
  const Y = (v) => H / 2 - (v - midY) * scale;   // flip: y up in airfoil coords, down on screen
  g.strokeStyle = "#334155"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(xmin), Y(0)); g.lineTo(X(xmax), Y(0)); g.stroke();   // chord line
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
  afShape(document.getElementById("af-shape"), d.coords);
  afLine(document.getElementById("af-cl"), [{ xs: d.alpha, ys: d.CL, color: "#38bdf8" }], { xlabel: "alpha (deg)", ylabel: "CL" });
  afLine(document.getElementById("af-dp"), [{ xs: d.CD, ys: d.CL, color: "#a78bfa", dots: true }], { xlabel: "CD", ylabel: "CL" });
  afLine(document.getElementById("af-ld"), [{ xs: d.alpha, ys: d.LD, color: "#34d399" }], { xlabel: "alpha (deg)", ylabel: "L/D", mark: { x: d.best_ld.alpha, y: d.best_ld.ld } });
  afLine(document.getElementById("af-cm"), [{ xs: d.alpha, ys: d.CM, color: "#f59e0b" }], { xlabel: "alpha (deg)", ylabel: "CM" });
  afSummary(d);
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
      AF_WIRED = true;
    }
    afInit();
  },
});
