"""Wing / VLM plugin backend: whole-wing aerodynamics via AeroSandbox's Vortex-Lattice Method.

Give a planform (span, root chord, taper, quarter-chord sweep, dihedral, tip twist, airfoil) and an
angle of attack; get the integrated coefficients (CL, induced CDi, Cm), the span efficiency, the full
set of stability derivatives + the neutral point, and the spanwise lift distribution (with the ideal
elliptical overlay -- the classic teaching plot).

VLM is INVISCID: it gives lift, INDUCED drag, load distribution, and stability -- not profile drag.
Pair it with Airfoil Lab (NeuralFoil) for the viscous 2-D drag. AeroSandbox is an OPTIONAL, plugin-level
dependency (see plugins/wing-vlm/requirements.txt) so the harness core stays dependency-light; when it
is absent the panel shows an install hint instead of failing.

Plugin contract: register(ctx) mounts routes under /api/plugin/wing-vlm/<subpath>.
"""
import math
import warnings

try:
    import numpy as np
    import aerosandbox as asb
    _IMPORT_ERROR = None
except Exception as exc:
    np = asb = None
    _IMPORT_ERROR = repr(exc)

_INSTALL_HINT = ("pip install -r plugins/wing-vlm/requirements.txt  "
                 "(into the harness's Python environment), then restart the harness")
_SPANWISE, _CHORDWISE = 16, 6   # VLM mesh -- balances speed vs accuracy for a single wing


def _status():
    return {"available": _IMPORT_ERROR is None, "hint": _INSTALL_HINT, "import_error": _IMPORT_ERROR}


def _one(params, key, default):
    v = params.get(key, default)
    if isinstance(v, (list, tuple)):
        return v[0] if v else default
    return v


def _num(params, key, default):
    try:
        return float(_one(params, key, default))
    except (TypeError, ValueError):
        return default


def _loading(vlm, alpha_deg):
    """Spanwise lift per unit span L'(y) from the per-panel forces AeroSandbox computed (verified to
    integrate to CL*q*S). Returns (y_list, Lprime_list)."""
    F = np.asarray(vlm.forces_geometry)               # per-panel force, geometry axes (x back, z up)
    yc = np.asarray(vlm.vortex_centers)[:, 1]
    a = math.radians(alpha_deg)
    lift = F[:, 2] * math.cos(a) - F[:, 0] * math.sin(a)   # component perpendicular to freestream
    uniq = {}
    for y, l in zip(yc, lift):                        # sum chordwise panels sharing a spanwise station
        k = round(float(y), 4)
        uniq[k] = uniq.get(k, 0.0) + float(l)
    yy = np.array(sorted(uniq.keys()))
    Lp = np.array([uniq[k] for k in yy])
    if len(yy) < 2:
        return yy.tolist(), Lp.tolist()
    edges = (yy[1:] + yy[:-1]) / 2.0
    w = np.empty_like(yy)
    w[1:-1] = edges[1:] - edges[:-1]
    w[0] = edges[0] - (yy[0] - (yy[1] - yy[0]) / 2.0)
    w[-1] = (yy[-1] + (yy[-1] - yy[-2]) / 2.0) - edges[-1]
    Lprime = Lp / np.maximum(w, 1e-9)
    return yy.tolist(), Lprime.tolist()


