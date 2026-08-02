// Atmosphere & Units panel -- ISA properties, airspeed conversions, Reynolds, and ISA-profile plots.
// Pure client rendering; the backend is stdlib-only so this tab always works (no install tier).

let AU_WIRED = false;
let AU_RAN = false;

function auFmt(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function auEng(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.001 || a >= 1e5)) return v.toExponential(4);
  return String(Math.round(v * 1000) / 1000);
}

function auTable(el, rows) {
  if (!el) return;
  el.textContent = "";
  for (const [k, v] of rows) {
    const row = document.createElement("div"); row.className = "au-row";
    const a = document.createElement("span"); a.className = "au-k"; a.textContent = k;
    const b = document.createElement("span"); b.className = "au-v"; b.textContent = v;
    row.appendChild(a); row.appendChild(b); el.appendChild(row);
  }
}

function auLine(canvas, series, opts) {
  opts = opts || {};
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 300;
  const H = canvas.clientHeight || 200;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const padL = 46, padR = 12, padT = 10, padB = 26, pw = W - padL - padR, ph = H - padT - padB;
  let xs = [], ys = [];
  series.forEach((s) => { xs = xs.concat(s.xs); ys = ys.concat(s.ys); });
  if (!xs.length) return;
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (xmin === xmax) { xmin -= 1; xmax += 1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
  const sx = (v) => padL + (v - xmin) / (xmax - xmin) * pw;
  const sy = (v) => padT + (1 - (v - ymin) / (ymax - ymin)) * ph;
  g.font = "10px monospace"; g.textBaseline = "middle"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yv = ymin + (ymax - ymin) * i / 4, yp = sy(yv);
    g.strokeStyle = "#1e293b"; g.beginPath(); g.moveTo(padL, yp); g.lineTo(padL + pw, yp); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "right"; g.fillText(auFmt(yv), padL - 5, yp);
    const xv = xmin + (xmax - xmin) * i / 4, xp = sx(xv);
    g.strokeStyle = "#1e293b"; g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + ph); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "center"; g.textBaseline = "top"; g.fillText(auFmt(xv), xp, padT + ph + 5);
    g.textBaseline = "middle";
  }
  series.forEach((s) => {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < s.xs.length; i++) { const X = sx(s.xs[i]), Y = sy(s.ys[i]); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.stroke();
  });
  if (series.some((s) => s.label)) {
    g.textAlign = "left"; g.textBaseline = "middle"; let ly = padT + 8;
    series.forEach((s) => {
      if (!s.label) return;
      g.fillStyle = s.color; g.fillRect(padL + pw - 66, ly - 4, 12, 3);
      g.fillStyle = "#cbd5e1"; g.fillText(s.label, padL + pw - 50, ly); ly += 14;
    });
  }
  g.fillStyle = "#94a3b8"; g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(opts.xlabel || "", padL + pw / 2, H);
  g.save(); g.translate(11, padT + ph / 2); g.rotate(-Math.PI / 2);
  g.textAlign = "center"; g.textBaseline = "top"; g.fillText(opts.ylabel || "", 0, 0); g.restore();
}

async function auCompute() {
  const status = document.getElementById("au-status");
  const val = (id, d) => { const e = document.getElementById(id); return e ? String(e.value).trim() : d; };
  const q = new URLSearchParams({ alt: val("au-alt", "0") || "0", altunit: val("au-altunit", "m") });
  const sp = val("au-speed", "");
  if (sp) { q.set("speed", sp); q.set("speedtype", val("au-speedtype", "mach")); q.set("spdunit", val("au-spdunit", "kt")); }
  const ln = val("au-length", "");
  if (ln) { q.set("length", ln); q.set("lenunit", val("au-lenunit", "m")); }
  if (status) status.textContent = "computing…";
  let d;
  try { d = await Harness.api("/api/plugin/atmosphere-units/compute?" + q.toString()); }
  catch (e) { if (status) status.textContent = "error: " + e.message; return; }
  if (d && d.error) { if (status) status.textContent = d.error; return; }

  const A = d.atmosphere;
  if (status) status.textContent = "altitude " + d.altitude_m + " m";
  auTable(document.getElementById("au-isa"), [
    ["Temperature", A.T + " K  (" + A.T_C + " C)"],
    ["Pressure", auEng(A.p) + " Pa"],
    ["Density", A.rho + " kg/m^3"],
    ["Speed of sound", A.a + " m/s  (" + A.a_kt + " kt)"],
    ["Viscosity mu", Number(A.mu).toExponential(4) + " Pa.s"],
    ["theta / delta / sigma", A.theta + " / " + A.delta + " / " + A.sigma],
  ]);

  const se = document.getElementById("au-speeds");
  if (d.speeds) {
    const S = d.speeds;
    auTable(se, [
      ["Mach", S.mach + (S.supersonic ? "  (supersonic - subsonic relations!)" : "")],
      ["TAS", S.tas_ms + " m/s  (" + S.tas_kt + " kt)"],
      ["EAS", S.eas_ms + " m/s  (" + S.eas_kt + " kt)"],
      ["CAS", S.cas_ms + " m/s  (" + S.cas_kt + " kt)"],
      ["Dynamic pressure q", auEng(S.q_pa) + " Pa"],
    ]);
  } else {
    auTable(se, [["", "enter a speed above"]]);
  }

  const re = document.getElementById("au-re");
  if (d.reynolds) {
    const R = d.reynolds;
    auTable(re, [
      ["Reference length", R.length_m + " m"],
      ["Reynolds number", Number(R.Re).toExponential(3)],
      ["Re per metre", Number(R.Re_per_m).toExponential(3) + " /m"],
    ]);
  } else {
    auTable(re, [["", "enter a speed + length"]]);
  }
}

async function auProfile() {
  let p;
  try { p = await Harness.api("/api/plugin/atmosphere-units/profile?zmax=30000&n=61"); }
  catch (e) { return; }
  if (!p || !p.altitude_km) return;
  auLine(document.getElementById("au-plot-t"),
    [{ xs: p.altitude_km, ys: p.T, color: "#f59e0b" }], { xlabel: "altitude (km)", ylabel: "T (K)" });
  auLine(document.getElementById("au-plot-r"), [
    { xs: p.altitude_km, ys: p.theta, color: "#f59e0b", label: "theta" },
    { xs: p.altitude_km, ys: p.delta, color: "#38bdf8", label: "delta" },
    { xs: p.altitude_km, ys: p.sigma, color: "#34d399", label: "sigma" },
  ], { xlabel: "altitude (km)", ylabel: "ratio" });
}

Harness.registerPanel("atmosphere-units", {
  onActivate() {
    if (!AU_WIRED) {
      const run = document.getElementById("au-run");
      if (run) run.addEventListener("click", auCompute);
      ["au-alt", "au-speed", "au-length"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") auCompute(); });
      });
      AU_WIRED = true;
    }
    if (!AU_RAN) { AU_RAN = true; setTimeout(() => { auCompute(); auProfile(); }, 40); }
  },
});
