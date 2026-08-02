// Agent Harness -- browser client logic.
// Terminals are REAL PTY sessions (claude / gemini CLIs) bridged over WebSockets.
// Each terminal card holds multiple TABS — independent sessions, each with its
// own working directory (project). Panels are populated from live server APIs.

"use strict";

let CONFIG = { wsPort: 8877, roots: [], agents: ["claude", "gemini", "local"], defaultCwd: ".", token: "" };
// (voice-input globals removed with the mic buttons -- voice dictation is not in the public release)
const SESSIONS_UI = {};       // session id -> state
const ACTIVE_TAB = {};        // agent -> active session id
let currentDirPath = null;
let currentEntries = [];

// Every /api call carries the per-run CSWSH token (handed to us by /api/config).
// A cross-origin page cannot read that token, so it cannot forge these requests.
// (Resource loads via <img>/<iframe> src cannot set a header -- they pass the
// token as a ?token= query param via tokenUrl() instead.)
function apiFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, { "X-Harness-Token": CONFIG.token || "" });
  return fetch(url, Object.assign({}, opts, { headers }));
}

function tokenUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(CONFIG.token || "")}`;
}

const XTERM_THEME = {
  background: "#05070D",
  foreground: "#E2E8F0",
  cursor: "#38BDF8",
  cursorAccent: "#05070D",
  selectionBackground: "rgba(56, 189, 248, 0.30)",
  black: "#1E293B",
  red: "#EF4444",
  green: "#10B981",
  yellow: "#F59E0B",
  blue: "#38BDF8",
  magenta: "#A855F7",
  cyan: "#06B6D4",
  white: "#F8FAFC",
  brightBlack: "#64748B",
  brightRed: "#F87171",
  brightGreen: "#34D399",
  brightYellow: "#FBBF24",
  brightBlue: "#7DD3FC",
  brightMagenta: "#C084FC",
  brightCyan: "#22D3EE",
  brightWhite: "#FFFFFF",
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  setupNavigation();
  try {
    const res = await apiFetch("/api/config");
    CONFIG = await res.json();
    setServerStatus(true, "Server connected");
  } catch (err) {
    setServerStatus(false, "Server unreachable");
  }

  await initTerminals();

  // Web-font race: the terminal font 'JetBrains Mono' loads asynchronously from
  // Google Fonts. On a COLD load xterm measures cell geometry inside term.open()
  // BEFORE the font applies, so .xterm-viewport is sized against fallback metrics
  // and the custom ::-webkit-scrollbar thumb does not paint (only a manual reload --
  // when the font is already cached -- fixes it). Re-fit + refresh every visible
  // terminal once the font is truly ready so the grabbable thumb appears on first
  // load. Additive + guarded: no input/IPC path.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      fitAllTerminals();
      for (const st of Object.values(SESSIONS_UI)) {
        try {
          if (st.hostEl.offsetParent !== null) st.term.refresh(0, st.term.rows - 1);
        } catch (_) { /* terminal disposed or not ready; ignore */ }
      }
    });
  }

  for (const agent of CONFIG.agents) {
    const btn = document.getElementById(`newtab-${agent}`);
    if (btn) btn.addEventListener("click", (e) => showNewTabMenu(agent, e.currentTarget));
  }

  await loadPlugins();   // inject any plugin tabs after the core tabs/cards are wired

  document.getElementById("btn-layouts").addEventListener("click", (e) => showLayoutsMenu(e.currentTarget));
  document.getElementById("btn-notify").addEventListener("click", toggleNotify);
  renderNotifyButton();
  renderModelLabels();
  renderEffortLabel();
  // duo_inbox: another window writing a duo-inbox:* key fires `storage` here -> live badge refresh.
  window.addEventListener("storage", (e) => { if (e.key && e.key.indexOf("duo-inbox:") === 0) updateInboxBadges(); });
  updateInboxBadges();
  renderBroadcastTargets();
  refreshGenome();
  setInterval(refreshGenome, 60000);
  setInterval(activityTick, 2000);
  setInterval(updateCollisionMonitor, 5000);

  await renderProjectSidebar();
  if (ACTIVE_PROJECT) renderProjectDashboard(ACTIVE_PROJECT);
  pushFocusState();

  window.addEventListener("resize", debounce(fitAllTerminals, 150));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" &&
        document.getElementById("preview-drawer").classList.contains("open")) {
      closePreview();
    }
  });
});

function setServerStatus(ok, text) {
  const dot = document.getElementById("server-status-dot");
  const label = document.getElementById("server-status-text");
  label.innerText = text;
  dot.style.backgroundColor = ok ? "var(--accent-green)" : "var(--accent-red)";
  dot.style.boxShadow = ok ? "0 0 8px var(--accent-green)" : "0 0 8px var(--accent-red)";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function setupNavigation() {
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));  // fresh: includes injected plugin tabs
      tab.classList.add("active");
      const target = tab.getAttribute("data-tab");
      document.querySelectorAll(".view-panel").forEach((p) => p.classList.remove("active"));
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add("active");
      // DUO/Bridge toggles belong to the Dual CLI view -- show them on the ribbon only there.
      const duoControls = document.getElementById("nav-duo-controls");
      if (duoControls) duoControls.style.display = (target === "cli") ? "" : "none";
      if (target === "cli") setTimeout(fitAllTerminals, 50);
      pushFocusState();
    });
  });
}

// --- Plugin seam: the public frontend API + dynamic tab injection --------------
// window.Harness is the STABLE, documented contract plugins code against. Do not break it.
window.Harness = {
  _panels: {},
  registerPanel(id, hooks) { this._panels[id] = hooks || {}; },
  api(path, opts) { return apiFetch(path, opts).then((r) => r.json()); },
  openPreview(item, title) { return openPreview(item, title); },
  get CONFIG() { return CONFIG; },
};

async function loadPlugins() {
  let data;
  try { data = await (await apiFetch("/api/plugins")).json(); }
  catch (_) { return; }               // no plugins endpoint / none loaded -> nothing to inject
  for (const p of (data.plugins || [])) injectPluginTab(p);
}

function injectPluginTab(p) {
  const nav = document.querySelector(".nav-tabs");
  const main = document.querySelector(".main-container");
  if (!nav || !main) return;

  const btn = document.createElement("button");
  btn.className = "nav-tab";
  btn.dataset.tab = p.id;
  btn.innerHTML = `<span>${escapeHtml((p.tab && p.tab.icon) || "🔌")}</span> ${escapeHtml((p.tab && p.tab.label) || p.name || p.id)}`;
  const spacer = nav.querySelector(".nav-spacer");
  if (spacer) nav.insertBefore(btn, spacer); else nav.appendChild(btn);

  const view = document.createElement("section");
  view.className = "view-panel";
  view.id = "panel-" + p.id;
  main.appendChild(view);

  if (p.frontend && p.frontend.style) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = p.frontend.style;
    document.head.appendChild(link);
  }

  const activate = async () => {
    if (p.frontend && p.frontend.panel && !view.dataset.loaded) {
      try { view.innerHTML = await (await apiFetch(p.frontend.panel)).text(); } catch (_) { /* ignore */ }
      view.dataset.loaded = "1";
    }
    if (p.frontend && p.frontend.script && !view.dataset.scripted) {
      view.dataset.scripted = "1";
      await new Promise((res) => {
        const s = document.createElement("script");
        s.src = p.frontend.script;
        s.onload = res;
        s.onerror = res;
        document.body.appendChild(s);
      });
    }
    const hooks = window.Harness._panels[p.id];
    if (hooks && hooks.onActivate) { try { hooks.onActivate(view); } catch (_) { /* plugin error, isolate */ } }
  };

  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view-panel").forEach((pl) => pl.classList.remove("active"));
    view.classList.add("active");
    const duo = document.getElementById("nav-duo-controls");
    if (duo) duo.style.display = "none";     // plugin tabs are not the Dual-CLI view
    if (typeof pushFocusState === "function") pushFocusState();
    activate();
  });
}

// ---------------------------------------------------------------------------
// Terminal sessions & tabs
// ---------------------------------------------------------------------------

async function initTerminals() {
  let existing = [];
  try {
    const res = await apiFetch("/api/sessions");
    existing = (await res.json()).sessions || [];
  } catch (_) { /* server unreachable; status badge already red */ }

  for (const agent of CONFIG.agents) {
    let mine = existing.filter((s) => s.agent === agent);
    if (mine.length === 0) {
      const created = await createSession(agent, CONFIG.defaultCwd, false);
      if (created) mine = [created];
    }
    mine.forEach((desc) => addSessionTab(agent, desc));
    if (mine.length > 0) activateTab(agent, mine[0].id);
  }
}

async function createSession(agent, cwd, toast = true, profile = null, resume = false) {
  try {
    const body = { agent, cwd };
    if (profile) body.profile = profile;
    if (resume) body.resume = true;
    const res = await apiFetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const desc = await res.json();
    if (desc.error) throw new Error(desc.error);
    if (toast) showToast(`New ${agent} session in ${desc.label}`);
    return desc;
  } catch (err) {
    showToast(`New session failed: ${err.message}`, "error");
    return null;
  }
}

function addSessionTab(agent, desc) {
  const stack = document.getElementById(`stack-${agent}`);
  const tabsEl = document.getElementById(`tabs-${agent}`);
  if (!stack || !tabsEl) return null;

  const host = document.createElement("div");
  host.className = "xterm-host";
  stack.appendChild(host);

  const tabEl = document.createElement("div");
  tabEl.className = "term-tab";
  tabEl.title = desc.cwd;
  const stateDot = document.createElement("span");
  stateDot.className = "tab-state";
  tabEl.appendChild(stateDot);
  const provider = desc.profile || agent;
  const base = (desc.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || desc.label;
  const labelSpan = document.createElement("span");
  labelSpan.className = "tab-label";
  labelSpan.innerText = `${provider}:${base}`;   // every tab is provider-prefixed + self-describing (lanes are generic)
  const closeSpan = document.createElement("span");
  closeSpan.className = "tab-close";
  closeSpan.innerText = "×";
  closeSpan.title = "Kill this session";
  tabEl.appendChild(labelSpan);
  tabEl.appendChild(closeSpan);
  tabsEl.appendChild(tabEl);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 8000,
    theme: XTERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Canvas renderer: faster for TUIs and makes the terminal rasterizable
  // for the Screenshot button. Falls back to the DOM renderer on failure.
  try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (_) {}
  // Search (Ctrl+F over scrollback) + clickable URLs / absolute paths in output.
  let searchAddon = null;
  try { searchAddon = new SearchAddon.SearchAddon(); term.loadAddon(searchAddon); } catch (_) {}
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) {}

  const state = {
    id: desc.id, agent, provider, label: base, cwd: desc.cwd,
    term, fit, ws: null, hostEl: host, tabEl, stateDotEl: stateDot,
    status: "connecting", closed: false, retryTimer: null,
    lastOutputAt: 0, lastInputAt: 0, busySince: 0, working: false,
    search: searchAddon,
  };
  SESSIONS_UI[desc.id] = state;

  tabEl.addEventListener("click", (e) => {
    if (e.target === closeSpan) return;
    activateTab(agent, desc.id);
  });
  closeSpan.addEventListener("click", () => closeTab(agent, desc.id));

  term.onData((data) => {
    state.lastInputAt = Date.now();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  // Keyboard conveniences: copy/paste like the VS Code terminal, and
  // Shift+Enter as newline for the CLI prompt.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;

    // Shift+Enter -> backslash + CR: the documented line-continuation in
    // both Claude Code and Gemini CLI, so it inserts a newline instead of
    // submitting. Plain Enter still submits. (Meta-Enter \x1b\r was tried
    // first but Claude Code on Windows submits on it.)
    if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.lastInputAt = Date.now();
        state.ws.send(JSON.stringify({ type: "input", data: "\\\r" }));
      }
      return false;
    }
    // Ctrl+C WITH a selection = copy (no interrupt). Without a selection it
    // stays the terminal interrupt, as it must.
    if (ctrl && (ev.key === "c" || ev.key === "C") && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
        .then(() => showToast("Selection copied"));
      term.clearSelection();
      return false;
    }
    // Ctrl+V / Ctrl+Shift+V: return FALSE so xterm does NOT preventDefault the keydown. If it does,
    // the browser never fires its 'paste' event and Ctrl+V does nothing at all. The paste itself is
    // handled deterministically by the capture-phase 'paste' listener below (single source of truth).
    if (ctrl && (ev.key === "v" || ev.key === "V")) {
      return false;
    }
    // Ctrl+F = search this terminal's scrollback.
    if (ctrl && (ev.key === "f" || ev.key === "F")) {
      openTerminalSearch(state);
      return false;
    }
    return true;
  });

  // Deterministic paste (fixes: Ctrl+V did nothing; mouse/context-menu paste doubled). A REAL paste
  // both (a) fires xterm's own 'paste' handler AND (b) natively inserts into xterm's hidden textarea,
  // which fires an 'input' event that reaches the PTY a SECOND time -> the doubling. We intercept the
  // 'paste' in the CAPTURE phase on the host (before it reaches the textarea's listeners): cancel the
  // native insert (preventDefault), block xterm's own handler (stopImmediatePropagation), and do a
  // single bracketed-aware term.paste ourselves. Both Ctrl+V and mouse paste fire this one path.
  host.addEventListener("paste", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const cd = e.clipboardData || window.clipboardData;
    const text = cd ? cd.getData("text") : "";
    if (text) state.term.paste(text);
  }, true);
  term.onResize(({ cols, rows }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });

  new ResizeObserver(debounce(() => {
    if (host.offsetParent !== null) fit.fit();
  }, 100)).observe(host);

  // Sessions already running server-side attach immediately (their size is
  // set). FRESH sessions wait for first activation so fit() runs first and
  // the CLI spawns at the browser's true geometry - ink TUIs paint wrong-
  // width frames forever if booted at a default size.
  if (desc.alive) connectSession(state);
  return state;
}

function connectSession(state) {
  if (state.closed) return;
  const url = `ws://${location.hostname}:${CONFIG.wsPort}/pty` +
    `?id=${encodeURIComponent(state.id)}` +
    `&token=${encodeURIComponent(CONFIG.token || "")}` +
    `&cols=${state.term.cols}&rows=${state.term.rows}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    setSessionStatus(state, "live");
    ws.send(JSON.stringify({ type: "resize", cols: state.term.cols, rows: state.term.rows }));
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }
    switch (msg.type) {
      case "scrollback":
        state.term.reset();
        // write() is ASYNC: the .xterm-viewport scroll-area (and thus the custom
        // ::-webkit-scrollbar thumb) is only sized once the -- possibly huge --
        // scrollback finishes parsing. Force a fit + refresh in the write callback
        // so the grabbable thumb paints on first load.
        state.term.write(msg.data, () => {
          if (state.hostEl.offsetParent !== null) state.fit.fit();
          try { state.term.refresh(0, state.term.rows - 1); } catch (_) { /* disposed */ }
        });
        // Replayed TUI frames may predate this window's geometry; ask the
        // server to size-jiggle so the TUI repaints itself cleanly.
        ws.send(JSON.stringify({ type: "redraw" }));
        break;
      case "output":
        state.term.write(msg.data);
        noteActivity(state);
        break;
      case "restarted":
        state.term.reset();
        setSessionStatus(state, "live");
        showToast(`${state.agent} (${state.label}) restarted`);
        break;
      case "exit":
        setSessionStatus(state, "exited");
        state.term.write("\r\n[harness] process exited - press Restart to relaunch\r\n");
        break;
      case "killed":
        removeSessionTab(state, "session killed");
        break;
      case "gone":
        // Server no longer knows this session (e.g. server restarted).
        removeSessionTab(state, null);
        break;
    }
  };

  ws.onclose = () => {
    if (state.closed) return;
    setSessionStatus(state, "disconnected");
    state.retryTimer = setTimeout(() => connectSession(state), 3000);
  };
  ws.onerror = () => { /* onclose fires next */ };
}

function setSessionStatus(state, status) {
  state.status = status;
  state.tabEl.classList.toggle("dead", status === "exited" || status === "disconnected");
  if (ACTIVE_TAB[state.agent] === state.id) updateCardStatus(state.agent);
}

function updateCardStatus(agent) {
  const el = document.getElementById(`status-${agent}`);
  if (!el) return;
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  const colors = {
    live: "var(--accent-green)",
    exited: "var(--accent-gold)",
    disconnected: "var(--accent-red)",
    connecting: "var(--text-dim)",
  };
  el.style.backgroundColor = colors[state ? state.status : "connecting"] || "var(--text-dim)";
  el.title = `session: ${state ? state.status : "none"}`;

  renderLaneToolbar(agent);
}

function activateTab(agent, id) {
  ACTIVE_TAB[agent] = id;
  for (const state of Object.values(SESSIONS_UI)) {
    if (state.agent !== agent) continue;
    const on = state.id === id;
    state.tabEl.classList.toggle("active", on);
    state.hostEl.classList.toggle("active", on);
  }
  const state = SESSIONS_UI[id];
  if (state) {
    setTimeout(() => {
      state.fit.fit();
      state.term.focus();
      if (!state.ws && !state.closed) connectSession(state);
    }, 30);
  }
  updateCardStatus(agent);
  renderBroadcastTargets();
  pushFocusState();
}

function resumeSession(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast(`${agent}: no live session`, "error");
    return;
  }
  state.lastInputAt = Date.now();
  const provider = state.provider || agent;
  if (provider === "gemini" || provider === "agy") {
    if (CONFIG.geminiUsesAgy) {
      state.ws.send(JSON.stringify({ type: "input", data: "/resume\r" }));
    } else {
      state.ws.send(JSON.stringify({ type: "input", data: "/chat list\r" }));
      showToast("Gemini lists saved checkpoints - resume with /chat resume <tag>, save with /chat save <tag>");
    }
  } else {
    state.ws.send(JSON.stringify({ type: "input", data: "/resume\r" }));
  }
  state.term.focus();
}

async function closeTab(agent, id) {
  const state = SESSIONS_UI[id];
  if (!state) return;
  if (!confirm(`Kill ${agent} session "${state.label}"? The CLI process ends.`)) return;
  try {
    await apiFetch("/api/session/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (_) { /* fall through to local teardown */ }
  removeSessionTab(state, null);
}

async function removeSessionTab(state, toastMsg) {
  if (state.closed) return;
  state.closed = true;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (_) {} }
  try { state.term.dispose(); } catch (_) {}
  state.tabEl.remove();
  state.hostEl.remove();
  delete SESSIONS_UI[state.id];
  if (toastMsg) showToast(`${state.agent} (${state.label}): ${toastMsg}`);

  const agent = state.agent;
  const remaining = Object.values(SESSIONS_UI).filter((s) => s.agent === agent);
  if (remaining.length === 0) {
    const desc = await createSession(agent, CONFIG.defaultCwd, false);
    if (desc) { addSessionTab(agent, desc); activateTab(agent, desc.id); }
  } else if (ACTIVE_TAB[agent] === state.id) {
    activateTab(agent, remaining[remaining.length - 1].id);
  }
}

function restartTerminal(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "restart" }));
  } else {
    showToast(`${agent}: not connected`, "error");
  }
}

function fitAllTerminals() {
  for (const state of Object.values(SESSIONS_UI)) {
    if (state.hostEl.offsetParent !== null) state.fit.fit();
  }
}

// --- New-tab workspace picker ---------------------------------------------

async function showNewTabMenu(agent, anchor) {
  // Toggle: a second click on the same "+" (while its menu is open) closes it -- standard dropdown UX.
  const open = document.getElementById("tab-menu");
  const owner = "newtab:" + agent;
  dismissTabMenu();
  if (open && open.dataset.owner === owner) return;

  // Fetch the project list up front so PROJECT can LEAD the menu (a local call, ~instant); fall back
  // to the cached list. Bail if another menu opened while we awaited (avoids a double-menu race).
  let projects = PROJECTS;
  try {
    const res = await apiFetch("/api/projects");
    const data = await res.json();
    projects = data.projects || projects;
  } catch (_) { /* cached fallback */ }
  if (document.getElementById("tab-menu")) return;

  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.id = "tab-menu";
  menu.dataset.owner = owner;

  const mkTitle = (text) => {
    const t = document.createElement("div");
    t.className = "tab-menu-title";
    t.innerText = text;
    menu.appendChild(t);
  };
  const openTab = async (cwd, profile) => {
    dismissTabMenu();
    const desc = await createSession(agent, cwd, true, profile);
    if (desc) { addSessionTab(agent, desc); activateTab(agent, desc.id); }
  };

  const presets = CONFIG.agentPresets || [];
  const profiles = CONFIG.shellProfiles || [];

  // 1) PROJECT (top). Each project rows out a provider flyout on hover (or click, for touch); pick an
  //    agent to open that project running it (with that provider's current default model). The chosen
  //    provider decides the tab -- there is no lane-default guess.
  if (projects.length) {
    mkTitle("Project");
    for (const pj of projects) {
      const item = document.createElement("div");
      item.className = "tab-menu-item has-flyout";
      item.title = "Open " + (pj.name || pj.id) + " -- pick an agent";
      const label = document.createElement("span");
      label.innerText = pj.name || pj.id;
      item.appendChild(label);
      const caret = document.createElement("span");
      caret.className = "flyout-caret";
      caret.innerText = "▸";
      item.appendChild(caret);

      if (presets.length) {
        const sub = document.createElement("div");
        sub.className = "tab-submenu";
        for (const preset of presets) {
          const sItem = document.createElement("div");
          sItem.className = "tab-menu-item";
          sItem.innerText = preset.label;
          sItem.title = "Open " + (pj.name || pj.id) + " running " + preset.label;
          sItem.addEventListener("click", (e) => { e.stopPropagation(); openTab(pj.root, preset.id); });
          sub.appendChild(sItem);
        }
        item.appendChild(sub);
        const openFly = () => {
          sub.style.display = "block";
          const ir = item.getBoundingClientRect();   // flip left if the flyout would overflow the viewport
          if (ir.right + 190 > window.innerWidth) { sub.style.left = "auto"; sub.style.right = "100%"; }
          else { sub.style.right = "auto"; sub.style.left = "100%"; }
        };
        item.addEventListener("mouseenter", openFly);
        item.addEventListener("mouseleave", () => { sub.style.display = "none"; });
        item.addEventListener("click", (e) => {   // touch/click fallback: toggle the flyout
          if (e.target === item || e.target === label || e.target === caret) {
            e.stopPropagation();
            if (sub.style.display === "block") sub.style.display = "none"; else openFly();
          }
        });
      } else {
        item.addEventListener("click", () => openTab(pj.root, null));   // no presets: open in lane default
      }
      menu.appendChild(item);
    }
  }

  // 2) AGENT CLI (in default cwd) -- spawn any configured provider CLI in this lane.
  if (presets.length) {
    mkTitle("Agent CLI (in default cwd)");
    for (const preset of presets) {
      const item = document.createElement("div");
      item.className = "tab-menu-item";
      item.innerText = preset.label;
      item.title = `Open ${preset.label} in ${CONFIG.defaultCwd}`;
      item.addEventListener("click", () => openTab(CONFIG.defaultCwd, preset.id));
      menu.appendChild(item);
    }
  }

  // 3) SHELL (in default cwd) -- a real WSL bash / Git Bash / PowerShell without leaving the harness.
  if (profiles.length) {
    mkTitle("Shell (in default cwd)");
    for (const prof of profiles) {
      const item = document.createElement("div");
      item.className = "tab-menu-item";
      item.innerText = prof.label;
      item.title = `Open a ${prof.label} in ${CONFIG.defaultCwd}`;
      item.addEventListener("click", () => openTab(CONFIG.defaultCwd, prof.id));
      menu.appendChild(item);
    }
  }

  // 4) FOLDER (quick dirs + a custom path) -- opens in this lane's default provider.
  const roots = CONFIG.roots || [];
  if (roots.length) {
    mkTitle("Folder");
    for (const root of roots) {
      const item = document.createElement("div");
      item.className = "tab-menu-item";
      item.innerText = root.label;
      item.title = root.path;
      item.addEventListener("click", () => openTab(root.path, null));
      menu.appendChild(item);
    }
  }
  const custom = document.createElement("div");
  custom.className = "tab-menu-item custom";
  custom.innerText = "Custom path…";
  custom.addEventListener("click", async () => {
    dismissTabMenu();
    const path = prompt("Working directory for the new session:", CONFIG.defaultCwd);
    if (!path) return;
    const desc = await createSession(agent, path.trim());
    if (desc) { addSessionTab(agent, desc); activateTab(agent, desc.id); }
  });
  menu.appendChild(custom);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
  menu.style.top = `${r.bottom + 6}px`;

  setTimeout(() => {
    document.addEventListener("click", dismissTabMenuOnce, { once: true });
  }, 0);
}

// --- duo_inbox: cross-tab / cross-window messaging via localStorage --------------------------
// A browser-local instantiation of the duo_inbox idea: address a message to any TAB (its session
// id, which is global across every browser window via /api/sessions) and drop it in that tab's
// inbox key. localStorage's `storage` event notifies OTHER windows live; same-window sends refresh
// the badge directly. NEVER auto-injects -- Insert stages the text at the prompt and the human
// presses Enter (same review-then-submit rule as DUO broadcast + the Bridge). Identity is inherited
// from the live tabs (provider:base + id), never a hardcoded pair, so it works for any agent combo.
function inboxKey(id) { return "duo-inbox:" + id; }
function readInbox(id) {
  try { return JSON.parse(localStorage.getItem(inboxKey(id)) || "[]"); } catch (_) { return []; }
}
function writeInbox(id, msgs) { localStorage.setItem(inboxKey(id), JSON.stringify(msgs)); }

async function showSendMenu(agent, anchor) {
  const from = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!from) { showToast(`${agent}: no active tab to send from`, "error"); return; }
  dismissTabMenu();
  let sessions = [];
  try { sessions = ((await (await apiFetch("/api/sessions")).json()).sessions) || []; }
  catch (_) { showToast("Could not load the tab list", "error"); return; }
  if (document.getElementById("tab-menu")) return;
  const menu = document.createElement("div");
  menu.className = "tab-menu"; menu.id = "tab-menu";
  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = "Send message to…";
  menu.appendChild(title);
  const targets = sessions.filter((s) => s.id !== from.id);
  const fromLabel = `${from.provider || agent}:${from.label}`;
  if (!targets.length) {
    const none = document.createElement("div");
    none.className = "tab-menu-item"; none.innerText = "(no other tabs)";
    menu.appendChild(none);
  }
  for (const s of targets) {
    const base = (s.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || s.label || s.id;
    const to = `${s.profile || s.agent}:${base}`;
    const item = document.createElement("div");
    item.className = "tab-menu-item";
    item.innerText = to;
    item.title = "Send to " + s.id;
    item.addEventListener("click", () => {
      dismissTabMenu();
      const text = prompt(`Message to ${to}:`);
      if (!text) return;
      const msgs = readInbox(s.id);
      msgs.push({ from: from.id, fromLabel, text, ts: Date.now() });
      writeInbox(s.id, msgs);
      updateInboxBadges();   // storage event only fires in OTHER windows -- refresh this one directly
      showToast(`Sent to ${to}`);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 280)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener("click", dismissTabMenuOnce, { once: true }), 0);
}

function showInbox(agent, anchor) {
  const to = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!to) { showToast(`${agent}: no active tab`, "error"); return; }
  dismissTabMenu();
  const msgs = readInbox(to.id);
  const menu = document.createElement("div");
  menu.className = "tab-menu"; menu.id = "tab-menu";
  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = `Inbox -- ${to.provider || agent}:${to.label}`;
  menu.appendChild(title);
  if (!msgs.length) {
    const none = document.createElement("div");
    none.className = "tab-menu-item"; none.innerText = "(no messages)";
    menu.appendChild(none);
  } else {
    msgs.forEach((m) => {
      const when = new Date(m.ts);
      const hh = String(when.getHours()).padStart(2, "0");
      const mm = String(when.getMinutes()).padStart(2, "0");
      const preview = m.text.length > 56 ? m.text.slice(0, 56) + "…" : m.text;
      const item = document.createElement("div");
      item.className = "tab-menu-item";
      item.innerText = `${m.fromLabel} ${hh}:${mm}: ${preview}`;
      item.title = m.text + "\n\nClick to stage this text at the prompt (no Enter).";
      item.addEventListener("click", () => {
        dismissTabMenu();
        if (to.ws && to.ws.readyState === WebSocket.OPEN) {
          to.ws.send(JSON.stringify({ type: "input", data: m.text }));   // stage, no Enter
          to.term.focus();
        }
        writeInbox(to.id, readInbox(to.id).filter((x) => !(x.ts === m.ts && x.from === m.from && x.text === m.text)));
        updateInboxBadges();
        showToast("Message staged at the prompt -- Enter to send");
      });
      menu.appendChild(item);
    });
    const clear = document.createElement("div");
    clear.className = "tab-menu-item custom";
    clear.innerText = "Clear all";
    clear.addEventListener("click", () => { dismissTabMenu(); writeInbox(to.id, []); updateInboxBadges(); });
    menu.appendChild(clear);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener("click", dismissTabMenuOnce, { once: true }), 0);
}

function updateInboxBadge(agent) {
  const btn = document.getElementById(`inbox-btn-${agent}`);
  if (!btn) return;
  const to = SESSIONS_UI[ACTIVE_TAB[agent]];
  const n = to ? readInbox(to.id).length : 0;
  const countEl = document.getElementById(`inbox-count-${agent}`);
  if (countEl) countEl.innerText = n ? ` ${n}` : "";
  btn.classList.toggle("inbox-unread", n > 0);
}
function updateInboxBadges() {
  for (const a of (CONFIG.agents || ["claude", "gemini"])) updateInboxBadge(a);
}

function dismissTabMenuOnce(e) {
  const menu = document.getElementById("tab-menu");
  if (menu && !menu.contains(e.target)) menu.remove();
  else if (menu) document.addEventListener("click", dismissTabMenuOnce, { once: true });
}

function dismissTabMenu() {
  const menu = document.getElementById("tab-menu");
  if (menu) menu.remove();
  // Also drop any pending outside-click dismisser. Otherwise a dismisser armed by the PREVIOUS
  // open fires on the very click that opens the NEXT menu and removes the fresh menu -- the
  // "+ works once, then nothing" bug. Every open funnels through here, so this is the one place to clear it.
  document.removeEventListener("click", dismissTabMenuOnce);
}

// --- Per-card model selector -------------------------------------------------
// A quick-switch that stages `/model <alias>` at the terminal prompt (no auto-Enter, consistent
// with the harness's review-then-submit pattern) and highlights the model in use. The highlight
// reflects the last model chosen from here (the harness cannot read the CLI's internal state).

const MODELS = {
  claude: [
    { label: "Default (Opus 4.8)", alias: "default" },
    { label: "Opus 4.8 (1M)", alias: "opus" },
    { label: "Fable 5", alias: "fable" },
    { label: "Sonnet 5", alias: "sonnet" },
    { label: "Haiku 4.5", alias: "haiku" },
  ],
  gemini: [
    { label: "Gemini 3.6 Flash", alias: "gemini-3.6-flash" },
    { label: "Gemini 3.5 Flash", alias: "gemini-3.5-flash" },
    { label: "Gemini 3.1 Pro", alias: "gemini-3.1-pro" },
    { label: "Claude Sonnet 4.6 (Thinking)", alias: "claude-sonnet-4-6" },
    { label: "Claude Opus 4.6 (Thinking)", alias: "claude-opus-4-6" },
    { label: "GPT-OSS 120B (Medium)", alias: "gpt-oss-120b" },
  ],
};

// --- Provider identity + the per-tab toolbar (tab-primary layout, 2026-08-02) --------------
// A lane (card) is just a column; each TAB owns its provider (claude / gemini / codex / a shell).
// The toolbar under the tab strip reflects the ACTIVE tab's provider -- so a gemini tab opened in
// the claude lane shows gemini's identity + model list + resume, and Restart re-spawns it as gemini
// (the server already keys restart off the session's own profile). All DOM writes are guarded, so
// calling renderLaneToolbar for a lane with no card is a harmless no-op.
const EFFORT_PROVIDERS = new Set(["claude", "gemini", "agy"]);
const PROVIDER_NAMES = { claude: "Claude Code", gemini: "Gemini CLI", agy: "Gemini CLI", codex: "Codex CLI" };
const PROVIDER_ICONS = {
  claude: { letter: "C", cls: "claude-icon" },
  gemini: { letter: "G", cls: "gemini-icon" },
  agy:    { letter: "G", cls: "gemini-icon" },
  codex:  { letter: "X", cls: "local-icon" },
};

function isShellProfile(id) {
  const shells = (CONFIG.shellProfiles || []).map((p) => p.id);
  return (shells.length ? shells : ["bash", "gitbash", "pwsh"]).includes(id);
}

function activeProvider(agent) {
  const st = SESSIONS_UI[ACTIVE_TAB[agent]];
  return (st && st.provider) || agent;
}

function providerMeta(provider) {
  const shell = isShellProfile(provider);
  let name = PROVIDER_NAMES[provider];
  if (!name) {
    const preset = (CONFIG.agentPresets || []).find((p) => p.id === provider);
    const prof = (CONFIG.shellProfiles || []).find((p) => p.id === provider);
    name = (preset && preset.label) || (prof && prof.label) || provider;
  }
  const icon = PROVIDER_ICONS[provider]
    || { letter: shell ? ">" : (provider[0] || "?").toUpperCase(), cls: "local-icon" };
  return { name, letter: icon.letter, cls: icon.cls, isShell: shell };
}

function renderLaneToolbar(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  const provider = (state && state.provider) || agent;
  const meta = providerMeta(provider);

  const icon = document.getElementById(`agent-icon-${agent}`);
  if (icon) { icon.textContent = meta.letter; icon.className = `agent-icon ${meta.cls}`; }

  const nameEl = document.getElementById(`agent-name-text-${agent}`);
  if (nameEl) nameEl.textContent = meta.name;

  const sub = document.getElementById(`model-${agent}`);
  if (sub && state) { sub.textContent = `${meta.name} · cwd: ${state.label}`; sub.title = state.cwd; }

  const hasModels = !!MODELS[provider];
  const modelBtn = document.getElementById(`model-btn-${agent}`);
  if (modelBtn) { modelBtn.style.display = hasModels ? "" : "none"; if (hasModels) modelBtn.classList.add("set"); }
  const modelLabel = document.getElementById(`model-label-${agent}`);
  if (modelLabel && hasModels) modelLabel.textContent = currentModel(provider);

  const hasEffort = EFFORT_PROVIDERS.has(provider);
  const effortBtn = document.getElementById(`effort-btn-${agent}`);
  if (effortBtn) { effortBtn.style.display = hasEffort ? "" : "none"; if (hasEffort) effortBtn.classList.add("set"); }
  const effortLabel = document.getElementById(`effort-label-${agent}`);
  if (effortLabel && hasEffort) effortLabel.textContent = currentEffort(provider);

  const resumeBtn = document.getElementById(`resume-btn-${agent}`);
  if (resumeBtn) resumeBtn.style.display = meta.isShell ? "none" : "";

  updateInboxBadge(agent);   // the inbox is per-tab -- refresh the badge for the newly-active tab
}

function currentModel(agent) {
  return localStorage.getItem(`harness-model-${agent}`)
    || (MODELS[agent] && MODELS[agent][0].label) || "model";
}

function renderModelLabels() {
  for (const agent of (CONFIG.agents || ["claude", "gemini"])) renderLaneToolbar(agent);
}

function showModelMenu(agent, anchor) {
  const provider = activeProvider(agent);
  if (!MODELS[provider]) { showToast(`${providerMeta(provider).name}: no model switch`, "error"); return; }
  dismissTabMenu();
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.id = "tab-menu";
  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = `${providerMeta(provider).name} model`;
  menu.appendChild(title);
  const cur = currentModel(provider);
  for (const m of MODELS[provider] || []) {
    const item = document.createElement("div");
    const on = m.label === cur;
    item.className = "tab-menu-item" + (on ? " model-current" : "");
    item.innerText = (on ? "◆ " : "◇ ") + m.label;
    item.addEventListener("click", () => { dismissTabMenu(); selectModel(agent, provider, m); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener("click", dismissTabMenuOnce, { once: true }), 0);
}

function selectModel(agent, provider, m) {
  localStorage.setItem(`harness-model-${provider}`, m.label);
  renderLaneToolbar(agent);
  pushFocusState();
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "input", data: `/model ${m.alias}` }));   // no Enter -- operator confirms
    state.term.focus();
    showToast(`${provider} model -> ${m.label}: /model ${m.alias} staged - Enter to apply`);
  } else {
    showToast(`${provider} model set to ${m.label} (no live session to apply to)`, "error");
  }
}

// --- Reasoning effort lever (/effort) -----------------------------------
// Stages `/effort <level>` at the prompt (no auto-Enter, review-then-submit).
const EFFORTS = [
  { label: "Low", alias: "low" },
  { label: "Medium", alias: "medium" },
  { label: "High", alias: "high" },
  { label: "Extra", alias: "xhigh", note: "pushes hardest / more usage" },
  { label: "Max", alias: "max", note: "pushes hardest / more usage" },
];

function currentEffort(agent = "claude") {
  return localStorage.getItem(`harness-effort-${agent}`) || "High";
}

function renderEffortLabel(agent = "claude") {
  for (const a of (CONFIG.agents || ["claude", "gemini"])) renderLaneToolbar(a);
}

function showEffortMenu(agentOrAnchor, anchor) {
  let agent = "claude";
  let targetAnchor = anchor;
  if (typeof agentOrAnchor === "string") {
    agent = agentOrAnchor;
    targetAnchor = anchor;
  } else {
    targetAnchor = agentOrAnchor;
  }
  const provider = activeProvider(agent);
  if (!EFFORT_PROVIDERS.has(provider)) { showToast(`${providerMeta(provider).name}: no effort control`, "error"); return; }
  dismissTabMenu();
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.id = "tab-menu";
  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = `${providerMeta(provider).name} effort (/effort)`;
  menu.appendChild(title);
  const cur = currentEffort(provider);
  for (const e of EFFORTS) {
    const item = document.createElement("div");
    const on = e.label === cur;
    item.className = "tab-menu-item" + (on ? " model-current" : "");
    item.innerText = (on ? "◆ " : "◇ ") + e.label + (e.note ? `  (${e.note})` : "");
    item.addEventListener("click", () => { dismissTabMenu(); selectEffort(agent, provider, e); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = targetAnchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 280)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener("click", dismissTabMenuOnce, { once: true }), 0);
}

function selectEffort(agent, provider, e) {
  localStorage.setItem(`harness-effort-${provider}`, e.label);
  renderLaneToolbar(agent);
  pushFocusState();
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "input", data: `/effort ${e.alias}` }));   // no Enter -- operator confirms
    state.term.focus();
    showToast(`${provider} effort -> ${e.label}: /effort ${e.alias} staged - Enter to apply`);
  } else {
    showToast(`${provider} effort set to ${e.label} (no live ${provider} session to apply to)`, "error");
  }
}

// --- Explorer path picker -> insert into the active terminal ---------------

function showPathMenu(agent, anchor) {
  dismissTabMenu();
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.id = "tab-menu";

  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = "Insert into prompt…";
  menu.appendChild(title);

  const items = [
    ["Select file(s)…", "files"],
    ["Select folder…", "folder"],
  ];
  for (const [label, mode] of items) {
    const item = document.createElement("div");
    item.className = "tab-menu-item";
    item.innerText = label;
    item.addEventListener("click", () => {
      dismissTabMenu();
      pickPaths(agent, mode);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => {
    document.addEventListener("click", dismissTabMenuOnce, { once: true });
  }, 0);
}

async function pickPaths(agent, mode) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast(`${agent}: no live session to insert into`, "error");
    return;
  }
  showToast("Explorer dialog opened - check the taskbar if it is hidden");
  try {
    const res = await apiFetch("/api/pickpath", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, initial: state.cwd }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.paths || data.paths.length === 0) {
      showToast("Selection cancelled");
      return;
    }
    const text = data.paths
      .map((p) => (p.includes(" ") ? `"${p}"` : p))
      .join(" ") + " ";
    state.ws.send(JSON.stringify({ type: "input", data: text }));
    state.term.focus();
    showToast(`Inserted ${data.paths.length} path(s) into ${agent}`);
  } catch (err) {
    showToast(`Path picker failed: ${err.message}`, "error");
  }
}

// --- Terminal screenshot -> clipboard ---------------------------------------

function captureTerminalCanvas(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!state) return null;
  const screen = state.hostEl.querySelector(".xterm-screen");
  if (!screen) return null;
  const canvases = [...screen.querySelectorAll("canvas")]
    .filter((c) => c.width > 0 && c.height > 0);
  if (canvases.length === 0) return null;  // DOM renderer fallback: no canvases
  const out = document.createElement("canvas");
  out.width = canvases[0].width;
  out.height = canvases[0].height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#05070D";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const c of canvases) ctx.drawImage(c, 0, 0);
  return out;
}

function screenshotTerminal(agent) {
  const canvas = captureTerminalCanvas(agent);
  if (!canvas) {
    showToast("Screenshot unavailable (terminal not rendered to canvas)", "error");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fname = `${agent}-terminal-${stamp}.png`;
  canvas.toBlob(async (blob) => {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast(`Screenshot of ${agent} copied to clipboard - Ctrl+V to paste`);
    } catch (_) {
      // Clipboard image write unavailable: download instead.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showToast(`Clipboard blocked - downloaded ${fname} instead`);
    }
  }, "image/png");
}

// --- Terminal scrollback search (Ctrl+F) ------------------------------------

let SEARCH_BAR = null;
let SEARCH_STATE = null;
let SEARCH_RESULTS = null;

function openTerminalSearch(state) {
  if (!state.search) { showToast("Search unavailable for this terminal", "error"); return; }
  SEARCH_STATE = state;
  if (!SEARCH_BAR) {
    SEARCH_BAR = document.createElement("div");
    SEARCH_BAR.className = "term-search-bar";
    SEARCH_BAR.innerHTML =
      '<input type="text" class="term-search-input" placeholder="Find in terminal…">' +
      '<button class="btn-xs" data-act="prev" title="Previous (Shift+Enter)">↑</button>' +
      '<button class="btn-xs" data-act="next" title="Next (Enter)">↓</button>' +
      '<button class="btn-xs" data-act="archive" title="Search this session\'s full history, incl. lines scrolled out of the buffer (Alt+Enter)">&#8681; Hist</button>' +
      '<button class="btn-xs" data-act="close" title="Close (Esc)">✕</button>';
    document.body.appendChild(SEARCH_BAR);
    const input = SEARCH_BAR.querySelector(".term-search-input");
    input.addEventListener("input", () => runTermSearch("next", true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.altKey) { runArchiveSearch(); e.preventDefault(); }
      else if (e.key === "Enter") { runTermSearch(e.shiftKey ? "prev" : "next"); e.preventDefault(); }
      else if (e.key === "Escape") { closeTerminalSearch(); e.preventDefault(); }
    });
    SEARCH_BAR.querySelector('[data-act="prev"]').addEventListener("click", () => runTermSearch("prev"));
    SEARCH_BAR.querySelector('[data-act="next"]').addEventListener("click", () => runTermSearch("next"));
    SEARCH_BAR.querySelector('[data-act="archive"]').addEventListener("click", runArchiveSearch);
    SEARCH_BAR.querySelector('[data-act="close"]').addEventListener("click", closeTerminalSearch);
  }
  if (SEARCH_RESULTS) SEARCH_RESULTS.style.display = "none";   // drop stale history hits on reopen
  const body = state.hostEl.closest(".terminal-body") || state.hostEl;
  const r = body.getBoundingClientRect();
  SEARCH_BAR.style.top = `${Math.max(8, r.top + 8)}px`;
  SEARCH_BAR.style.left = `${Math.max(8, r.right - 360)}px`;
  SEARCH_BAR.style.display = "flex";
  const input = SEARCH_BAR.querySelector(".term-search-input");
  input.focus();
  input.select();
}

// Search the persistent per-session archive (history beyond the live buffer). Results are
// display-only (aged-out lines are not in xterm's buffer to scroll to) -- click a hit to copy it.
function ensureSearchResults() {
  if (SEARCH_RESULTS) return;
  SEARCH_RESULTS = document.createElement("div");
  SEARCH_RESULTS.className = "term-search-results";
  SEARCH_RESULTS.style.display = "none";
  document.body.appendChild(SEARCH_RESULTS);
}

function positionSearchResults() {
  if (!SEARCH_RESULTS || !SEARCH_BAR) return;
  const r = SEARCH_BAR.getBoundingClientRect();
  SEARCH_RESULTS.style.top = `${r.bottom + 4}px`;
  SEARCH_RESULTS.style.left = `${r.left}px`;
  SEARCH_RESULTS.style.width = `${Math.max(340, r.width)}px`;
}

function runArchiveSearch() {
  if (!SEARCH_STATE) return;
  const q = SEARCH_BAR.querySelector(".term-search-input").value;
  if (q.length < 2) { showToast("Type at least 2 characters to search history", "error"); return; }
  ensureSearchResults();
  positionSearchResults();
  SEARCH_RESULTS.style.display = "block";
  SEARCH_RESULTS.innerHTML = '<div class="log-line system" style="padding:8px;">Searching session history&hellip;</div>';
  apiFetch(`/api/scrollback/search?id=${encodeURIComponent(SEARCH_STATE.id)}&q=${encodeURIComponent(q)}`)
    .then((r) => r.json())
    .then((d) => {
      if (d.error) throw new Error(d.error);
      if (!d.matches || !d.matches.length) {
        SEARCH_RESULTS.innerHTML =
          `<div class="log-line system" style="padding:8px;">No history matches${d.note ? " (" + escapeHtml(d.note) + ")" : ""}.</div>`;
        return;
      }
      const shown = d.total > d.matches.length ? ` (showing ${d.matches.length})` : "";
      SEARCH_RESULTS.innerHTML =
        `<div class="term-search-results-head">${d.total} match(es) in ${d.lines} lines of history${shown}</div>`
        + d.matches.map((m) =>
          `<div class="term-search-hit" title="line ${m.n} - click to copy">`
          + `<span class="hit-n">${m.n}</span><span class="hit-text">${escapeHtml(m.text)}</span></div>`).join("");
      [...SEARCH_RESULTS.querySelectorAll(".term-search-hit")].forEach((el, i) => {
        el.addEventListener("click", () => copyToClipboard(d.matches[i].text, "History line copied"));
      });
    })
    .catch((err) => {
      SEARCH_RESULTS.innerHTML =
        `<div class="log-line error" style="padding:8px;">History search failed: ${escapeHtml(err.message)}</div>`;
    });
}

function runTermSearch(dir, incremental = false) {
  if (!SEARCH_STATE || !SEARCH_STATE.search) return;
  const q = SEARCH_BAR.querySelector(".term-search-input").value;
  if (!q) return;
  const opts = { incremental };
  try {
    if (dir === "prev") SEARCH_STATE.search.findPrevious(q, opts);
    else SEARCH_STATE.search.findNext(q, opts);
  } catch (_) { /* addon rejects some regex-special inputs; ignore */ }
}

function closeTerminalSearch() {
  if (SEARCH_BAR) SEARCH_BAR.style.display = "none";
  if (SEARCH_RESULTS) SEARCH_RESULTS.style.display = "none";
  if (SEARCH_STATE) {
    try { SEARCH_STATE.search.clearDecorations && SEARCH_STATE.search.clearDecorations(); } catch (_) {}
    SEARCH_STATE.term.focus();
  }
}

// --- Duo broadcast: one prompt to both CLIs ---------------------------------

function broadcastBusyTargets() {
  // Active tabs that are mid-task (pulsing) -- broadcasting into a running
  // process's stdin can interrupt or corrupt it.
  const busy = [];
  for (const agent of CONFIG.agents) {
    const s = SESSIONS_UI[ACTIVE_TAB[agent]];
    if (s && s.working) busy.push(`${agent}:${s.label}`);
  }
  return busy;
}

let BROADCAST_HISTORY = JSON.parse(localStorage.getItem("harness-broadcast-history") || "[]");
let BROADCAST_HIST_IDX = -1;

function handleBroadcastKeypress(event) {
  if (event.key === 'Enter') {
    sendBroadcast();
  }
}

function handleBroadcastKeydown(event) {
  const inputEl = document.getElementById("broadcast-input");
  if (!inputEl) return;

  if (event.key === "ArrowUp") {
    if (BROADCAST_HISTORY.length === 0) return;
    if (BROADCAST_HIST_IDX === -1) {
      BROADCAST_HIST_IDX = BROADCAST_HISTORY.length - 1;
    } else if (BROADCAST_HIST_IDX > 0) {
      BROADCAST_HIST_IDX--;
    }
    inputEl.value = BROADCAST_HISTORY[BROADCAST_HIST_IDX] || "";
    event.preventDefault();
  } else if (event.key === "ArrowDown") {
    if (BROADCAST_HIST_IDX !== -1) {
      if (BROADCAST_HIST_IDX < BROADCAST_HISTORY.length - 1) {
        BROADCAST_HIST_IDX++;
        inputEl.value = BROADCAST_HISTORY[BROADCAST_HIST_IDX];
      } else {
        BROADCAST_HIST_IDX = -1;
        inputEl.value = "";
      }
      event.preventDefault();
    }
  }
}

function applyBroadcastPreset(selectEl) {
  const val = selectEl.value;
  if (!val) return;
  const inputEl = document.getElementById("broadcast-input");
  if (inputEl) {
    inputEl.value = val;
    inputEl.focus();
  }
  selectEl.selectedIndex = 0;
}

function sendBroadcast() {
  const inputEl = document.getElementById("broadcast-input");
  const text = inputEl.value;
  if (!text.trim()) return;

  // Active-state interlock: refuse to blast stdin into a busy process unless
  // the operator explicitly forces it.
  const force = document.getElementById("broadcast-force");
  const busy = broadcastBusyTargets();
  if (busy.length && !(force && force.checked)) {
    showToast(`Broadcast blocked: ${busy.join(", ")} busy - could corrupt a running task. `
      + `Tick "force (unsafe)" to override.`, "error");
    return;
  }

  let sent = 0;
  for (const agent of CONFIG.agents) {
    const state = SESSIONS_UI[ACTIVE_TAB[agent]];
    if (state && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "input", data: text + "\r" }));
      sent++;
    }
  }

  if (text.trim()) {
    BROADCAST_HISTORY.push(text.trim());
    if (BROADCAST_HISTORY.length > 50) BROADCAST_HISTORY.shift();
    localStorage.setItem("harness-broadcast-history", JSON.stringify(BROADCAST_HISTORY));
    BROADCAST_HIST_IDX = -1;
  }

  inputEl.value = "";
  if (force) force.checked = false;   // one-shot: never leave the unsafe override armed
  showToast(`Prompt sent to ${sent}/${CONFIG.agents.length} CLIs`
    + (busy.length ? " (forced past busy interlock)" : ""),
    sent === 0 ? "error" : "info");
}

// Reflect the busy interlock in the bar: amber warning + disabled Send while a
// target is mid-task (unless force is armed). Called on every activity tick.
function updateBroadcastInterlock() {
  const inputEl = document.getElementById("broadcast-input");
  const btn = document.getElementById("broadcast-send");
  const force = document.getElementById("broadcast-force");
  if (!inputEl || !btn) return;
  const busy = broadcastBusyTargets();
  const forced = force && force.checked;
  const warn = busy.length > 0;
  inputEl.classList.toggle("busy-warn", warn && !forced);
  btn.disabled = warn && !forced;
  btn.title = warn
    ? (forced ? "Force armed - will broadcast into busy target(s)"
              : `Busy: ${busy.join(", ")} - broadcast interlocked`)
    : "Send one prompt to both active CLIs";
}

// --- Context bridge: move output between the two agents ------------------

function terminalLastLines(state, n) {
  const buf = state.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - n); i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n").replace(/\s+$/, "");
}

function grabToBridge(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!state) { showToast(`${agent}: no session`, "error"); return; }
  const sel = state.term.getSelection();
  const useSel = sel && sel.trim();
  const text = useSel ? sel : terminalLastLines(state, 40);
  const ta = document.getElementById("bridge-text");
  ta.value = text;
  document.getElementById("bridge-panel").style.display = "block";
  document.getElementById("bridge-toggle").innerText = "Hide buffer";
  showToast(`Grabbed ${useSel ? "selection" : "last 40 lines"} from ${agent}:${state.label}`);
}

function injectFromBridge(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  const text = document.getElementById("bridge-text").value;
  if (!text.trim()) { showToast("Bridge buffer is empty", "error"); return; }
  if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast(`${agent}: no live session to inject into`, "error");
    return;
  }
  // No trailing Enter: the operator reviews/edits at the prompt, then submits.
  state.ws.send(JSON.stringify({ type: "input", data: text }));
  state.term.focus();
  showToast(`Injected into ${agent}:${state.label} - review, then Enter`);
}

function toggleBridge() {
  const panel = document.getElementById("bridge-panel");
  const on = panel.style.display === "none";
  panel.style.display = on ? "block" : "none";
  document.getElementById("bridge-toggle").innerText = on ? "Hide buffer" : "Show buffer";
}

function clearBridge() {
  document.getElementById("bridge-text").value = "";
  showToast("Bridge buffer cleared");
}

function renderBroadcastTargets() {
  const el = document.getElementById("broadcast-targets");
  if (!el) return;
  el.innerText = "→ " + CONFIG.agents.map((a) => {
    const s = SESSIONS_UI[ACTIVE_TAB[a]];
    return s ? `${a}:${s.label}` : `${a}:-`;
  }).join("   ");
  updateBroadcastInterlock();   // active tab changed -> refresh the interlock
  updateCollisionMonitor();     // ...and the lane-collision monitor
}

// --- Collision monitor: warn when both agents share a working lane -------
// Uses the agents' actual active-tab cwds as their declared lanes + a filesystem
// "recently changed" signal (git-status + mtime) -- never terminal-output parsing.

function collisionLane(agent) {
  const s = SESSIONS_UI[ACTIVE_TAB[agent]];
  return s ? (s.cwd || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "") : null;
}

function lanesOverlap(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

async function updateCollisionMonitor() {
  const chip = document.getElementById("collision-chip");
  if (!chip) return;
  const cl = collisionLane("claude"), ge = collisionLane("gemini");
  if (!lanesOverlap(cl, ge)) { chip.style.display = "none"; return; }
  const shared = cl.length <= ge.length ? cl : ge;   // the outer (shared) lane
  const wsRoot = (CONFIG.defaultCwd || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  // Suppress lanes that ARE the workspace root or an ANCESTOR of it (e.g. the home root) -- too broad
  // to be a specific collision. Only a genuinely-narrow shared lane warrants a warning.
  if (shared === wsRoot || wsRoot.startsWith(shared + "/")) { chip.style.display = "none"; return; }
  let hot = [];
  if (shared.startsWith(wsRoot + "/")) {   // a shared subdir under the workspace -> hot-escalate on writes
    const rel = shared.slice(wsRoot.length + 1);
    try {
      const data = await (await apiFetch("/api/fsrecent")).json();
      hot = (data.recent || []).map((r) => r.path.toLowerCase())
        .filter((p) => p === rel || p.startsWith(rel + "/"));
    } catch (_) { /* ignore */ }
  }
  const laneName = shared.split("/").pop() || "lane";
  chip.style.display = "inline-flex";
  chip.className = "collision-chip " + (hot.length ? "hot" : "warn");
  chip.title = hot.length
    ? `Collision risk: both agents in ${laneName}/ and ${hot.length} file(s) changing now. State your lane + pause the other.`
    : `Both agents share the ${laneName}/ lane - watch for clobbering on concurrent edits.`;
  chip.innerHTML = hot.length
    ? `⚠ HOT: ${escapeHtml(laneName)}/ (${hot.length})`
    : `⚠ lane: ${escapeHtml(laneName)}/`;
}

function toggleBridgeSection() {
  const sec = document.getElementById("bridge-section");
  const btn = document.getElementById("bridge-open");
  const on = sec.style.display === "none";
  sec.style.display = on ? "block" : "none";
  if (btn) btn.classList.toggle("active", on);
}

function toggleDuoSection() {
  const sec = document.getElementById("duo-section");
  const btn = document.getElementById("duo-open");
  const on = sec.style.display === "none";
  sec.style.display = on ? "" : "none";     // "" reverts to the stylesheet's flex layout
  if (btn) btn.classList.toggle("active", on);
  if (on) { const i = document.getElementById("broadcast-input"); if (i) i.focus(); }
}

// --- Focus-state export: one-way ".harness_state.json" ----------------------
// Writes a small snapshot of what the operator is looking at (active view, each agent's active
// cwd/model, the explorer dir, the previewed artifact) so an agent can ALIGN to the human's focus.
// One-way and read-only from the agent's side: the harness writes; nothing is executed. Debounced
// so rapid tab/dir changes collapse to one POST.
const pushFocusState = debounce(_pushFocusState, 600);

async function _pushFocusState() {
  try {
    const agents = {};
    for (const a of CONFIG.agents) {
      const s = SESSIONS_UI[ACTIVE_TAB[a]];
      if (s) agents[a] = Object.assign(
        { cwd: s.cwd, label: s.label, model: currentModel(a) },
        a === "claude" ? { effort: currentEffort() } : {});
    }
    const activeTabEl = document.querySelector(".nav-tab.active");
    const drawer = document.getElementById("preview-drawer");
    await apiFetch("/api/harness/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        active_view: activeTabEl ? activeTabEl.getAttribute("data-tab") : "",
        explorer_dir: currentDirPath || "",
        preview: drawer && drawer.classList.contains("open")
          ? document.getElementById("preview-sub").innerText : "",
        active_project: ACTIVE_PROJECT,
        agents,
      }),
    });
  } catch (_) { /* focus export is best-effort; never disrupt the UI */ }
}

// (Voice dictation is intentionally omitted from the public release: it required a local WSL Whisper
//  backend that is not part of this generic cross-platform build. The mic buttons were removed with it.)

// --- Busy/idle state signaling + notifications -------------------------------

const IDLE_AFTER_MS = 8000;        // no output for this long -> idle
const NOTIFY_MIN_BUSY_MS = 30000;  // only notify for work streaks this long

function noteActivity(state) {
  state.lastOutputAt = Date.now();
  if (!state.working) {
    state.working = true;
    state.busySince = state.lastOutputAt;
    updateTabState(state);
  }
}

function activityTick() {
  const now = Date.now();
  for (const state of Object.values(SESSIONS_UI)) {
    if (state.working && now - state.lastOutputAt > IDLE_AFTER_MS) {
      state.working = false;
      updateTabState(state);
      const busyMs = state.lastOutputAt - state.busySince;
      // Skip if the user was typing near the end (interactive, not a task).
      const sinceInput = state.lastOutputAt - state.lastInputAt;
      if (busyMs >= NOTIFY_MIN_BUSY_MS && sinceInput > 15000) {
        notifyDone(state, busyMs);
      }
    }
  }
  updateBroadcastInterlock();   // periodic backstop for the busy interlock
  updateTokenHealthBadges();    // refresh the per-card context-fill estimate
}

function updateTabState(state) {
  if (state.stateDotEl) state.stateDotEl.classList.toggle("working", state.working);
  updateBroadcastInterlock();   // busy state changed -> refresh the interlock
}

function notifyDone(state, busyMs) {
  const dur = busyMs >= 60000
    ? `${Math.round(busyMs / 60000)}m` : `${Math.round(busyMs / 1000)}s`;
  const msg = `${state.agent} (${state.label}) went idle after ${dur} of work`;
  showToast(msg);
  if (notifyEnabled() && "Notification" in window
      && Notification.permission === "granted") {
    try { new Notification("Agent Harness", { body: msg, tag: state.id }); }
    catch (_) {}
  }
}

function notifyEnabled() {
  return localStorage.getItem("harness-notify") === "1";
}

async function toggleNotify() {
  if (notifyEnabled()) {
    localStorage.setItem("harness-notify", "0");
  } else {
    if ("Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") showToast("Browser notifications are blocked", "error");
    }
    localStorage.setItem("harness-notify", "1");
  }
  renderNotifyButton();
}

function renderNotifyButton() {
  const btn = document.getElementById("btn-notify");
  if (btn) {
    btn.innerText = notifyEnabled()
      ? "\u{1F514} Notify: on" : "\u{1F515} Notify: off";
  }
}

// --- Transcript export --------------------------------------------------------

function exportTranscript(agent) {
  const state = SESSIONS_UI[ACTIVE_TAB[agent]];
  if (!state) { showToast(`${agent}: no session`, "error"); return; }
  const buf = state.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  const text = lines.join("\n").replace(/\n+$/, "") + "\n";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // UTF-8 BOM so Notepad decodes box-drawing characters correctly.
  const blob = new Blob(["﻿", text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${agent}-${state.label}-${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showToast(`Transcript downloaded (${buf.length} lines)`);
}

// --- Named layouts -------------------------------------------------------------

async function showLayoutsMenu(anchor) {
  dismissTabMenu();
  let layouts = {};
  try {
    layouts = (await (await apiFetch("/api/layouts")).json()).layouts || {};
  } catch (_) {}

  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.id = "tab-menu";
  const title = document.createElement("div");
  title.className = "tab-menu-title";
  title.innerText = "Tab layouts";
  menu.appendChild(title);

  const names = Object.keys(layouts).sort();
  if (names.length === 0) {
    const none = document.createElement("div");
    none.className = "tab-menu-title";
    none.innerText = "(none saved yet)";
    menu.appendChild(none);
  }
  for (const name of names) {
    const item = document.createElement("div");
    item.className = "tab-menu-item layout-item";
    const label = document.createElement("span");
    label.innerText = `${name} (${layouts[name].length} tabs)`;
    label.style.flex = "1";
    label.title = layouts[name].map((t) => `${t.agent}: ${t.cwd}`).join("\n");
    label.addEventListener("click", () => {
      dismissTabMenu();
      openLayout(name, layouts[name]);
    });
    const del = document.createElement("span");
    del.className = "tab-close";
    del.innerText = "×";
    del.title = "Delete this layout";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await apiFetch("/api/layouts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      dismissTabMenu();
      showToast(`Deleted layout "${name}"`);
    });
    item.appendChild(label);
    item.appendChild(del);
    menu.appendChild(item);
  }

  const save = document.createElement("div");
  save.className = "tab-menu-item custom";
  save.innerText = "Save current tabs as…";
  save.addEventListener("click", async () => {
    dismissTabMenu();
    const name = prompt("Layout name:");
    if (!name) return;
    const tabs = Object.values(SESSIONS_UI).map((s) => ({ agent: s.agent, cwd: s.cwd }));
    try {
      const res = await apiFetch("/api/layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tabs }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(`Saved layout "${name}" (${tabs.length} tabs)`);
    } catch (err) {
      showToast(`Save failed: ${err.message}`, "error");
    }
  });
  menu.appendChild(save);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 280)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => {
    document.addEventListener("click", dismissTabMenuOnce, { once: true });
  }, 0);
}

async function openLayout(name, tabs) {
  let opened = 0;
  for (const t of tabs) {
    const exists = Object.values(SESSIONS_UI).some(
      (s) => s.agent === t.agent && s.cwd.toLowerCase() === t.cwd.toLowerCase());
    if (exists) continue;
    const desc = await createSession(t.agent, t.cwd, false);
    if (desc) { addSessionTab(t.agent, desc); activateTab(t.agent, desc.id); opened++; }
  }
  showToast(`Layout "${name}": opened ${opened} new tab(s)`);
}

// --- Repo status strip -------------------------------------------------------

async function refreshGenome() {
  const el = document.getElementById("genome-strip");
  if (!el) return;
  try {
    const g = await (await apiFetch("/api/genome")).json();
    if (g.error) throw new Error(g.error);
    // Label = the active workspace: g.workspace (authoritative, needs a server restart) or,
    // failing that, the basename of CONFIG.defaultCwd (already loaded -> works on refresh alone).
    const wsName = (CONFIG.defaultCwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
    el.innerText =
      `${g.workspace || wsName}: ${g.branch} · ${g.dirty} dirty · commit ${formatAgo(g.last_commit_epoch)}`;
    el.title = g.last_subject || "";
    el.style.color = g.dirty > 0 ? "var(--accent-gold)" : "var(--accent-green)";
  } catch (_) {
    el.innerText = "repo: unavailable";
    el.style.color = "var(--text-dim)";
  }
}

function formatAgo(epoch) {
  if (!epoch) return "?";
  const s = Math.max(0, Date.now() / 1000 - epoch);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Projects & live directory explorer
// ---------------------------------------------------------------------------

let PROJECTS = [];
let ACTIVE_PROJECT = "";

async function renderProjectSidebar() {
  const container = document.getElementById("project-list");
  container.innerHTML = "";
  try {
    const res = await apiFetch("/api/projects");
    const data = await res.json();
    PROJECTS = data.projects || [];
    ACTIVE_PROJECT = data.active || "";
  } catch (_) {
    PROJECTS = [];
  }
  for (const pj of PROJECTS) {
    const div = document.createElement("div");
    div.className = "project-item" + (pj.id === ACTIVE_PROJECT ? " active" : "");
    div.dataset.id = pj.id;
    div.innerHTML = `
      <div class="project-name">${escapeHtml(pj.name || pj.id)}</div>
      <div class="project-desc">${escapeHtml(pj.objective || pj.root)}</div>`;
    div.addEventListener("click", () => {
      document.querySelectorAll(".project-item").forEach((i) => i.classList.remove("active"));
      div.classList.add("active");
      renderProjectDashboard(pj.id);
    });
    container.appendChild(div);
  }
}

async function renderProjectDashboard(id) {
  const panel = document.getElementById("file-explorer-panel");
  panel.innerHTML = `<div class="log-line system" style="padding:12px;">Loading project...</div>`;
  let pj;
  try {
    const res = await apiFetch(`/api/project?id=${encodeURIComponent(id)}`);
    pj = await res.json();
    if (pj.error) throw new Error(pj.error);
  } catch (err) {
    panel.innerHTML = `<div class="log-line error" style="padding:12px;">Cannot load: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const team = (pj.team || []).map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join(" ");
  const links = (pj.links || []).map((l) =>
    `<div class="ccb-file" data-openfile="${escapeHtml(l.path)}"><span class="ccb-file-name">${escapeHtml(l.label || l.path)}</span></div>`).join("");
  const related = (pj.related || []).map((rid) =>
    `<span class="tag" style="cursor:pointer" data-loadproj="${escapeHtml(rid)}">${escapeHtml(rid)} &#8594;</span>`).join(" ");
  const recent = (pj.recent_activity || []).map((ln) =>
    `<div class="log-line" style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(ln)}</div>`).join("") || "<div class='log-line system'>-- no recent commits touching this project</div>";
  panel.innerHTML = `
    <div class="project-dashboard">
      <div class="pd-head">
        <div>
          <div class="onto-title">${escapeHtml(pj.name || pj.id)}</div>
          <div class="onto-desc">${escapeHtml(pj.objective || "")}</div>
        </div>
        <div class="pd-actions">
          <button class="btn-primary" data-loadproj="${escapeHtml(pj.id)}">&#9654; Load into console</button>
          <button class="btn-xs" data-loadproj="${escapeHtml(pj.id)}" data-resume="1" title="Spawn both consoles resuming each CLI's most recent conversation in this project (nothing to resume on a first load)">&#8635; Resume last session</button>
        </div>
      </div>
      <div class="pd-meta">
        <span class="tag tag-model">Phase: ${escapeHtml(pj.phase || "--")}</span>
        <span class="tag">Branch: ${escapeHtml(pj.branch_current || pj.branch || "--")}</span>
        <span class="tag" id="pd-git">git: --</span>
      </div>
      <div class="section-title">Team</div><div class="rule-tags">${team || "--"}</div>
      ${related ? `<div class="section-title">Related projects</div><div class="rule-tags">${related}</div>` : ""}
      ${links ? `<div class="section-title">Key files</div>${links}` : ""}
      <div class="section-title">Recent activity (this project)</div>${recent}
      <div class="section-title">Files</div>
      <div id="pd-file-tree" class="file-tree-container"></div>
    </div>`;
  // Wire actions via listeners (not inline handlers) so a manifest value can never break out of an
  // onclick JS string (XSS). Values ride as escaped data-* attributes and are read back as text.
  panel.querySelectorAll("[data-openfile]").forEach((el) =>
    el.addEventListener("click", () => openProjectFile(el.dataset.openfile)));
  panel.querySelectorAll("[data-loadproj]").forEach((el) =>
    el.addEventListener("click", () => loadProject(el.dataset.loadproj, el.dataset.resume === "1")));
  if (pj.root_abs) loadDirInto("pd-file-tree", pj.root_abs);
  // Repo-wide git status summary (labeled).
  try {
    const gs = await (await apiFetch("/api/git/status")).json();
    const el = document.getElementById("pd-git");
    if (el) el.textContent = `git (repo): ${(gs.staged || []).length} staged / ${(gs.modified || []).length} modified / ${(gs.untracked || []).length} untracked`;
  } catch (_) {}
}