def analyze(params):
    if _IMPORT_ERROR is not None:
        return {"error": "AeroSandbox is not installed in this environment", **_status()}

    b = max(0.1, _num(params, "span", 8.0))          # full span [m]
    root = max(0.01, _num(params, "root", 1.0))      # root chord [m]
    taper = min(max(_num(params, "taper", 0.5), 0.01), 1.0)
    sweep = _num(params, "sweep", 0.0)               # quarter-chord sweep [deg]
    dih = _num(params, "dihedral", 0.0)              # [deg]
    twist = _num(params, "twist", 0.0)               # tip twist (washout is negative) [deg]
    alpha = _num(params, "alpha", 5.0)
    V = max(1.0, _num(params, "velocity", 50.0))
    airfoil = str(_one(params, "airfoil", "naca2412")).strip().lower().replace(" ", "")

    tip = taper * root
    # place the tip so the QUARTER-CHORD line has the requested sweep; z from dihedral.
    xle_tip = 0.25 * root + (b / 2.0) * math.tan(math.radians(sweep)) - 0.25 * tip
    zle_tip = (b / 2.0) * math.tan(math.radians(dih))

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")   # asb warns to stderr on an unknown name; we handle it cleanly
            af = asb.Airfoil(airfoil)
        if af.coordinates is None or len(af.coordinates) < 10:
            raise ValueError("no coordinates")
    except Exception:
        return {"error": "unknown airfoil '%s' -- try a NACA code (naca2412, naca0012) or a UIUC name" % airfoil}

    _c = np.array(af.coordinates, dtype=float)          # decimated section, for the frontend 3-D loft
    _step = max(1, len(_c) // 60)
    af_coords = {"x": [round(float(x), 5) for x in _c[::_step, 0]],
                 "y": [round(float(y), 5) for y in _c[::_step, 1]]}

    wing = asb.Wing(name="wing", symmetric=True, xsecs=[
        asb.WingXSec(xyz_le=[0, 0, 0], chord=root, airfoil=af, twist=0),
        asb.WingXSec(xyz_le=[xle_tip, b / 2.0, zle_tip], chord=tip, airfoil=af, twist=twist),
    ])
    ap = asb.Airplane(name="ac", wings=[wing])
    op = asb.OperatingPoint(velocity=V, alpha=alpha)
    try:
        # Uniform (linspace) spanwise spacing -> equal-width strips, so the extracted L'(y) is smooth
        # (the default cosspace clustering leaves a non-physical dip at the centerline).
        vlm = asb.VortexLatticeMethod(airplane=ap, op_point=op,
                                      spanwise_resolution=_SPANWISE, spanwise_spacing_function=np.linspace,
                                      chordwise_resolution=_CHORDWISE)
        r = vlm.run()
        rs = vlm.run_with_stability_derivatives()
    except Exception as exc:
        return {"error": "VLM failed: %r" % (exc,)}

    S = float(wing.area()); AR = float(wing.aspect_ratio())
    span = float(wing.span()); mac = float(wing.mean_aerodynamic_chord())
    CL = float(r["CL"]); CDi = float(r["CD"]); Cm = float(r["Cm"])
    e = (CL * CL) / (math.pi * AR * CDi) if CDi > 1e-9 else None
    CLa = float(rs["CLa"]); Cma = float(rs["Cma"]); Cnb = float(rs["Cnb"]); Clb = float(rs["Clb"])
    x_np = float(rs["x_np"])

    # neutral point as %MAC (analytic MAC-LE x for a linearly-tapered wing)
    tanLE = xle_tip / (b / 2.0)
    y_mac = (b / 6.0) * ((1.0 + 2.0 * taper) / (1.0 + taper))
    xle_mac = y_mac * tanLE
    np_pct = (x_np - xle_mac) / mac * 100.0

    yy, Lprime = _loading(vlm, alpha)
    s = span / 2.0
    yn = [y / s for y in yy]
    Lmax = max(Lprime) if Lprime else 1.0
    Lmax = Lmax if abs(Lmax) > 1e-12 else 1.0
    Ln = [v / Lmax for v in Lprime]
    ellip = [math.sqrt(max(0.0, 1.0 - min(1.0, yv * yv))) for yv in yn]

    out = {
        "airfoil": airfoil,
        "coords": af_coords,
        "geometry": {
            "S": round(S, 4), "AR": round(AR, 3), "span": round(span, 3), "mac": round(mac, 4),
            "root_chord": round(root, 4), "tip_chord": round(tip, 4), "taper": round(taper, 3),
            "sweep_c4": round(sweep, 2), "dihedral": round(dih, 2), "twist_tip": round(twist, 2),
            "xle_tip": round(xle_tip, 4), "zle_tip": round(zle_tip, 4),
        },
        "aero": {
            "alpha": round(alpha, 2), "velocity": round(V, 2),
            "CL": round(CL, 4), "CDi": round(CDi, 5), "Cm": round(Cm, 4),
            "L_over_Di": round(CL / CDi, 1) if CDi > 1e-9 else None,
            "e_span": round(e, 3) if e is not None else None,
        },
        "stability": {
            "CLa_per_rad": round(CLa, 3), "CLa_per_deg": round(CLa * math.pi / 180.0, 4),
            "Cma_per_rad": round(Cma, 3), "x_np_m": round(x_np, 4), "x_np_pctMAC": round(np_pct, 1),
            "Cnb": round(Cnb, 5), "Clb": round(Clb, 5),
        },
        "loading": {
            "y_over_s": [round(v, 4) for v in yn],
            "L_norm": [round(v, 4) for v in Ln],
            "elliptical": [round(v, 4) for v in ellip],
        },
    }
    cg = _one(params, "cg", None)
    if cg not in (None, ""):
        try:
            cgp = float(cg)
        except (TypeError, ValueError):
            cgp = None
        if cgp is not None:
            out["stability"]["cg_pctMAC"] = round(cgp, 1)
            out["stability"]["static_margin_pctMAC"] = round(np_pct - cgp, 1)
    return out


def register(ctx):
    ctx.route("GET", "/status", lambda params: _status())   # -> /api/plugin/wing-vlm/status
    ctx.route("GET", "/analyze", analyze)                   # -> /api/plugin/wing-vlm/analyze
