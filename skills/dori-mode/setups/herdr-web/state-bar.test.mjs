import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectStateBar } from "./state-bar.ts";

test("keeps a crowded phone state bar scrollable without displacing the terminal", async () => {
  // Given: ttyd disables page overflow, and all 20 labels need two lines at phone width.
  const loader = process.env.OMOWRIGHT_LOADER ?? join(homedir(),
    ".bun/install/global/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs");
  const { loadOmowright } = await import(pathToFileURL(loader).href);
  const { omowright } = await loadOmowright();
  const profile = mkdtempSync(join(tmpdir(), "herdr-web-layout-"));
  const panes = Array.from({ length: 20 }, (_, i) => ({
    pane: `w1:p${i + 1}`,
    label: `Conversation ${String(i + 1).padStart(2, "0")} - a long task label for the active agent`,
    state: "working", focused: i === 0,
  }));
  const html = injectStateBar(`<!doctype html><html><head><style>
html,body{height:100%;margin:0;overflow:hidden}
#terminal-container{height:100%;background:#252b36;color:white}
</style></head><body><div id="terminal-container">Terminal input remains usable
<input aria-label="Terminal input"></div></body></html>`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/__dori/state" ? Response.json(panes)
        : new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  let browser;
  try {
    browser = await omowright.connectPipe({
      browserPath: process.env.HERDR_WEB_CHROMIUM ?? join(homedir(),
        ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell"),
      browserArgs: ["--headless", "--no-sandbox", "--disable-dev-shm-usage",
        "--no-first-run", `--user-data-dir=${profile}`],
      storageRoot: profile,
    });
    const page = await browser.newTab("about:blank");
    // When: render the real injected HTML and let its fetch and ResizeObserver finish.
    await page.goto(server.url.href, { waitUntil: "commit" });
    await omowright.emulate(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, hasTouch: true });
    await page.evaluate(() => new Promise((resolve, reject) => {
      const ready = () => {
        const bar = document.getElementById("dori-state");
        const reserved = parseFloat(document.documentElement.style.getPropertyValue("--dori-state-height"));
        return bar?.children.length === 20 && Math.abs(reserved - bar.getBoundingClientRect().height) < 1;
      };
      const observer = new MutationObserver(() => { if (ready()) finish(); });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Pane rendering did not complete"));
      }, 5000);
      function finish() {
        observer.disconnect();
        clearTimeout(timeout);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      if (ready()) finish();
    }));
    // Then: measure layout, not HTML strings, including actual reachability of the last pane.
    const layout = await page.evaluate(() => {
      const bar = document.getElementById("dori-state");
      const terminal = document.getElementById("terminal-container").getBoundingClientRect();
      const bounds = bar.getBoundingClientRect();
      const labels = Array.from(bar.querySelectorAll(".label"), label => ({
        height: label.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(label).lineHeight),
      }));
      bar.scrollTop = bar.scrollHeight;
      return {
        viewport: [innerWidth, innerHeight], barHeight: bounds.height, barBottom: bounds.bottom,
        clientHeight: bar.clientHeight, scrollHeight: bar.scrollHeight, scrollTop: bar.scrollTop,
        overflowY: getComputedStyle(bar).overflowY, terminalTop: terminal.top, terminalHeight: terminal.height,
        lastBottom: bar.lastElementChild.getBoundingClientRect().bottom, labels,
      };
    });
    expect(layout.viewport).toEqual([390, 844]);
    expect(layout.barHeight).toBeLessThanOrEqual(844 * 0.3 + 1);
    expect(layout.overflowY).toBe("auto");
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    expect(layout.scrollTop).toBeGreaterThan(0);
    expect(layout.lastBottom).toBeLessThanOrEqual(layout.barBottom + 1);
    expect(Math.abs(layout.terminalTop - layout.barBottom)).toBeLessThan(1);
    expect(layout.terminalHeight).toBeGreaterThanOrEqual(844 / 2);
    expect(layout.labels).toHaveLength(20);
    for (const label of layout.labels) expect(label.height).toBeCloseTo(label.lineHeight * 2, 0);
    if (process.env.HERDR_WEB_LAYOUT_SCREENSHOT) {
      await Bun.write(process.env.HERDR_WEB_LAYOUT_SCREENSHOT, await page.screenshot());
    }
  } finally {
    try { await browser?.close(); } finally {
      server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }
}, 15000);
