// Local Models plugin panel -- chat with a local OpenAI-compatible server (Ollama / LM Studio).
// The two API calls go through the plugin route via Harness.api() (returns parsed JSON). Loaded once
// by the plugin loader, so these functions are global and the panel's ids resolve via getElementById.

let LM_LOADED = false;

function _lmAppend(log, cls, text) {
  const d = document.createElement("div");
  d.className = "lm-msg " + cls;
  d.textContent = text;   // textContent = XSS-safe; CSS white-space:pre-wrap preserves formatting
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

async function lmLoadModels() {
  const sel = document.getElementById("lm-model");
  const status = document.getElementById("lm-status");
  sel.innerHTML = "";
  try {
    const data = await Harness.api("/api/plugin/local-models/models");
    if (data && data.error) throw new Error(data.error);
    const list = (data && data.data) || [];
    if (!list.length) { sel.innerHTML = "<option>(no models loaded)</option>"; return; }
    for (const m of list) {
      const o = document.createElement("option");
      o.value = o.textContent = m.id;
      sel.appendChild(o);
    }
    if (status) status.textContent = list.length + " model(s)" + (data.base ? " @ " + data.base.replace(/^https?:\/\//, "") : "");
  } catch (err) {
    sel.innerHTML = "<option>(no local server)</option>";
    if (status) status.textContent = "start Ollama or LM Studio";
  }
}

async function lmSend(ev) {
  ev.preventDefault();
  const input = document.getElementById("lm-input");
  const log = document.getElementById("lm-log");
  const sel = document.getElementById("lm-model");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  _lmAppend(log, "lm-u", msg);
  const pending = _lmAppend(log, "lm-pending", "thinking…");   // replaced in place with the reply
  try {
    const res = await Harness.api("/api/plugin/local-models/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: sel.value, messages: [{ role: "user", content: msg }] }),
    });
    if (res.error) throw new Error(res.error);
    const txt = (res.choices && res.choices[0] && res.choices[0].message
      && res.choices[0].message.content) || "(no response)";
    pending.className = "lm-msg lm-a";
    pending.textContent = txt;
  } catch (err) {
    pending.className = "lm-msg lm-err";
    pending.textContent = "error: " + err.message;
  }
  log.scrollTop = log.scrollHeight;
}

Harness.registerPanel("local-models", {
  onActivate() {
    const form = document.getElementById("lm-form");
    if (form && !form._wired) { form.addEventListener("submit", lmSend); form._wired = true; }
    if (!LM_LOADED) { LM_LOADED = true; lmLoadModels(); }
  },
});
