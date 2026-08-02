// Wing / VLM panel -- planform sketch + spanwise loading (VLM vs elliptical) + result tables.
// Canvas plots only (no chart library, CSP-clean). Loaded once; ids resolve via getElementById.

let WV_WIRED = false;
let WV_RAN = false;

function wvFmt(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function wvSize(canvas) {
  const W = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 300;
  const H = canvas.clientHeight || 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  return { g, W, H };
}

function wvLine(canvas, series, opts) {
  opts = opts || {};
  if (!canvas) return;
  const { g, W, H } = wvSize(canvas);
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
    g.fillStyle = "#64748b"; g.textAlign = "right"; g.fillText(wvFmt(yv), padL - 5, yp);
    const xv = xmin + (xmax - xmin) * i / 4, xp = sx(xv);
    g.strokeStyle = "#1e293b"; g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + ph); g.stroke();
    g.fillStyle = "#64748b"; g.textAlign = "center"; g.textBaseline = "top"; g.fillText(wvFmt(xv), xp, padT + ph + 5);
    g.textBaseline = "middle";
  }
  series.forEach((s) => {
    g.strokeStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash ? [5, 4] : []);
    g.beginPath();
    for (let i = 0; i < s.xs.length; i++) { const X = sx(s.xs[i]), Y = sy(s.ys[i]); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.stroke(); g.setLineDash([]);
  });
  if (series.some((s) => s.label)) {
    g.textAlign = "left"; g.textBaseline = "middle"; let ly = padT + 8;
    series.forEach((s) => {
      if (!s.label) return;
      g.strokeStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash ? [5, 4] : []);
      g.beginPath(); g.moveTo(padL + pw - 74, ly); g.lineTo(padL + pw - 60, ly); g.stroke(); g.setLineDash([]);
      g.fillStyle = "#cbd5e1"; g.fillText(s.label, padL + pw - 54, ly); ly += 14;
    });
  }
  g.fillStyle = "#94a3b8"; g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(opts.xlabel || "", padL + pw / 2, H);
  g.save(); g.translate(11, padT + ph / 2); g.rotate(-Math.PI / 2);
  g.textAlign = "center"; g.textBaseline = "top"; g.fillText(opts.ylabel || "", 0, 0); g.restore();
}

