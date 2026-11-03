import { clipboardBody, clipboardHead } from "./clipboard.ts";

// ttyd owns #terminal-container. Reserve the bar's height before asking xterm to refit.
const head = `<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--dori-state-height:40px}
#dori-state{position:fixed;inset:0 0 auto;z-index:10;box-sizing:border-box;padding:7px 10px;
max-height:30vh;max-height:30dvh;overflow-y:auto;
display:flex;flex-wrap:wrap;gap:6px 14px;background:#151923;color:#eee;font:14px/1.5 system-ui}
#dori-state .pane{display:flex;align-items:baseline;gap:5px;max-width:100%;box-sizing:border-box}
#dori-state .label{overflow-wrap:anywhere;min-width:0}
#dori-state .state{white-space:nowrap}
#dori-state .dot{flex:none;width:8px;height:8px;border-radius:50%;background:#89919d}
#dori-state [data-state=working] .dot{background:#73df9a}
#dori-state [data-state=waiting] .dot{background:#f3c96a}
#dori-state [data-state=idle] .dot{background:#83baff}
#dori-state [aria-current=true]{outline:1px solid #b4c3df;outline-offset:2px;border-radius:2px}
#terminal-container{position:fixed!important;top:var(--dori-state-height)!important;bottom:0!important;
height:calc(100% - var(--dori-state-height))!important;width:100%!important}
</style>`;

const bar = `<nav id="dori-state" aria-label="Pane states">Loading pane states...</nav>
<script>
(() => {
  const bar = document.getElementById("dori-state");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--dori-state-height", bar.getBoundingClientRect().height + "px");
    window.dispatchEvent(new Event("resize"));
  }).observe(bar);
  async function update() {
    try {
      const response = await fetch("/__dori/state", {cache:"no-store", signal:AbortSignal.timeout(2500)});
      if (!response.ok) throw new Error("State unavailable");
      const panes = await response.json();
      bar.replaceChildren(...panes.map(pane => {
        const item = document.createElement("span");
        item.className = "pane";
        item.dataset.pane = pane.pane;
        item.dataset.state = pane.state;
        item.setAttribute("aria-current", String(pane.focused));
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = pane.label + ":";
        const state = document.createElement("span");
        state.className = "state";
        state.textContent = pane.state;
        item.append(dot, label, state);
        return item;
      }));
      if (!panes.length) bar.textContent = "No panes";
    } catch (error) {
      bar.textContent = "Pane states unavailable";
    }
  }
  update();
  setInterval(update, 3000);
})();
</script>`;

export const injectStateBar = (html: string): string =>
  html.replace("<head>", `<head>${head}${clipboardHead}`).replace("</body>", `${bar}${clipboardBody}</body>`);
