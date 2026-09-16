"use strict";

/* =========================================================================
   A small Chrome DevTools Protocol driver: launch headless Chrome once, open
   a fresh tab per test, run expressions in it, collect what the console said.

   Two things here are not optional on this machine.

   1. The viewport MUST come from Emulation.setDeviceMetricsOverride.
      `--window-size` is interpreted in physical pixels and then divided by
      the display's scaling factor, so asking for 390 gets you something else
      entirely and every layout assertion becomes fiction. The override sets
      CSS pixels directly and is independent of the host display.

   2. The debugging port is discovered from DevToolsActivePort rather than
      chosen. A fixed port races with any other Chrome the machine is running
      and with a previous test run that has not finished exiting.

   Nothing here is a general-purpose browser library - it is the four
   commands these tests need.
   ========================================================================= */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * SQUAREINCH_CHROME overrides the search entirely - both so a machine with
 * Chrome somewhere unusual can point at it, and so the "no Chrome, skip the
 * suite" path can be exercised by pointing it at nothing.
 */
function findChrome() {
  if (process.env.SQUAREINCH_CHROME) {
    return isFile(process.env.SQUAREINCH_CHROME) ? process.env.SQUAREINCH_CHROME : null;
  }
  return CHROME_CANDIDATES.find(isFile) || null;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ browser */
class Browser {
  constructor(proc, ws, profileDir) {
    this.proc = proc;
    this.ws = ws;
    this.profileDir = profileDir;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();        // sessionId -> Page

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || "")})`));
        else resolve(msg.result);
        return;
      }
      const page = msg.sessionId && this.sessions.get(msg.sessionId);
      if (page) page._event(msg);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000).unref();
    });
  }

  static async launch({ headless = true } = {}) {
    const bin = findChrome();
    if (!bin) throw new Error("no Chrome binary found");

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "si-cdp-"));
    const args = [
      headless ? "--headless=new" : "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,OptimizationHints",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];
    const proc = spawn(bin, args, { stdio: "ignore", windowsHide: true });

    /* Chrome writes the port it actually took into the profile directory. */
    const portFile = path.join(profileDir, "DevToolsActivePort");
    let endpoint = null;
    for (let i = 0; i < 120 && !endpoint; i++) {
      await wait(150);
      try {
        const [port, route] = fs.readFileSync(portFile, "utf8").split("\n");
        if (port && route) endpoint = `ws://127.0.0.1:${port.trim()}${route.trim()}`;
      } catch { /* not written yet */ }
    }
    if (!endpoint) { proc.kill(); throw new Error("Chrome never published a debugging port"); }

    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("could not connect to Chrome"));
    });

    return new Browser(proc, ws, profileDir);
  }

  async newPage({ width = 1280, height = 900 } = {}) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    this.sessions.set(sessionId, page);

    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    await page.setViewport(width, height);
    return page;
  }

  async close() {
    try { this.ws.close(); } catch { /* already gone */ }
    try { this.proc.kill(); } catch { /* already gone */ }
    await wait(150);
    try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch { /* windows holds it briefly */ }
  }
}

/* --------------------------------------------------------------------- page */
class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = [];        // { level, text }
    this.failedRequests = [];
    this._loaded = false;
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }

  _event(msg) {
    const p = msg.params || {};
    switch (msg.method) {
      case "Runtime.consoleAPICalled":
        this.console.push({
          level: p.type,
          text: (p.args || []).map(a =>
            a.value !== undefined ? String(a.value)
              : a.description !== undefined ? a.description
                : JSON.stringify(a.preview || a.unserializableValue || "")).join(" "),
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails || {};
        this.console.push({
          level: "uncaught",
          text: (d.exception && (d.exception.description || d.exception.value)) || d.text || "uncaught exception",
        });
        break;
      }
      case "Log.entryAdded":
        this.console.push({ level: p.entry.level, text: p.entry.text, source: p.entry.source });
        break;
      case "Network.loadingFailed":
        this.failedRequests.push(p);
        break;
      case "Page.loadEventFired":
        this._loaded = true;
        break;
      case "Page.javascriptDialogOpening":
        /* Nothing in these tests should raise one; if something does, answer
           it rather than letting the page hang forever. */
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        break;
      default:
    }
  }

  /** Wipe an origin's localStorage without having to load a page first. */
  clearStorage(origin) {
    return this.send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage" });
  }

  setViewport(width, height) {
    return this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 700,
    });
  }

  /** Navigate and wait for the app to have booted, not merely for `load`. */
  async goto(url, { ready = "true", timeout = 20_000 } = {}) {
    this._loaded = false;
    this.console.length = 0;
    this.failedRequests.length = 0;
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete"`, timeout);
    if (ready !== "true") await this.waitFor(ready, timeout);
  }

  /**
   * Run source in the page and return its value.
   *
   * The source is always wrapped as an async function BODY, so it may be
   * several statements and may await. A single expression with no `return`
   * anywhere in it gets one added, which is the only bit of guesswork - and
   * it is why every multi-statement probe below ends in an explicit return.
   */
  async evaluate(source) {
    const body = /\breturn\b/.test(source) ? source : `return (${source});`;
    const r = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("page threw: " +
        ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result.value;
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, timeout = 10_000, label = expression) {
    const deadline = Date.now() + timeout;
    let last = null;
    for (;;) {
      try {
        const v = await this.evaluate(expression);
        if (v) return v;
        last = v;
      } catch (err) { last = err.message; }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for: ${label}\n  last value: ${JSON.stringify(last)}\n` +
          `  console: ${this.consoleText() || "(silent)"}`);
      }
      await wait(100);
    }
  }

  /** Console errors that are the page's own fault, not the network's. */
  errors({ ignore = [] } = {}) {
    return this.console
      .filter(e => ["error", "uncaught"].includes(e.level))
      /* A blocked font or an offline CDN is the environment, not the code.
         Everything else counts. */
      .filter(e => e.source !== "network")
      .filter(e => !/net::ERR_|Failed to load resource|fonts\.(googleapis|gstatic)/i.test(e.text))
      .filter(e => !ignore.some(re => re.test(e.text)));
  }

  consoleText() {
    return this.console.map(e => `[${e.level}] ${e.text}`).join("\n");
  }

  async screenshot(file) {
    const s = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(s.data, "base64"));
    return file;
  }

  async close() {
    this.browser.sessions.delete(this.sessionId);
    try { await this.browser.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* gone */ }
  }
}

module.exports = { Browser, Page, findChrome };
