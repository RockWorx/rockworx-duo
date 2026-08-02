"""Atmosphere & Units plugin backend: the 1976 International Standard Atmosphere (ISA) plus airspeed
conversions (Mach / TAS / EAS / CAS) and a Reynolds-number calculator.

PURE PYTHON STDLIB -- no extra dependencies. This is the "works out of the box" tier of the aero pack:
it proves a plugin can deliver real value with nothing to install. The relations are the standard
textbook ones (ISA-1976; compressible subsonic airspeed relations, Anderson / aviation-formulary), and
the panel states its assumptions.

Plugin contract: register(ctx) mounts routes under /api/plugin/atmosphere-units/<subpath>. A GET handler
receives the query-params dict (values are lists, urllib parse_qs style) and returns a dict.
"""
import math

# --- ISA-1976 constants -----------------------------------------------------
G0 = 9.80665            # m/s^2
R_AIR = 287.05287       # J/(kg K), specific gas constant for air
GAMMA = 1.4
R_EARTH = 6356766.0     # m, for geometric <-> geopotential altitude
T0, P0, RHO0 = 288.15, 101325.0, 1.225
A0 = math.sqrt(GAMMA * R_AIR * T0)   # sea-level speed of sound, ~340.294 m/s
BETA_S, S_SUTH = 1.458e-6, 110.4     # Sutherland's law for dynamic viscosity

# base layers: (geopotential base H [m], base T [K], lapse rate L [K/m], base P [Pa])
_LAYERS = [
    (0.0,     288.15, -0.0065,  101325.0),
    (11000.0, 216.65,  0.0,     22632.06),
    (20000.0, 216.65,  0.001,   5474.889),
    (32000.0, 228.65,  0.0028,  868.0187),
    (47000.0, 270.65,  0.0,     110.9063),
    (51000.0, 270.65, -0.0028,  66.93887),
    (71000.0, 214.65, -0.002,   3.956420),
]
_H_TOP = 84852.0   # geopotential top of the model (~86 km geometric)

ALT_UNITS = {"m": 1.0, "km": 1000.0, "ft": 0.3048, "FL": 30.48}   # FL = flight level (hundreds of ft)
LEN_UNITS = {"m": 1.0, "cm": 0.01, "mm": 0.001, "ft": 0.3048, "in": 0.0254}
SPD_UNITS = {"m/s": 1.0, "kt": 0.514444, "km/h": 1.0 / 3.6, "mph": 0.44704, "ft/s": 0.3048}
MS_TO_KT = 1.0 / 0.514444


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


def isa(z_geometric):
    """ISA properties at geometric altitude z (metres)."""
    H = R_EARTH * z_geometric / (R_EARTH + z_geometric)   # geopotential altitude
    H = max(0.0, min(H, _H_TOP))
    Hb, Tb, L, Pb = _LAYERS[0]
    for layer in _LAYERS:
        if H >= layer[0]:
            Hb, Tb, L, Pb = layer
        else:
            break
    T = Tb + L * (H - Hb)
    if abs(L) > 1e-12:
        P = Pb * (T / Tb) ** (-G0 / (L * R_AIR))
    else:
        P = Pb * math.exp(-G0 * (H - Hb) / (R_AIR * Tb))
    rho = P / (R_AIR * T)
    a = math.sqrt(GAMMA * R_AIR * T)
    mu = BETA_S * T ** 1.5 / (T + S_SUTH)
    return {"T": T, "p": P, "rho": rho, "a": a, "mu": mu,
            "theta": T / T0, "delta": P / P0, "sigma": rho / RHO0, "geopotential": H}


def _qc_from_mach(M, P):
    """Subsonic (M<1) impact (dynamic) pressure -- compressible. Rayleigh for M>=1 is not modelled."""
    return P * ((1.0 + 0.2 * M * M) ** 3.5 - 1.0)


