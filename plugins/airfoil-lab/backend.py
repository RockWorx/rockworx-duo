"""Airfoil Lab plugin backend: airfoil polars via NeuralFoil (an ML surrogate of XFOIL).

Given an airfoil (a NACA 4/5-digit code like ``naca2412`` or a UIUC-database name like ``s1223``), a
Reynolds number, a Mach number, and an alpha sweep, this returns CL / CD / CM and L/D vs alpha plus the
airfoil coordinates for plotting.

NeuralFoil (and the aerosandbox it uses for geometry) is an OPTIONAL, PLUGIN-LEVEL dependency -- see
``plugins/airfoil-lab/requirements.txt`` -- so the harness core stays dependency-light. If it is not
installed, ``/status`` reports that and the panel shows an install hint instead of anything failing.

Plugin contract: ``register(ctx)`` mounts routes under ``/api/plugin/airfoil-lab/<subpath>``. A GET
handler receives the query-params dict (values are lists, urllib parse_qs style); it returns a dict,
which the core serializes to JSON.
"""

try:
    import numpy as np
    import neuralfoil as nf
    import aerosandbox as asb
    _IMPORT_ERROR = None
except Exception as exc:   # numpy / neuralfoil / aerosandbox absent -> degrade gracefully
    np = nf = asb = None
    _IMPORT_ERROR = repr(exc)

MODEL_SIZES = ["small", "medium", "large"]   # NeuralFoil accuracy/speed tiers we expose
_MAX_ALPHAS = 121                            # cap the sweep so a bad request can't spin forever
_INSTALL_HINT = ("pip install -r plugins/airfoil-lab/requirements.txt  "
                 "(into the harness's Python environment), then restart the harness")


def _status():
    return {
        "available": _IMPORT_ERROR is None,
        "models": MODEL_SIZES,
        "hint": _INSTALL_HINT,
        "import_error": _IMPORT_ERROR,
    }


def _one(params, key, default):
    """Pull a single value from a parse_qs-style params dict (values are lists)."""
    v = params.get(key, default)
    if isinstance(v, (list, tuple)):
        return v[0] if v else default
    return v


def _num(params, key, default):
    try:
        return float(_one(params, key, default))
    except (TypeError, ValueError):
        return default


def polar(params):
    if _IMPORT_ERROR is not None:
        return {"error": "NeuralFoil is not installed in this environment", **_status()}

    name = str(_one(params, "airfoil", "naca2412")).strip().lower().replace(" ", "")
    if not name:
        return {"error": "an airfoil name is required (e.g. naca2412)"}

    re = _num(params, "re", 1.0e6)
    amin = _num(params, "amin", -5.0)
    amax = _num(params, "amax", 15.0)
    astep = _num(params, "astep", 1.0)
    model = str(_one(params, "model", "medium"))
    if model not in MODEL_SIZES:
        model = "medium"
    if astep <= 0:
        astep = 1.0
    if amax < amin:
        amin, amax = amax, amin
    n = int(round((amax - amin) / astep)) + 1
    if n > _MAX_ALPHAS:
        return {"error": "too many alpha points (%d); widen the step or narrow the range" % n}

    try:
        af = asb.Airfoil(name)
        coords = np.array(af.coordinates, dtype=float)
        if coords.ndim != 2 or coords.shape[0] < 10:
            raise ValueError("no coordinates")
    except Exception:
        return {"error": "unknown airfoil '%s' -- try a NACA code (e.g. naca2412) or a "
                         "UIUC name (e.g. s1223, e387, clarky)" % name}

    alphas = np.arange(amin, amax + 0.5 * astep, astep)
    try:
        # NeuralFoil is a viscous, incompressible (XFOIL-surrogate) model: Reynolds-based, no Mach.
        res = nf.get_aero_from_airfoil(af, alpha=alphas, Re=re, model_size=model)
    except Exception as exc:
        return {"error": "NeuralFoil failed: %r" % (exc,)}

    cl = np.atleast_1d(res["CL"]).astype(float)
    cd = np.atleast_1d(res["CD"]).astype(float)
    cm = np.atleast_1d(res["CM"]).astype(float)
    ld = cl / np.maximum(cd, 1e-9)
    conf = np.atleast_1d(res.get("analysis_confidence", np.ones_like(cl))).astype(float)
    i_best = int(np.argmax(ld))
    i_clmax = int(np.argmax(cl))
    i_cdmin = int(np.argmin(cd))

    return {
        "airfoil": name,
        "re": re,
        "model": model,
        "alpha": [round(float(a), 3) for a in alphas],
        "CL": [round(float(x), 4) for x in cl],
        "CD": [round(float(x), 5) for x in cd],
        "CM": [round(float(x), 4) for x in cm],
        "LD": [round(float(x), 2) for x in ld],
        "confidence": [round(float(x), 3) for x in conf],
        "coords": {
            "x": [round(float(x), 5) for x in coords[:, 0]],
            "y": [round(float(y), 5) for y in coords[:, 1]],
        },
        "best_ld": {"alpha": round(float(alphas[i_best]), 2), "ld": round(float(ld[i_best]), 2),
                    "cl": round(float(cl[i_best]), 3)},
        "clmax": {"alpha": round(float(alphas[i_clmax]), 2), "cl": round(float(cl[i_clmax]), 3)},
        "cdmin": {"alpha": round(float(alphas[i_cdmin]), 2), "cd": round(float(cd[i_cdmin]), 5)},
    }


def register(ctx):
    ctx.route("GET", "/status", lambda params: _status())     # -> /api/plugin/airfoil-lab/status
    ctx.route("GET", "/polar", polar)                         # -> /api/plugin/airfoil-lab/polar
