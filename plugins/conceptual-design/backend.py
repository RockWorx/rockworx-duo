"""Conceptual Design capstone backend: a first-order aircraft SIZING loop, pure Python (no deps).

Walks the classic conceptual-design chain -- mission -> weight sizing (fuel fractions + an empty-weight
regression + the MTOW fixed-point iteration) -> wing sizing (stall-limited wing loading -> area, span,
chords) -> a closure check -- using standard textbook methods (Raymer sizing, Breguet range, ISA-1976).
It is deliberately dependency-free so it is the "works out of the box" tier and every number is traceable.

Plugin contract: register(ctx) mounts routes under /api/plugin/conceptual-design/<subpath>.
"""
import math

# --- ISA-1976 (self-contained; troposphere + low stratosphere is plenty for aircraft) --------------
G0, R_AIR, GAMMA, R_EARTH = 9.80665, 287.05287, 1.4, 6356766.0
T0, P0, RHO0 = 288.15, 101325.0, 1.225
_LAYERS = [(0.0, 288.15, -0.0065, 101325.0), (11000.0, 216.65, 0.0, 22632.06),
           (20000.0, 216.65, 0.001, 5474.889), (32000.0, 228.65, 0.0028, 868.0187)]

# unit conversions
FT, KT, NM, LB, HP = 0.3048, 0.514444, 1852.0, 0.453592, 745.7
M2_FT2, M_FT, NM2_LBFT2, W_HP = 10.76391, 3.280840, 0.0208854, 1.0 / 745.7

# empty-weight regressions We/W0 = A * W0^C (W0 in lb) -- Raymer Table 3.1 (approximate class averages)
EMPTY_CLASSES = {
    "GA single-engine": (2.36, -0.18),
    "GA twin-engine": (1.51, -0.10),
    "homebuilt composite": (1.15, -0.09),
    "jet trainer": (1.59, -0.10),
    "transport jet": (0.97, -0.06),
}


def isa(z):
    z = max(0.0, z)
    H = R_EARTH * z / (R_EARTH + z)
    Hb, Tb, L, Pb = _LAYERS[0]
    for layer in _LAYERS:
        if H >= layer[0]:
            Hb, Tb, L, Pb = layer
        else:
            break
    T = Tb + L * (H - Hb)
    P = Pb * (T / Tb) ** (-G0 / (L * R_AIR)) if abs(L) > 1e-12 else Pb * math.exp(-G0 * (H - Hb) / (R_AIR * Tb))
    rho = P / (R_AIR * T)
    return {"T": T, "p": P, "rho": rho, "a": math.sqrt(GAMMA * R_AIR * T)}


def _one(params, key, default):
    v = params.get(key, default)
    return (v[0] if v else default) if isinstance(v, (list, tuple)) else v


def _num(params, key, default):
    try:
        return float(_one(params, key, default))
    except (TypeError, ValueError):
        return default


