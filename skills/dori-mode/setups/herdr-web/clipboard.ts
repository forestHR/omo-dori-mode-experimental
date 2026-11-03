// Copy and paste for herdr in ttyd's page. herdr copies a mouse selection (drag, double-click) with OSC 52 to the terminal
// it runs in, and ttyd 1.7.7's xterm.js has no OSC 52 handler, so nothing reached the browser's clipboard; Ctrl+V reached
// the terminal as ^V. This page code writes OSC 52 text to the clipboard, pastes on Ctrl+V, Ctrl+Shift+V and Cmd+V, and
// gives a phone, where a finger cannot drag a selection in herdr, two buttons: Copy shows the screen's text to select
// natively (and copies herdr's last selection or the whole screen), Paste reads the clipboard into the terminal.
// Clipboard reads (OSC 52 "?") are never answered: a program in a pane must not read the browser's clipboard.
const style = `<style>
#dori-clip{position:fixed;right:8px;bottom:8px;z-index:20;display:flex;gap:6px}
#dori-clip button,#dori-clip-panel button{font:14px system-ui;padding:6px 12px;border-radius:6px;border:1px solid #4a5468;
background:#1d2330;color:#eee;opacity:.9}
#dori-clip-toast{position:fixed;right:8px;bottom:52px;z-index:21;padding:6px 10px;border-radius:6px;background:#263b2c;
color:#e8ffe8;font:13px system-ui}
#dori-clip-panel{position:fixed;inset:10% 4% auto;max-height:80%;z-index:30;display:flex;flex-direction:column;gap:8px;
padding:10px;border-radius:8px;background:#151923;border:1px solid #4a5468}
#dori-clip-panel[hidden],#dori-clip-toast[hidden]{display:none}
#dori-clip-text{margin:0;overflow:auto;white-space:pre;user-select:text;-webkit-user-select:text;color:#eee;
font:12px/1.35 ui-monospace,monospace;background:#0e1118;padding:8px;border-radius:4px}
#dori-clip-panel .row{display:flex;flex-wrap:wrap;gap:6px}
</style>`;

const markup = `<div id="dori-clip"><button type="button" data-clip="copy">Copy</button><button type="button" data-clip="paste">Paste</button></div>
<div id="dori-clip-toast" role="status" hidden></div>
<div id="dori-clip-panel" role="dialog" aria-label="Copy text" hidden><div class="row">
<button type="button" data-clip="copy-last">Copy herdr selection</button><button type="button" data-clip="copy-screen">Copy whole screen</button>
<button type="button" data-clip="close">Close</button></div><pre id="dori-clip-text"></pre></div>`;

const script = `<script>
(() => {
  const state = { last: "" };
  window.__doriClip = state;
  const toastBox = document.getElementById("dori-clip-toast");
  const panel = document.getElementById("dori-clip-panel");
  const text = document.getElementById("dori-clip-text");
  let toastTimer;
  const toast = (message) => {
    toastBox.textContent = message;
    toastBox.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastBox.hidden = true; }, 2500);
  };
  const write = async (value) => {
    try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
  };
  const decode = (data) => {
    const b64 = data.slice(data.indexOf(";") + 1);
    if (b64 === "?" || !b64) return null;
    try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return null; }
  };
  const screenText = () => {
    const t = window.term, b = t.buffer.active, lines = [];
    for (let y = 0; y < t.rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\\n");
  };
  const paste = async () => {
    let value;
    try { value = await navigator.clipboard.readText(); } catch { value = prompt("Paste the text here"); }
    if (value) { window.term.paste(value); window.term.focus(); }
  };
  const actions = {
    copy: () => { text.textContent = screenText(); panel.hidden = false; },
    "copy-last": async () => toast(state.last ? (await write(state.last) ? "Copied" : "Copy failed") : "Nothing selected in herdr yet"),
    "copy-screen": async () => toast(await write(screenText()) ? "Copied" : "Copy failed"),
    close: () => { panel.hidden = true; window.term.focus(); },
    paste,
  };
  for (const button of document.querySelectorAll("[data-clip]")) {
    button.addEventListener("click", (event) => { event.preventDefault(); actions[button.dataset.clip](); });
  }
  const hook = () => {
    const t = window.term;
    if (!t?.parser) return setTimeout(hook, 200);
    t.parser.registerOscHandler(52, (data) => {
      const value = decode(data);
      if (value === null) return true;
      state.last = value;
      write(value).then((ok) => toast(ok ? "Copied" : "Selection ready: press Copy"));
      return true;
    });
    t.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.altKey || event.key.toLowerCase() !== "v" || !(event.ctrlKey || event.metaKey)) return true;
      event.preventDefault();
      paste();
      return false;
    });
  };
  hook();
})();
</script>`;

export const clipboardHead = style;
export const clipboardBody = `${markup}\n${script}`;