def _airspeeds(value, kind, atm):
    """Given a speed 'value' (m/s, or a raw Mach if kind=='mach') and the local atmosphere, resolve the
    Mach number and return Mach / TAS / EAS / CAS (m/s) + dynamic pressures. Subsonic CAS relations."""
    a, sigma, P, rho = atm["a"], atm["sigma"], atm["p"], atm["rho"]
    if kind == "mach":
        M = value
    elif kind == "eas":
        M = (value / math.sqrt(sigma)) / a
    elif kind == "cas":
        qc = _qc_from_mach(value / A0, P0)                 # CAS is referenced to sea level (a0, P0)
        M = math.sqrt(5.0 * ((qc / P + 1.0) ** (1.0 / 3.5) - 1.0))
    else:  # tas
        M = value / a
    tas = M * a
    eas = tas * math.sqrt(sigma)
    qc = _qc_from_mach(M, P)
    cas = A0 * math.sqrt(5.0 * ((qc / P0 + 1.0) ** (1.0 / 3.5) - 1.0))
    q = 0.5 * rho * tas * tas
    return {"mach": M, "tas": tas, "eas": eas, "cas": cas, "q": q, "qc": qc, "supersonic": M >= 1.0}


def compute(params):
    alt = _num(params, "alt", 0.0)
    altunit = _one(params, "altunit", "m")
    z = alt * ALT_UNITS.get(altunit, 1.0)
    atm = isa(z)
    out = {
        "altitude_m": round(z, 2),
        "atmosphere": {
            "T": round(atm["T"], 3), "T_C": round(atm["T"] - 273.15, 3),
            "p": round(atm["p"], 4), "rho": round(atm["rho"], 6),
            "a": round(atm["a"], 3), "a_kt": round(atm["a"] * MS_TO_KT, 2),
            "mu": atm["mu"],
            "theta": round(atm["theta"], 5), "delta": round(atm["delta"], 6), "sigma": round(atm["sigma"], 6),
        },
    }
    sp = _one(params, "speed", None)
    if sp not in (None, ""):
        try:
            spval = float(sp)
        except (TypeError, ValueError):
            spval = None
        if spval is not None:
            kind = str(_one(params, "speedtype", "mach")).lower()
            if kind == "mach":
                value = spval
            else:
                value = spval * SPD_UNITS.get(_one(params, "spdunit", "kt"), 1.0)
            s = _airspeeds(value, kind, atm)
            out["speeds"] = {
                "mach": round(s["mach"], 4),
                "tas_ms": round(s["tas"], 3), "tas_kt": round(s["tas"] * MS_TO_KT, 2),
                "eas_ms": round(s["eas"], 3), "eas_kt": round(s["eas"] * MS_TO_KT, 2),
                "cas_ms": round(s["cas"], 3), "cas_kt": round(s["cas"] * MS_TO_KT, 2),
                "q_pa": round(s["q"], 2), "supersonic": s["supersonic"],
            }
            ln = _one(params, "length", None)
            if ln not in (None, ""):
                try:
                    lval = float(ln)
                except (TypeError, ValueError):
                    lval = None
                if lval is not None:
                    L_m = lval * LEN_UNITS.get(_one(params, "lenunit", "m"), 1.0)
                    re_per_m = atm["rho"] * s["tas"] / atm["mu"]
                    out["reynolds"] = {
                        "length_m": round(L_m, 5),
                        "Re": re_per_m * L_m,
                        "Re_per_m": re_per_m,
                    }
    return out


def profile(params):
    """ISA profile arrays for plotting (0 .. zmax metres)."""
    zmax = _num(params, "zmax", 30000.0)
    n = int(_num(params, "n", 60))
    n = max(2, min(n, 200))
    alt_km, T, sigma, delta, theta = [], [], [], [], []
    for i in range(n):
        z = zmax * i / (n - 1)
        atm = isa(z)
        alt_km.append(round(z / 1000.0, 3))
        T.append(round(atm["T"], 2))
        sigma.append(round(atm["sigma"], 5))
        delta.append(round(atm["delta"], 5))
        theta.append(round(atm["theta"], 5))
    return {"altitude_km": alt_km, "T": T, "sigma": sigma, "delta": delta, "theta": theta}


def register(ctx):
    ctx.route("GET", "/compute", compute)    # -> /api/plugin/atmosphere-units/compute
    ctx.route("GET", "/profile", profile)    # -> /api/plugin/atmosphere-units/profile