function wvPlanform(canvas, geo) {
  if (!canvas) return;
  const { g, W, H } = wvSize(canvas);
  const s = geo.span / 2, root = geo.root_chord, tip = geo.tip_chord, xt = geo.xle_tip;
  const pts = [[-s, xt], [0, 0], [s, xt], [s, xt + tip], [0, root], [-s, xt + tip]];  // LE then TE
  const xmax = Math.max(root, xt + tip, 1e-6);
  const pad = 18;
  const scale = Math.min((W - 2 * pad) / (2 * s), (H - 2 * pad) / xmax);
  const oy = (H - xmax * scale) / 2;
  const X = (y) => W / 2 + y * scale;
  const Y = (x) => oy + x * scale;                 // chord: LE at top, aft downward
  g.strokeStyle = "#334155"; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(0), Y(xmax)); g.stroke(); g.setLineDash([]);
  g.beginPath();
  pts.forEach((p, i) => { const px = X(p[0]), py = Y(p[1]); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
  g.closePath();
  g.fillStyle = "rgba(56,189,248,0.12)"; g.strokeStyle = "#38bdf8"; g.lineWidth = 2; g.fill(); g.stroke();
  g.fillStyle = "#64748b"; g.font = "10px monospace"; g.textAlign = "center"; g.textBaseline = "top";
  g.fillText("b = " + geo.span + " m", W / 2, H - 12);
}

function wvTable(el, rows) {
  if (!el) return;
  el.textContent = "";
  for (const row of rows) {
    const k = row[0], v = row[1], cls = row[2];
    const r = document.createElement("div"); r.className = "wv-row";
    const a = document.createElement("span"); a.className = "wv-k"; a.textContent = k;
    const b = document.createElement("span"); b.className = "wv-v" + (cls ? " " + cls : ""); b.textContent = v;
    r.appendChild(a); r.appendChild(b); el.appendChild(r);
  }
}

function wvShowInstall(hint) {
  const install = document.getElementById("wv-install"), body = document.getElementById("wv-body");
  if (body) body.style.display = "none";
  if (!install) return;
  install.style.display = "block"; install.textContent = "";
  const b = document.createElement("b"); b.textContent = "Wing / VLM needs AeroSandbox.";
  install.appendChild(b);
  install.appendChild(document.createTextNode(" Install it into the harness's Python environment, then restart:"));
  install.appendChild(document.createElement("br"));
  const code = document.createElement("code");
  code.textContent = hint || "pip install -r plugins/wing-vlm/requirements.txt";
  install.appendChild(code);
}

async function wvAnalyze() {
  const val = (id, d) => { const e = document.getElementById(id); return e ? String(e.value).trim() : d; };
  const q = new URLSearchParams({
    span: val("wv-span", "8"), root: val("wv-root", "1.0"), taper: val("wv-taper", "0.5"),
    sweep: val("wv-sweep", "0"), dihedral: val("wv-dihedral", "0"), twist: val("wv-twist", "0"),
    airfoil: val("wv-airfoil", "naca2412"), alpha: val("wv-alpha", "5"), velocity: val("wv-velocity", "50"),
  });
  const cg = val("wv-cg", ""); if (cg) q.set("cg", cg);
  const status = document.getElementById("wv-status");
  if (status) status.textContent = "running VLM…";
  let d;
  try { d = await Harness.api("/api/plugin/wing-vlm/analyze?" + q.toString()); }
  catch (e) { if (status) status.textContent = "error: " + e.message; return; }
  if (d && d.error) { if (status) status.textContent = d.error; if (d.available === false) wvShowInstall(d.hint); return; }

  const G = d.geometry, A = d.aero, S = d.stability, L = d.loading;
  if (status) status.textContent = "CL " + A.CL + " · CDi " + A.CDi + " · e " + A.e_span + " · NP " + S.x_np_pctMAC + "%MAC";
  wvPlanform(document.getElementById("wv-planform"), G);
  wvLine(document.getElementById("wv-loading"), [
    { xs: L.y_over_s, ys: L.L_norm, color: "#38bdf8", label: "VLM" },
    { xs: L.y_over_s, ys: L.elliptical, color: "#f59e0b", label: "elliptical", dash: true },
  ], { xlabel: "y / semispan", ylabel: "L' (normalized)" });

  wvTable(document.getElementById("wv-geo"), [
    ["Area S", G.S + " m^2"], ["Aspect ratio", G.AR], ["Span b", G.span + " m"],
    ["MAC", G.mac + " m"], ["Taper", G.taper], ["Root / tip chord", G.root_chord + " / " + G.tip_chord + " m"],
    ["Sweep c/4", G.sweep_c4 + " deg"], ["Dihedral", G.dihedral + " deg"], ["Tip twist", G.twist_tip + " deg"],
  ]);
  wvTable(document.getElementById("wv-aero"), [
    ["alpha", A.alpha + " deg"], ["CL", A.CL], ["CDi (induced)", A.CDi],
    ["Cm", A.Cm], ["L / Di", A.L_over_Di], ["Span efficiency e", A.e_span],
  ]);
  const stab = [
    ["CL_alpha", A.velocity ? (S.CLa_per_deg + " /deg  (" + S.CLa_per_rad + " /rad)") : S.CLa_per_deg],
    ["Cm_alpha", S.Cma_per_rad + " /rad"],
    ["Neutral point", S.x_np_pctMAC + " %MAC  (" + S.x_np_m + " m)"],
    ["Cn_beta (weathercock)", S.Cnb],
    ["Cl_beta (dihedral eff.)", S.Clb],
  ];
  if (S.static_margin_pctMAC !== undefined) {
    stab.push(["CG", S.cg_pctMAC + " %MAC"]);
    stab.push(["Static margin", S.static_margin_pctMAC + " %MAC", S.static_margin_pctMAC >= 0 ? "good" : "bad"]);
  }
  wvTable(document.getElementById("wv-stab"), stab);
}

Harness.registerPanel("wing-vlm", {
  async onActivate() {
    if (!WV_WIRED) {
      const run = document.getElementById("wv-run");
      if (run) run.addEventListener("click", wvAnalyze);
      ["wv-span", "wv-root", "wv-taper", "wv-sweep", "wv-dihedral", "wv-twist", "wv-airfoil", "wv-alpha", "wv-velocity", "wv-cg"]
        .forEach((id) => { const e = document.getElementById(id); if (e) e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") wvAnalyze(); }); });
      WV_WIRED = true;
    }
    let st;
    try { st = await Harness.api("/api/plugin/wing-vlm/status"); }
    catch (e) { st = { available: false }; }
    if (!st || !st.available) { wvShowInstall(st && st.hint); return; }
    const install = document.getElementById("wv-install"), body = document.getElementById("wv-body");
    if (install) install.style.display = "none";
    if (body) body.style.display = "block";
    if (!WV_RAN) { WV_RAN = true; setTimeout(wvAnalyze, 40); }
  },
});