def size(params):
    # --- mission -----------------------------------------------------------
    payload = _num(params, "payload_lb", 400.0)
    crew = _num(params, "crew_lb", 400.0)
    rng_nm = max(0.0, _num(params, "range_nm", 500.0))
    alt_ft = max(0.0, _num(params, "cruise_alt_ft", 8000.0))
    spd = _num(params, "cruise_speed", 140.0)
    spd_type = str(_one(params, "speed_type", "kt")).lower()

    # --- propulsion + aero assumptions ------------------------------------
    prop_type = str(_one(params, "prop_type", "prop")).lower()
    tsfc = _num(params, "tsfc_1hr", 0.5)          # jet TSFC [1/hr]
    bsfc = _num(params, "bsfc_lbhphr", 0.45)      # prop BSFC [lb/(hp*hr)]
    eta_p = min(max(_num(params, "eta_p", 0.8), 0.1), 0.95)
    ld = max(1.0, _num(params, "ld_cruise", 12.0))
    clmax = max(0.3, _num(params, "clmax", 1.6))
    vstall_kt = max(10.0, _num(params, "vstall_kt", 50.0))
    ar = max(2.0, _num(params, "ar", 8.0))
    taper = min(max(_num(params, "taper", 0.6), 0.1), 1.0)
    reserve = max(0.0, _num(params, "reserve_frac", 0.06))
    ecls = str(_one(params, "empty_class", "GA single-engine"))
    A, C = EMPTY_CLASSES.get(ecls, EMPTY_CLASSES["GA single-engine"])

    # constraint-diagram assumptions (drag polar + climb/takeoff field length)
    cd0 = max(0.005, _num(params, "cd0", 0.025))              # parasite (zero-lift) drag coeff
    e_osw = min(max(_num(params, "oswald_e", 0.80), 0.5), 1.0)  # Oswald span efficiency
    roc_fpm = max(0.0, _num(params, "roc_fpm", 800.0))       # sea-level rate of climb [ft/min]
    to_roll_ft = max(100.0, _num(params, "takeoff_roll_ft", 1500.0))  # takeoff ground roll [ft]

    atm = isa(alt_ft * FT)
    V = spd * atm["a"] if spd_type == "mach" else spd * KT     # cruise TAS [m/s]
    mach = V / atm["a"]

    # --- mission fuel fraction (Raymer segment fractions; cruise via Breguet) ----------
    seg = {"takeoff": 0.970, "climb": 0.985, "descent": 0.990, "landing": 0.995}
    R = rng_nm * NM
    if prop_type == "jet":
        cr = math.exp(-R * (tsfc / 3600.0) / (V * ld))
    else:
        c_p = bsfc * LB / (HP * 3600.0)                        # BSFC -> kg/(W*s)
        cr = math.exp(-R * c_p * G0 / (eta_p * ld))
    seg["cruise"] = cr
    mission_frac = 1.0
    for f in seg.values():
        mission_frac *= f
    wf_w0 = (1.0 + reserve) * (1.0 - mission_frac)             # fuel fraction (with reserve)

    # --- MTOW fixed-point iteration:  W0 = (crew+payload) / (1 - Wf/W0 - We/W0) ----------
    fixed = crew + payload
    w0 = fixed * 4.0
    converged, iters = False, 0
    for iters in range(1, 201):
        we_w0 = A * (w0 ** C)
        denom = 1.0 - wf_w0 - we_w0
        if denom <= 0.05:
            return {"error": "design does not close: empty + fuel fractions exceed take-off weight. "
                             "Lower the range, raise L/D, or choose a lighter empty-weight class."}
        w0_new = fixed / denom
        if abs(w0_new - w0) < 0.05:
            w0 = w0_new
            converged = True
            break
        w0 = w0_new
    we_w0 = A * (w0 ** C)
    mtow = w0
    we = we_w0 * w0
    wf = wf_w0 * w0

    # --- wing sizing: stall-limited wing loading -> area, span, chords ----------
    W_N = mtow * LB * G0
    q_stall = 0.5 * RHO0 * (vstall_kt * KT) ** 2
    ws_stall = q_stall * clmax                                 # max W/S so Vstall met at CLmax, S/L [N/m2]
    ws_design = 0.95 * ws_stall
    S = W_N / ws_design                                        # [m2]
    b = math.sqrt(ar * S)
    root = 2.0 * S / (b * (1.0 + taper))
    tip = root * taper

    # --- closure check ----------------------------------------------------
    vstall_actual = math.sqrt(2.0 * W_N / (RHO0 * S * clmax)) / KT   # kt, at MTOW
    q_cr = 0.5 * atm["rho"] * V * V
    cl_cr = W_N / (q_cr * S)
    thrust_req = W_N / ld                                      # cruise thrust = drag = W/(L/D) [N]
    tw_cruise = thrust_req / W_N
    power_req_hp = (thrust_req * V / eta_p) / HP if prop_type == "prop" else None

    # --- constraint / matching diagram: installed T/W (jet) or P/W (prop) required vs W/S -----------
    # Each flight-condition constraint gives a required thrust-to-TO-weight (twc, no lapse); jets show it
    # as installed sea-level T/W (divide by thrust lapse); props convert to installed SL power loading
    # P/W [hp/lb] at each constraint's own speed + density (power lapses ~ sigma). Feasible = above every
    # curve AND left of the stall line. Standard set (Raymer/Mattingly), first-order.
    is_jet = prop_type == "jet"
    Kd = 1.0 / (math.pi * ar * e_osw)                          # induced-drag factor 1/(pi AR e)
    maxld_polar = 0.5 * math.sqrt(math.pi * ar * e_osw / cd0)  # polar-implied (L/D)max cross-check
    beta_cr = seg["takeoff"] * seg["climb"]                    # weight fraction at start of cruise
    sigma_cr = atm["rho"] / RHO0
    v_stall = vstall_kt * KT
    v_climb = 1.3 * v_stall                                    # safe sea-level climb speed
    v_lift = 1.1 * v_stall                                     # liftoff speed
    g_climb = (roc_fpm * FT / 60.0) / v_climb                  # required climb gradient sin(gamma)
    q_climb = 0.5 * RHO0 * v_climb * v_climb
    PW = 0.0059648                                             # (W/N) -> (hp/lbf)

    def twc_cruise(ws):
        return q_cr * cd0 / ws + Kd * beta_cr * beta_cr * ws / q_cr
    def twc_climb(ws):
        return q_climb * cd0 / ws + Kd * ws / q_climb + g_climb
    def twc_takeoff(ws):
        return 1.21 * ws / (G0 * RHO0 * clmax * (to_roll_ft * FT))

    def to_y(twc, v_cond, sigma_cond, lapse_jet):
        if is_jet:
            return twc / lapse_jet                             # installed sea-level T/W
        return twc * v_cond / (eta_p * sigma_cond) * PW        # installed sea-level P/W [hp/lb]

    def y_cruise(ws):  return to_y(twc_cruise(ws), V, sigma_cr, sigma_cr ** 0.7)
    def y_climb(ws):   return to_y(twc_climb(ws), v_climb, 1.0, 1.0)
    def y_takeoff(ws): return to_y(twc_takeoff(ws), v_lift, 1.0, 1.0)

    ws_lo, ws_hi = 0.30 * ws_stall, 1.25 * ws_stall
    ws_grid = [ws_lo + (ws_hi - ws_lo) * i / 59.0 for i in range(60)]
    to_lbft2 = NM2_LBFT2
    yd_cr, yd_cl, yd_to = y_cruise(ws_design), y_climb(ws_design), y_takeoff(ws_design)
    binding = max(("cruise", yd_cr), ("climb", yd_cl), ("takeoff", yd_to), key=lambda t: t[1])
    out_constraints = {
        "mode": "T/W" if is_jet else "P/W",
        "y_label": "Thrust loading  T/W" if is_jet else "Power loading  P/W (hp/lb)",
        "ws_lbft2": [round(w * to_lbft2, 3) for w in ws_grid],
        "cruise": [round(y_cruise(w), 5) for w in ws_grid],
        "climb": [round(y_climb(w), 5) for w in ws_grid],
        "takeoff": [round(y_takeoff(w), 5) for w in ws_grid],
        "stall_ws_lbft2": round(ws_stall * to_lbft2, 2),
        "design": {"ws": round(ws_design * to_lbft2, 2), "y": round(binding[1], 5), "binding": binding[0],
                   "cruise": round(yd_cr, 5), "climb": round(yd_cl, 5), "takeoff": round(yd_to, 5)},
        "maxld_polar": round(maxld_polar, 1), "assumed_ld": round(ld, 1),
        "cd0": round(cd0, 4), "oswald_e": round(e_osw, 3),
        "roc_fpm": round(roc_fpm, 0), "takeoff_roll_ft": round(to_roll_ft, 0),
    }

    out = {
        "inputs": {"payload_lb": payload, "crew_lb": crew, "range_nm": rng_nm, "cruise_alt_ft": alt_ft,
                   "cruise_kt": round(V / KT, 1), "mach": round(mach, 3), "prop_type": prop_type,
                   "ld_cruise": ld, "clmax": clmax, "vstall_kt": vstall_kt, "ar": ar, "taper": taper,
                   "empty_class": ecls},
        "weights": {
            "mtow_lb": round(mtow, 1), "empty_lb": round(we, 1), "fuel_lb": round(wf, 1),
            "useful_load_lb": round(mtow - we, 1),
            "we_w0": round(we_w0, 4), "wf_w0": round(wf_w0, 4), "crew_payload_lb": round(fixed, 1),
            "cruise_fuel_fraction": round(cr, 4), "converged": converged, "iterations": iters,
        },
        "wing": {
            "wing_loading_lbft2": round(ws_design * NM2_LBFT2, 2),
            "stall_limit_wing_loading_lbft2": round(ws_stall * NM2_LBFT2, 2),
            "area_ft2": round(S * M2_FT2, 1), "span_ft": round(b * M_FT, 1),
            "root_chord_ft": round(root * M_FT, 2), "tip_chord_ft": round(tip * M_FT, 2),
            "aspect_ratio": round(ar, 2),
        },
        "closure": {
            "stall_speed_kt": round(vstall_actual, 1), "cruise_CL": round(cl_cr, 3),
            "cruise_TW": round(tw_cruise, 4),
            "cruise_power_hp": round(power_req_hp, 1) if power_req_hp is not None else None,
            "cruise_thrust_lb": round(thrust_req / (LB * G0), 1),
        },
    }
    out["constraints"] = out_constraints
    return out


def register(ctx):
    ctx.route("GET", "/size", size)     # -> /api/plugin/conceptual-design/size