// Open a project "key file" in the read-only preview drawer. The manifest link
// paths are repo-relative; openPreview() expects an {name, path} item with an
// ABSOLUTE path (jailed under HOME server-side), so resolve against the workspace
// root (CONFIG.defaultCwd) unless the path is already absolute.
function openProjectFile(relPath, title) {
  let p = String(relPath || "").trim();
  if (!p) return;
  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
  if (isAbs) {
    p = p.replace(/\//g, "\\");
  } else {
    const base = (CONFIG.defaultCwd || "").replace(/[\\/]+$/, "");
    p = base + "\\" + p.replace(/\//g, "\\");
  }
  const name = p.split(/[\\/]/).pop() || p;
  openPreview({ name, path: p }, title);
}

async function loadProject(id, resume = false) {
  const pj = PROJECTS.find((p) => p.id === id) || {};
  if (!pj.root_abs) {
    // fetch detail if the sidebar list did not include root_abs
    try { const r = await apiFetch(`/api/project?id=${encodeURIComponent(id)}`); const d = await r.json(); pj.root_abs = d.root_abs; } catch (_) {}
  }
  const root = pj.root_abs;
  if (!root) { showToast("project root not found", "error"); return; }
  const rootKey = root.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  let reused = 0;
  // For each agent, REUSE a live tab already rooted here (focus it) instead of
  // spawning a duplicate; spawn only when none exists. resume=true spawns the CLI
  // resuming its most recent conversation in this project dir (opt-in from the dashboard).
  for (const agent of CONFIG.agents) {
    const existing = Object.values(SESSIONS_UI).find(
      (s) => s.agent === agent &&
        (s.cwd || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "") === rootKey);
    if (existing) { activateTab(agent, existing.id); reused++; continue; }
    const desc = await createSession(agent, root, false, null, resume);
    if (desc) { addSessionTab(agent, desc); activateTab(agent, desc.id); }
  }
  ACTIVE_PROJECT = id;
  document.querySelectorAll(".project-item").forEach((i) =>
    i.classList.toggle("active", i.dataset.id === id));
  pushFocusState();                       // persists active_project
  // switch to the Dual CLI view
  const cliTab = document.querySelector('.nav-tab[data-tab="cli"]');
  if (cliTab) cliTab.click();
  const how = resume ? "Resumed" : "Loaded";
  const note = reused ? ` (${reused} live tab${reused > 1 ? "s" : ""} reused)` : "";
  showToast(`${how} ${pj.name || id} into the console${note}`);
}

// --- New Project scaffold ---------------------------------------------------
// Render the create form into the explorer panel (where the dashboard renders).
// Writes a project.md via POST /api/project/create, then loads the new project.
function showNewProjectForm() {
  document.querySelectorAll(".project-item").forEach((i) => i.classList.remove("active"));
  const panel = document.getElementById("file-explorer-panel");
  panel.innerHTML = `
    <div class="project-dashboard">
      <div class="pd-head"><div><div class="onto-title">New project</div>
        <div class="onto-desc">Scaffolds a <code>project.md</code> manifest and loads it into the console.</div></div></div>
      <div id="np-error" class="log-line error" style="display:none;"></div>
      <form id="np-form" class="np-form" onsubmit="return submitNewProject(event)">
        <label>ID <span class="np-hint">(slug: a-z 0-9 -)</span>
          <input id="np-id" autocomplete="off" spellcheck="false" placeholder="myproject" required></label>
        <label>Name
          <input id="np-name" autocomplete="off" placeholder="My Project" required></label>
        <label>Root <span class="np-hint">(repo-relative dir)</span>
          <input id="np-root" autocomplete="off" spellcheck="false" placeholder="projects/myproject" required></label>
        <label>Objective <span class="np-hint">(one line, optional)</span>
          <input id="np-objective" autocomplete="off" placeholder="What this project delivers."></label>
        <div class="np-row">
          <label>Branch <span class="np-hint">(optional)</span>
            <input id="np-branch" autocomplete="off" spellcheck="false" placeholder="main"></label>
          <label>Phase <span class="np-hint">(optional)</span>
            <input id="np-phase" autocomplete="off" placeholder="Design"></label>
        </div>
        <div class="np-actions">
          <button type="submit" class="btn-primary">Create &amp; load</button>
          <button type="button" class="btn-xs" onclick="renderProjectSidebar()">Cancel</button>
        </div>
      </form>
    </div>`;
  // Convenience: auto-fill root from id (projects/<id>) until the user edits root.
  const idEl = document.getElementById("np-id");
  const rootEl = document.getElementById("np-root");
  let rootTouched = false;
  rootEl.addEventListener("input", () => { rootTouched = true; });
  idEl.addEventListener("input", () => {
    const slug = idEl.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (idEl.value !== slug) idEl.value = slug;
    if (!rootTouched) rootEl.value = slug ? `projects/${slug}` : "";
  });
  idEl.focus();
}

async function submitNewProject(ev) {
  ev.preventDefault();
  const err = document.getElementById("np-error");
  err.style.display = "none";
  const body = {
    id: document.getElementById("np-id").value.trim(),
    name: document.getElementById("np-name").value.trim(),
    root: document.getElementById("np-root").value.trim(),
    objective: document.getElementById("np-objective").value.trim(),
    branch: document.getElementById("np-branch").value.trim(),
    phase: document.getElementById("np-phase").value.trim(),
  };
  try {
    const res = await apiFetch("/api/project/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const newId = (data.project && data.project.id) || body.id;
    showToast(`Created ${body.name}`);
    await renderProjectSidebar();     // refresh PROJECTS so loadProject() sees the new one
    await loadProject(newId);         // spawn both tabs rooted in it + show its dashboard
  } catch (e) {
    err.textContent = `Cannot create: ${e.message}`;
    err.style.display = "block";
  }
  return false;
}

async function loadDir(path) {
  const container = document.getElementById("file-tree-list");
  try {
    const res = await apiFetch(`/api/ls?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentDirPath = data.path;
    currentEntries = data.entries;
    document.getElementById("file-search-input").value = "";
    renderBreadcrumb(data.path);
    renderEntries(data.entries, data.parent, data.truncated);
    pushFocusState();
  } catch (err) {
    container.innerHTML =
      `<div class="log-line error" style="padding: 12px;">Cannot list: ${escapeHtml(err.message)}</div>`;
  }
}

// A variant of loadDir that renders a flat listing into a given element (the
// project dashboard's file tree). The /api/ls entry shape is {name, type, path,
// size} -- directories are type === "dir" (there is no is_dir field).
async function loadDirInto(elId, path) {
  const el = document.getElementById(elId);
  if (!el) return;
  try {
    const res = await apiFetch(`/api/ls?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    el.innerHTML = "";
    for (const item of (data.entries || [])) {
      const div = document.createElement("div");
      div.className = "tree-item";
      const icon = item.type === "dir" ? "&#128193;" : "&#128196;";
      div.innerHTML = `<span class="tree-label"><span class="tree-icon">${icon}</span>${escapeHtml(item.name)}</span>`;
      // Files open the read-only preview drawer (which carries the Git Diff button); folders
      // stay display-only here (no drill-down/back in the project dashboard tree).
      if (item.type !== "dir") {
        const label = div.querySelector(".tree-label");
        label.style.cursor = "pointer";
        label.addEventListener("click", () => openPreview(item));
      }
      el.appendChild(div);
    }
  } catch (err) {
    el.innerHTML = `<div class="log-line error">${escapeHtml(err.message)}</div>`;
  }
}

function renderBreadcrumb(path) {
  const bc = document.getElementById("explorer-breadcrumb");
  bc.innerHTML = "";
  const parts = path.split("\\").filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? `${acc}\\${part}` : part;
    const target = acc;
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.innerText = "\\";
      bc.appendChild(sep);
    }
    const seg = document.createElement("span");
    seg.className = "crumb" + (i === parts.length - 1 ? " current" : "");
    seg.innerText = part;
    seg.addEventListener("click", () => loadDir(target));
    bc.appendChild(seg);
  });
}

function renderEntries(entries, parent, truncated) {
  const container = document.getElementById("file-tree-list");
  container.innerHTML = "";

  if (parent) {
    const up = document.createElement("div");
    up.className = "tree-item";
    up.innerHTML = `<div class="tree-label"><span class="tree-icon">&#11168;</span><span>..</span></div>`;
    up.style.cursor = "pointer";
    up.addEventListener("click", () => loadDir(parent));
    container.appendChild(up);
  }

  for (const item of entries) {
    const div = document.createElement("div");
    div.className = "tree-item";
    const icon = item.type === "dir" ? "&#128193;" : "&#128196;";
    const meta = item.type === "dir" ? "" :
      `<span class="tree-meta">${formatSize(item.size)}</span>`;
    div.innerHTML = `
      <div class="tree-label">
        <span class="tree-icon">${icon}</span>
        <span class="tree-name">${escapeHtml(item.name)}</span>${meta}
      </div>
      <div class="copy-actions"></div>`;

    const label = div.querySelector(".tree-label");
    label.style.cursor = "pointer";
    if (item.type === "dir") {
      label.addEventListener("click", () => loadDir(item.path));
    } else {
      label.addEventListener("click", () => openPreview(item));
    }

    const actions = div.querySelector(".copy-actions");
    actions.appendChild(makeBtn("Copy Path", () => copyToClipboard(item.path)));
    actions.appendChild(makeBtn("Copy MD Link", () => {
      const md = `[${item.name}](file:///${item.path.replace(/\\/g, "/")})`;
      copyToClipboard(md, `Copied MD link for ${item.name}`);
    }));
    container.appendChild(div);
  }

  if (truncated) {
    const note = document.createElement("div");
    note.className = "log-line system";
    note.style.padding = "8px 12px";
    note.innerText = "[listing truncated at 800 entries]";
    container.appendChild(note);
  }
}

function filterFiles() {
  const q = document.getElementById("file-search-input").value.toLowerCase();
  const filtered = q
    ? currentEntries.filter((e) => e.name.toLowerCase().includes(q))
    : currentEntries;
  // Keep the ".." row by re-rendering with the same parent.
  const parent = currentDirPath && currentDirPath.split("\\").length > 2
    ? currentDirPath.substring(0, currentDirPath.lastIndexOf("\\"))
    : null;
  renderEntries(filtered, q ? null : parent, false);
}

function makeBtn(label, onClick) {
  const b = document.createElement("button");
  b.className = "btn-xs";
  b.innerText = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Read-only file / artifact / git-diff preview drawer --------------------

const PREVIEW_IMG = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const PREVIEW_PDF = /\.pdf$/i;
const PREVIEW_TEXT = /\.(md|markdown|txt|json|jsonl|ya?ml|js|mjs|py|css|html?|ttl|owl|rq|csv|tsv|log|xml|cff|sh|bat|ps1|ini|toml|cfg|c|cpp|h|rs|go|java)$/i;

function fileUrl(path) {   // token in the query so <img>/<iframe> src works
  return tokenUrl("/api/file?path=" + encodeURIComponent(path));
}

function isGenomePath(p) {
  // Under the ACTIVE workspace root (CONFIG.defaultCwd), so the Git Diff button works for
  // whichever workspace this instance serves -- not hardcoded to any one repo. Matches the
  // root-normalization idiom in updateCollisionMonitor().
  const root = (CONFIG.defaultCwd || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const q = (p || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return !!root && (q === root || q.startsWith(root + "/"));
}

function openPreview(item, title) {
  const drawer = document.getElementById("preview-drawer");
  const titleEl = document.getElementById("preview-title");
  const subEl = document.getElementById("preview-sub");
  const bodyEl = document.getElementById("preview-body");
  const actionsEl = document.getElementById("preview-actions");
  titleEl.innerText = title || item.name;   // optional display title; type-detection still uses item.name (the filename)
  subEl.innerText = item.path;
  actionsEl.innerHTML = "";
  bodyEl.innerHTML = '<div class="log-line system" style="padding:12px;">Loading&hellip;</div>';
  drawer.classList.add("open");
  pushFocusState();

  actionsEl.appendChild(makeBtn("Copy Path", () => copyToClipboard(item.path)));
  if (isGenomePath(item.path)) {
    actionsEl.appendChild(makeBtn("Git Diff", () => openDiff(item.path, item.name)));
  }

  if (PREVIEW_IMG.test(item.name)) {
    bodyEl.innerHTML = `<div class="preview-media"><img class="preview-img" alt="${escapeHtml(item.name)}" src="${escapeHtml(fileUrl(item.path))}"></div>`;
  } else if (PREVIEW_PDF.test(item.name)) {
    bodyEl.innerHTML = `<iframe class="preview-pdf" src="${escapeHtml(fileUrl(item.path))}"></iframe>`;
  } else if (PREVIEW_TEXT.test(item.name)) {
    loadTextPreview(item, bodyEl, subEl);
  } else {
    bodyEl.innerHTML = '<div class="log-line system" style="padding:12px;">No inline preview for this file type. Use Copy Path to open it in a terminal.</div>';
  }
}

async function loadTextPreview(item, bodyEl, subEl) {
  try {
    const data = await (await apiFetch("/api/read?path=" + encodeURIComponent(item.path))).json();
    if (data.error) throw new Error(data.error);
    if (data.binary) {
      bodyEl.innerHTML = `<div class="log-line system" style="padding:12px;">Binary file (${formatSize(data.size)}) - no text preview.</div>`;
      return;
    }
    subEl.innerText = `${item.path}  ·  ${formatSize(data.size)}${data.truncated ? " (truncated)" : ""}`;
    const pre = document.createElement("pre");
    pre.className = "preview-code";
    pre.innerText = data.content;   // innerText: no HTML injection from file content
    bodyEl.innerHTML = "";
    bodyEl.appendChild(pre);
  } catch (err) {
    bodyEl.innerHTML = `<div class="log-line error" style="padding:12px;">Cannot read: ${escapeHtml(err.message)}</div>`;
  }
}

async function openDiff(path, name) {
  openGitDiffModal(path, name);
}

// ---------------------------------------------------------------------------
// Side-by-Side Visual Git Diff Review Modal
// ---------------------------------------------------------------------------
let GIT_DIFF_STATE = { path: "", staged: false };

function toggleGitDiffStaged() {
  GIT_DIFF_STATE.staged = !GIT_DIFF_STATE.staged;
  const btn = document.getElementById("diff-toggle-staged");
  if (btn) {
    btn.innerText = GIT_DIFF_STATE.staged ? "Showing: Staged Changes" : "Showing: Unstaged Changes";
    btn.style.background = GIT_DIFF_STATE.staged ? "#16a34a" : "#0284c7";
  }
  refreshGitDiffModal();
}

function closeGitDiffModal() {
  const modal = document.getElementById("diff-modal-backdrop");
  if (modal) modal.style.display = "none";
}

async function openGitDiffModal(path, name) {
  GIT_DIFF_STATE.path = path || "";
  const modal = document.getElementById("diff-modal-backdrop");
  if (modal) modal.style.display = "flex";
  await refreshGitDiffModal();
}

async function refreshGitDiffModal() {
  const body = document.getElementById("diff-modal-body");
  if (!body) return;
  body.innerHTML = '<div style="color:#94a3b8; padding:12px;">Fetching git diff...</div>';

  try {
    let url = "/api/gitdiff";
    const params = [];
    if (GIT_DIFF_STATE.path) params.push("path=" + encodeURIComponent(GIT_DIFF_STATE.path));
    if (GIT_DIFF_STATE.staged) params.push("staged=1");
    if (params.length) url += "?" + params.join("&");

    const res = await apiFetch(url);
    const data = await res.json();

    if (data.error) throw new Error(data.error);
    if (data.empty) {
      body.innerHTML = `<div style="color:#64748b; padding:12px;">No ${GIT_DIFF_STATE.staged ? "staged" : "unstaged"} changes found.</div>`;
      return;
    }

    body.innerHTML = "";
    body.appendChild(renderSideBySideDiff(data.diff));
  } catch (err) {
    body.innerHTML = `<div style="color:#ef4444; padding:12px;">Diff Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSideBySideDiff(diffText) {
  const container = document.createElement("div");
  container.className = "sbs-diff-container";

  const files = diffText.split(/^diff --git /m).filter(Boolean);

  for (const fileText of files) {
    const lines = fileText.split("\n");
    const headerLine = lines[0] || "";
    const fileCard = document.createElement("div");
    fileCard.style.marginBottom = "16px";
    fileCard.style.border = "1px solid #334155";
    fileCard.style.borderRadius = "6px";
    fileCard.style.overflow = "hidden";

    const fileTitle = document.createElement("div");
    fileTitle.style.background = "#1e293b";
    fileTitle.style.padding = "6px 12px";
    fileTitle.style.color = "#38bdf8";
    fileTitle.style.fontWeight = "bold";
    fileTitle.innerText = "diff --git " + headerLine;
    fileCard.appendChild(fileTitle);

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontFamily = "var(--font-mono)";
    table.style.fontSize = "11px";

    let oldLine = 0, newLine = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLine = parseInt(match[1], 10);
          newLine = parseInt(match[2], 10);
        }
        const row = document.createElement("tr");
        row.style.background = "#0284c722";
        row.style.color = "#38bdf8";
        row.innerHTML = `<td colspan="4" style="padding:4px 8px; font-weight:bold;">${escapeHtml(line)}</td>`;
        table.appendChild(row);
        continue;
      }

      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
        continue;
      }

      const row = document.createElement("tr");

      if (line.startsWith("-")) {
        row.style.background = "rgba(239, 68, 68, 0.15)";
        row.innerHTML = `
          <td style="width:40px; color:#94a3b8; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;">${oldLine++}</td>
          <td style="width:50%; color:#fca5a5; padding:2px 8px; border-right:1px solid #334155; white-space:pre-wrap;">${escapeHtml(line)}</td>
          <td style="width:40px; color:#94a3b8; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;"></td>
          <td style="width:50%; padding:2px 8px; white-space:pre-wrap;"></td>
        `;
      } else if (line.startsWith("+")) {
        row.style.background = "rgba(34, 197, 94, 0.15)";
        row.innerHTML = `
          <td style="width:40px; color:#94a3b8; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;"></td>
          <td style="width:50%; padding:2px 8px; border-right:1px solid #334155; white-space:pre-wrap;"></td>
          <td style="width:40px; color:#94a3b8; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;">${newLine++}</td>
          <td style="width:50%; color:#86efac; padding:2px 8px; white-space:pre-wrap;">${escapeHtml(line)}</td>
        `;
      } else {
        row.innerHTML = `
          <td style="width:40px; color:#64748b; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;">${oldLine++}</td>
          <td style="width:50%; color:#cbd5e1; padding:2px 8px; border-right:1px solid #334155; white-space:pre-wrap;">${escapeHtml(line)}</td>
          <td style="width:40px; color:#64748b; text-align:right; padding:2px 6px; user-select:none; border-right:1px solid #334155;">${newLine++}</td>
          <td style="width:50%; color:#cbd5e1; padding:2px 8px; white-space:pre-wrap;">${escapeHtml(line)}</td>
        `;
      }
      table.appendChild(row);
    }
    fileCard.appendChild(table);
    container.appendChild(fileCard);
  }
  return container;
}

function closePreview() {
  document.getElementById("preview-drawer").classList.remove("open");
}

// ---------------------------------------------------------------------------
// Real-Time Token & Context Health estimate (per terminal card)
// ---------------------------------------------------------------------------
function updateTokenHealthBadges() {
  for (const agent of ["claude", "gemini"]) {
    const badge = document.getElementById(`token-badge-${agent}`);
    if (!badge) continue;

    let totalChars = 0;
    for (const key in SESSIONS_UI) {
      if (key.startsWith(agent)) {
        const state = SESSIONS_UI[key];
        if (state && state.xterm) {
          totalChars += (state.xterm.buffer?.active?.length || 0) * 80;
        }
      }
    }

    // Approx: 1 token ~= 4 chars, context limit ~200k
    const approxTokens = Math.round(totalChars / 4) + 12000;
    const fillPct = Math.min(Math.round((approxTokens / 200000) * 100), 99);
    const kTokens = (approxTokens / 1000).toFixed(1);

    badge.innerText = `Context: ~${fillPct}% (${kTokens}k)`;
    badge.style.color = fillPct > 80 ? "#f87171" : (fillPct > 50 ? "#fbbf24" : "#38bdf8");
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function copyToClipboard(text, toastMsg) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(toastMsg || `Copied: ${text}`);
  }).catch((err) => {
    showToast(`Copy failed: ${err}`, "error");
  });
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast";
  if (type === "error") toast.style.borderColor = "var(--accent-red)";
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
