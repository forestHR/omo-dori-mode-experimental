import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectStateBar } from "./state-bar.ts";

test("herdr's OSC 52 copy reaches the clipboard, Ctrl+V and the Paste button paste, and Copy shows the screen", async () => {
  // Given: the real injected page with a stand-in for ttyd's xterm and the browser clipboard.
  const loader = process.env.OMOWRIGHT_LOADER ?? join(homedir(),
    ".bun/install/global/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs");
  const { loadOmowright } = await import(pathToFileURL(loader).href);
  const { omowright } = await loadOmowright();
  const profile = mkdtempSync(join(tmpdir(), "herdr-web-clipboard-"));
  const html = injectStateBar(`<!doctype html><html><head></head><body><div id="terminal-container"></div></body></html>`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/__dori/state" ? Response.json([])
        : new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  let browser;
  try {
    browser = await omowright.connectPipe({
      browserPath: process.env.HERDR_WEB_CHROMIUM ?? join(homedir(),
        ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell"),
      browserArgs: ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${profile}`],
      storageRoot: profile,
    });
    const page = await browser.newTab("about:blank");
    await page.goto(server.url.href, { waitUntil: "commit" });
    const got = await page.evaluate(async () => {
      const written = [], pasted = [];
      let osc, keys;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (v) => { written.push(v); }, readText: async () => "echo 붙여넣기 ok",
      } });
      const screen = ["one", "copy me 한글", ""];
      window.term = {
        rows: screen.length, focus() {}, paste(v) { pasted.push(v); },
        buffer: { active: { viewportY: 0, getLine: (y) => ({ translateToString: () => screen[y] }) } },
        parser: { registerOscHandler: (code, fn) => { if (code === 52) osc = fn; } },
        attachCustomKeyEventHandler: (fn) => { keys = fn; },
      };
      await new Promise((resolve) => { const wait = () => (osc && keys ? resolve() : setTimeout(wait, 50)); wait(); });
      const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
      // When: herdr copies a selection, a program asks to read the clipboard, Ctrl+V and plain v are pressed.
      const handled = [osc("c;" + b64("선택한 글 copied")), osc("c;?")];
      await new Promise((r) => setTimeout(r, 50));
      const ctrlV = keys(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
      const plainV = keys(new KeyboardEvent("keydown", { key: "v" }));
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector("[data-clip=paste]").click();
      document.querySelector("[data-clip=copy]").click();
      const panelText = document.getElementById("dori-clip-text").textContent;
      document.querySelector("[data-clip=copy-screen]").click();
      await new Promise((r) => setTimeout(r, 50));
      return { handled, ctrlV, plainV, written, pasted, panelText, panelOpen: !document.getElementById("dori-clip-panel").hidden };
    });
    // Then: the decoded UTF-8 selection is written, the read request is swallowed, both pastes arrive, Copy shows the screen.
    expect(got.handled).toEqual([true, true]);
    expect(got.written).toEqual(["선택한 글 copied", "one\ncopy me 한글"]);
    expect(got.ctrlV).toBe(false);
    expect(got.plainV).toBe(true);
    expect(got.pasted).toEqual(["echo 붙여넣기 ok", "echo 붙여넣기 ok"]);
    expect(got.panelOpen).toBe(true);
    expect(got.panelText).toBe("one\ncopy me 한글");
  } finally {
    try { await browser?.close(); } finally {
      server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }
}, 15000);
