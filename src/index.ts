#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { Camoufox } from "camoufox-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import chalk from "chalk";
import { z } from "zod";

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

interface CamoufoxOptions {
  os?: string[];
  headless?: boolean | "virtual";
  humanize?: boolean;
  geoip?: boolean;
  ublock?: boolean;
  block_webgl?: boolean;
  block_images?: boolean;
  block_webrtc?: boolean;
  disable_coop?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  proxy?: string | ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: Record<string, unknown>;
  exclude_addons?: string[];
  window?: [number, number];
  args?: string[];
}

type BrowserInstance = Awaited<ReturnType<typeof Camoufox>>;
type PageInstance = Awaited<ReturnType<BrowserInstance["newPage"]>>;
type WaitStrategy = "domcontentloaded" | "load" | "networkidle";

interface SessionLaunchOptions {
  os?: "windows" | "macos" | "linux";
  humanize?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  block_webrtc?: boolean;
  proxy?: string | ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: Record<string, unknown>;
  exclude_addons?: string[];
  window?: [number, number];
  args?: string[];
  block_images?: boolean;
  block_webgl?: boolean;
  disable_coop?: boolean;
  geoip?: boolean;
  headless?: boolean | "virtual";
}

interface BrowserSession {
  id: string;
  browser: BrowserInstance;
  page: PageInstance;
  createdAt: string;
  lastUsedAt: string;
  options: SessionLaunchOptions;
}

interface InteractiveElement {
  tag: string;
  text: string;
  id: string;
  name: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  href: string;
  selectorHint: string;
}

const APP_NAME = "camoufox-mcp-server";
const APP_VERSION = "2.0.0";
const TRANSPORT_MODE = (process.env.TRANSPORT ?? (process.env.PORT ? "http" : "stdio")).toLowerCase();
const HTTP_PATH = process.env.MCP_HTTP_PATH || "/mcp";
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_WAIT: WaitStrategy = "domcontentloaded";
const DEFAULT_TIMEOUT = 60_000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 10);
const sessions = new Map<string, BrowserSession>();


function getDefaultProxy(): string | ProxyConfig | undefined {
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) {
    return proxyUrl;
  }

  const proxyServer = process.env.PROXY_SERVER;
  if (!proxyServer) {
    return undefined;
  }

  return {
    server: proxyServer,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

function resolveProxy(proxy?: string | ProxyConfig): string | ProxyConfig | undefined {
  return proxy ?? getDefaultProxy();
}

function nowIso(): string {
  return new Date().toISOString();
}

function updateLastUsed(session: BrowserSession): void {
  session.lastUsedAt = nowIso();
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanDelay(min = 50, max = 300): Promise<void> {
  await wait(min + Math.floor(Math.random() * (max - min)));
}

async function safeCloseSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  sessions.delete(sessionId);
  try {
    await session.page.close().catch(() => undefined);
    await session.browser.close();
    console.error(chalk.blue(`[Camoufox] Closed session ${sessionId}.`));
  } catch (error) {
    console.error(chalk.yellow(`[Camoufox] Error while closing session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`));
  }

  return true;
}

async function pruneExpiredSessions(): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const expired = [...sessions.values()]
    .filter((session) => new Date(session.lastUsedAt).getTime() < cutoff)
    .map((session) => session.id);

  for (const sessionId of expired) {
    await safeCloseSession(sessionId);
  }
}

function getSession(sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} was not found. Create a session first.`);
  }

  updateLastUsed(session);
  return session;
}

async function createSession(options: SessionLaunchOptions = {}): Promise<BrowserSession> {
  await pruneExpiredSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Session limit reached (${MAX_SESSIONS}). Close an existing session before creating another.`);
  }

  const osOptions = ["windows", "macos", "linux"] as const;
  const selectedOS = options.os || osOptions[Math.floor(Math.random() * osOptions.length)];
  const browser = await Camoufox({
    os: [selectedOS],
    headless: options.headless ?? "virtual",
    humanize: options.humanize ?? true,
    geoip: options.geoip ?? true,
    ublock: true,
    block_webgl: options.block_webgl ?? false,
    block_images: options.block_images ?? false,
    block_webrtc: options.block_webrtc ?? true,
    disable_coop: options.disable_coop ?? false,
    locale: options.locale,
    viewport: options.viewport ?? { width: 1920, height: 1080 },
    proxy: resolveProxy(options.proxy),
    enable_cache: options.enable_cache ?? true,
    firefox_user_prefs: options.firefox_user_prefs,
    exclude_addons: options.exclude_addons,
    window: options.window,
    args: options.args,
  } as CamoufoxOptions);

  const page = await browser.newPage();
  const session: BrowserSession = {
    id: randomUUID(),
    browser,
    page,
    createdAt: nowIso(),
    lastUsedAt: nowIso(),
    options: { ...options, os: selectedOS },
  };

  sessions.set(session.id, session);
  console.error(chalk.blue(`[Camoufox] Created session ${session.id} (${selectedOS}).`));
  return session;
}

async function ensureSelector(page: PageInstance, selector: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
  await page.waitForSelector(selector, { timeout, state: "visible" });
}

async function navigateSession(session: BrowserSession, url: string, waitStrategy: WaitStrategy, timeout: number): Promise<void> {
  await session.page.goto(url, { waitUntil: waitStrategy, timeout });
  updateLastUsed(session);
}

async function captureScreenshot(page: PageInstance, fullPage = true): Promise<string> {
  const screenshot = await page.screenshot({ type: "png", fullPage });
  return screenshot.toString("base64");
}

async function inspectInteractiveElements(page: PageInstance, limit = 30): Promise<InteractiveElement[]> {
  return await page.evaluate((max) => {
    const selectors = "a, button, input, textarea, select, [role='button'], [role='link']";
    const elements = Array.from(document.querySelectorAll(selectors))
      .filter((el) => {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0;
      })
      .slice(0, max)
      .map((el) => {
        const html = el as HTMLElement & { value?: string };
        const id = html.id || "";
        const name = html.getAttribute("name") || "";
        const text = (html.innerText || html.getAttribute("value") || html.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160);
        const type = html.getAttribute("type") || "";
        const placeholder = html.getAttribute("placeholder") || "";
        const ariaLabel = html.getAttribute("aria-label") || "";
        const href = html.getAttribute("href") || "";
        const selectorHint = id
          ? `#${id}`
          : name
            ? `${html.tagName.toLowerCase()}[name="${name}"]`
            : placeholder
              ? `${html.tagName.toLowerCase()}[placeholder="${placeholder}"]`
              : `${html.tagName.toLowerCase()}:text("${text.slice(0, 40)}")`;

        return {
          tag: html.tagName.toLowerCase(),
          text,
          id,
          name,
          type,
          placeholder,
          ariaLabel,
          href,
          selectorHint,
        };
      });

    return elements;
  }, limit);
}

async function getPageSnapshot(
  session: BrowserSession,
  options: {
    includeHtml?: boolean;
    includeScreenshot?: boolean;
    fullPageScreenshot?: boolean;
    interactiveLimit?: number;
    maxTextLength?: number;
  } = {},
): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
  const { includeHtml = true, includeScreenshot = false, fullPageScreenshot = true, interactiveLimit = 25, maxTextLength = 10000 } = options;
  const title = await session.page.title();
  const url = session.page.url();
  const bodyText = await session.page.evaluate((max) => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, max), maxTextLength);
  const interactive = await inspectInteractiveElements(session.page, interactiveLimit);
  const html = includeHtml ? await session.page.content() : undefined;

  const lines = [
    `URL: ${url}`,
    `Title: ${title}`,
    bodyText ? `Visible text: ${bodyText}` : "Visible text: ",
    `Interactive elements (${interactive.length}):`,
    ...interactive.map((item, index) => `${index + 1}. ${item.tag} | text="${item.text}" | selectorHint="${item.selectorHint}" | name="${item.name}" | type="${item.type}" | placeholder="${item.placeholder}" | href="${item.href}"`),
  ];

  if (html) {
    lines.push("", "HTML:", html);
  }

  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
    type: "text",
    text: lines.join("\n"),
  }];

  if (includeScreenshot) {
    content.push({
      type: "image",
      data: await captureScreenshot(session.page, fullPageScreenshot),
      mimeType: "image/png",
    });
  }

  return content;
}


function sessionLaunchSchema() {
  return {
    os: z.enum(["windows", "macos", "linux"]).optional().describe("Optional OS fingerprint to spoof for the session."),
    humanize: z.boolean().optional().default(true).describe("Enable realistic human-like behavior."),
    locale: z.string().optional().describe("Browser locale such as en-US."),
    viewport: z.object({
      width: z.number().min(320).max(3840),
      height: z.number().min(240).max(2160),
    }).optional().describe("Viewport dimensions."),
    block_webrtc: z.boolean().optional().default(true).describe("Block WebRTC for privacy."),
    proxy: z.union([
      z.string(),
      z.object({
        server: z.string(),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
    ]).optional().describe("Optional per-session proxy configuration. Falls back to env proxy when omitted."),
    enable_cache: z.boolean().optional().default(true).describe("Enable browser cache."),
    firefox_user_prefs: z.record(z.any()).optional().describe("Custom Firefox preferences."),
    exclude_addons: z.array(z.string()).optional().describe("Addons to exclude."),
    window: z.tuple([
      z.number().min(320).max(3840),
      z.number().min(240).max(2160),
    ]).optional().describe("Fixed browser window size."),
    args: z.array(z.string()).optional().describe("Additional browser arguments."),
    block_images: z.boolean().optional().default(false).describe("Block images."),
    block_webgl: z.boolean().optional().default(false).describe("Block WebGL."),
    disable_coop: z.boolean().optional().default(false).describe("Disable COOP."),
    geoip: z.boolean().optional().default(true).describe("Auto-detect location from IP."),
    headless: z.union([z.boolean(), z.literal("virtual")]).optional().default("virtual").describe("Headless mode: true=headless, false=headed (requires display), \"virtual\"=Xvfb virtual display (best anti-detection, default)."),
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: APP_VERSION,
  });

  server.tool(
    "create_session",
    {
      ...sessionLaunchSchema(),
      startUrl: z.string().optional().describe("Optional URL to open immediately after creating the session."),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      timeout: z.number().min(5000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true).describe("Capture a screenshot after session creation and initial navigation."),
    },
    async ({ startUrl, waitStrategy, timeout, screenshot, ...options }) => {
      const session = await createSession(options);

      try {
        if (startUrl) {
          await navigateSession(session, startUrl, waitStrategy, timeout);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Created session ${session.id}.`,
            },
            ...await getPageSnapshot(session, {
              includeHtml: true,
              includeScreenshot: screenshot,
            }),
          ],
        };
      } catch (error) {
        await safeCloseSession(session.id);
        throw error;
      }
    },
  );

  server.tool(
    "list_sessions",
    {},
    async () => {
      await pruneExpiredSessions();
      const text = sessions.size === 0
        ? "No active sessions."
        : [...sessions.values()]
          .map((session) => `${session.id} | url=${session.page.url()} | createdAt=${session.createdAt} | lastUsedAt=${session.lastUsedAt}`)
          .join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  server.tool(
    "close_session",
    {
      sessionId: z.string().describe("Session to close."),
    },
    async ({ sessionId }) => {
      const closed = await safeCloseSession(sessionId);
      return {
        content: [{
          type: "text" as const,
          text: closed ? `Closed session ${sessionId}.` : `Session ${sessionId} was already closed.`,
        }],
      };
    },
  );

  server.tool(
    "goto",
    {
      sessionId: z.string().describe("Existing session to use."),
      url: z.string().describe("URL to open."),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      timeout: z.number().min(5000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, url, waitStrategy, timeout, screenshot }) => {
      const session = getSession(sessionId);
      await navigateSession(session, url, waitStrategy, timeout);
      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "get_content",
    {
      sessionId: z.string().describe("Existing session to inspect."),
      screenshot: z.boolean().optional().default(false),
    },
    async ({ sessionId, screenshot }) => {
      const session = getSession(sessionId);
      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "inspect_page",
    {
      sessionId: z.string().describe("Existing session to inspect."),
      screenshot: z.boolean().optional().default(true),
      interactiveLimit: z.number().min(1).max(200).optional().default(50),
    },
    async ({ sessionId, screenshot, interactiveLimit }) => {
      const session = getSession(sessionId);
      return {
        content: await getPageSnapshot(session, {
          includeHtml: false,
          includeScreenshot: screenshot,
          interactiveLimit,
        }),
      };
    },
  );

  server.tool(
    "screenshot",
    {
      sessionId: z.string().describe("Existing session to capture."),
      fullPage: z.boolean().optional().default(true),
    },
    async ({ sessionId, fullPage }) => {
      const session = getSession(sessionId);
      return {
        content: [{
          type: "image" as const,
          data: await captureScreenshot(session.page, fullPage),
          mimeType: "image/png",
        }],
      };
    },
  );

  server.tool(
    "click",
    {
      sessionId: z.string().describe("Existing session to act on."),
      selector: z.string().describe("CSS selector to click."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      screenshot: z.boolean().optional().default(true),
      doubleClick: z.boolean().optional().default(false).describe("Double-click the element instead of single click."),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button to use."),
    },
    async ({ sessionId, selector, timeout, waitStrategy, screenshot, doubleClick, button }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await ensureSelector(session.page, selector, timeout);
      if (doubleClick) {
        await session.page.dblclick(selector, { button });
      } else {
        await session.page.click(selector, { button });
      }
      await wait(waitStrategy === "networkidle" ? 2_000 : 750);
      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "fill",
    {
      sessionId: z.string().describe("Existing session to act on."),
      selector: z.string().describe("CSS selector to fill."),
      value: z.string().describe("Text to fill into the field."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
      submit: z.boolean().optional().default(false).describe("Press Enter after filling."),
      humanize: z.boolean().optional().default(false).describe("Type character-by-character with random delays instead of setting the value directly."),
    },
    async ({ sessionId, selector, value, timeout, screenshot, submit, humanize }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await ensureSelector(session.page, selector, timeout);
      if (humanize) {
        await session.page.click(selector);
        await session.page.keyboard.press("Control+a");
        await session.page.keyboard.press("Delete");
        await session.page.type(selector, value, { delay: 80 + Math.floor(Math.random() * 50) });
      } else {
        await session.page.fill(selector, value);
      }
      if (submit) {
        await session.page.press(selector, "Enter");
        await wait(1_000);
      }

      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "press",
    {
      sessionId: z.string().describe("Existing session to act on."),
      key: z.string().describe("Keyboard key to press, e.g. Enter or Tab."),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, key, screenshot }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await session.page.keyboard.press(key);
      await wait(750);
      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "wait_for",
    {
      sessionId: z.string().describe("Existing session to wait on."),
      selector: z.string().optional().describe("Optional selector to wait for."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
      milliseconds: z.number().min(0).max(300000).optional().default(0).describe("Optional extra delay after the selector wait."),
    },
    async ({ sessionId, selector, timeout, screenshot, milliseconds }) => {
      const session = getSession(sessionId);
      if (selector) {
        await ensureSelector(session.page, selector, timeout);
      }

      if (milliseconds > 0) {
        await wait(milliseconds);
      }

      return {
        content: await getPageSnapshot(session, {
          includeHtml: true,
          includeScreenshot: screenshot,
        }),
      };
    },
  );

  server.tool(
    "type",
    {
      sessionId: z.string().describe("Existing session to act on."),
      selector: z.string().describe("CSS selector of the input to type into."),
      text: z.string().describe("Text to type character by character."),
      delay: z.number().min(0).max(500).optional().default(80).describe("Base delay in ms between keystrokes (random jitter added)."),
      clearFirst: z.boolean().optional().default(true).describe("Select all and delete existing content before typing."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, selector, text, delay, clearFirst, timeout, screenshot }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await ensureSelector(session.page, selector, timeout);
      await session.page.click(selector);
      if (clearFirst) {
        await session.page.keyboard.press("Control+a");
        await session.page.keyboard.press("Delete");
      }
      await session.page.type(selector, text, { delay: delay + Math.floor(Math.random() * 50) });
      return {
        content: await getPageSnapshot(session, { includeHtml: true, includeScreenshot: screenshot }),
      };
    },
  );

  server.tool(
    "select",
    {
      sessionId: z.string().describe("Existing session to act on."),
      selector: z.string().describe("CSS selector of the <select> element."),
      value: z.string().describe("Option value or visible label text to select."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, selector, value, timeout, screenshot }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await ensureSelector(session.page, selector, timeout);
      try {
        await session.page.selectOption(selector, value);
      } catch {
        await session.page.selectOption(selector, { label: value });
      }
      return {
        content: await getPageSnapshot(session, { includeHtml: true, includeScreenshot: screenshot }),
      };
    },
  );

  server.tool(
    "scroll",
    {
      sessionId: z.string().describe("Existing session to act on."),
      direction: z.enum(["up", "down"]).optional().default("down").describe("Scroll direction."),
      amount: z.number().min(1).max(10000).optional().default(500).describe("Pixels to scroll (ignored if selector is set)."),
      selector: z.string().optional().describe("If set, scroll this element into view instead of scrolling the page."),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, direction, amount, selector, screenshot }) => {
      const session = getSession(sessionId);
      if (selector) {
        await session.page.locator(selector).scrollIntoViewIfNeeded();
      } else {
        const delta = direction === "up" ? -amount : amount;
        await session.page.mouse.wheel(0, delta);
      }
      await wait(500);
      return {
        content: await getPageSnapshot(session, { includeHtml: true, includeScreenshot: screenshot }),
      };
    },
  );

  server.tool(
    "evaluate",
    {
      sessionId: z.string().describe("Existing session to act on."),
      script: z.string().describe("JavaScript expression to evaluate in the page context. The return value is serialized to JSON."),
      screenshot: z.boolean().optional().default(false),
    },
    async ({ sessionId, script, screenshot }) => {
      const session = getSession(sessionId);
      let result: unknown;
      try {
        result = await session.page.evaluate(script);
      } catch (error) {
        result = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const snapshot = screenshot ? await getPageSnapshot(session, { includeHtml: false, includeScreenshot: true }) : [];
      return {
        content: [{ type: "text" as const, text: `Result:\n${resultText}` }, ...snapshot],
      };
    },
  );

  server.tool(
    "hover",
    {
      sessionId: z.string().describe("Existing session to act on."),
      selector: z.string().describe("CSS selector of the element to hover over."),
      timeout: z.number().min(1000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, selector, timeout, screenshot }) => {
      const session = getSession(sessionId);
      await humanDelay();
      await ensureSelector(session.page, selector, timeout);
      await session.page.hover(selector);
      await wait(500);
      return {
        content: await getPageSnapshot(session, { includeHtml: true, includeScreenshot: screenshot }),
      };
    },
  );

  server.tool(
    "dismiss_popup",
    {
      sessionId: z.string().describe("Existing session to act on."),
      strategy: z.enum(["auto", "escape", "click_close"]).optional().default("auto").describe("Dismissal strategy: auto tries multiple methods, escape presses Escape, click_close tries common close button selectors."),
      selector: z.string().optional().describe("Specific close button selector to click (overrides strategy)."),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, strategy, selector, screenshot }) => {
      const session = getSession(sessionId);
      const steps: string[] = [];

      if (selector) {
        try {
          await ensureSelector(session.page, selector, 5000);
          await session.page.click(selector);
          steps.push(`Clicked custom selector: ${selector}`);
        } catch {
          steps.push(`Custom selector not found: ${selector}`);
        }
      } else {
        const closeSelectors = [
          "#onetrust-accept-btn-handler",
          "[aria-label*='close' i]",
          "[aria-label*='dismiss' i]",
          "[aria-label*='accept' i]",
          "button:has-text('Accept all')",
          "button:has-text('Accept cookies')",
          "button:has-text('Accept')",
          "button:has-text('Got it')",
          "button:has-text('OK')",
          "button:has-text('Close')",
          "button:has-text('Dismiss')",
          "button:has-text('No thanks')",
          ".modal-close",
          ".close-button",
          "[data-dismiss='modal']",
          "[data-testid*='close' i]",
        ];

        if (strategy === "escape" || strategy === "auto") {
          await session.page.keyboard.press("Escape");
          await wait(300);
          steps.push("Pressed Escape.");
        }

        if (strategy === "click_close" || strategy === "auto") {
          for (const sel of closeSelectors) {
            try {
              await session.page.waitForSelector(sel, { timeout: 1500, state: "visible" });
              await session.page.click(sel);
              steps.push(`Clicked close button: ${sel}`);
              await wait(500);
              break;
            } catch {
              continue;
            }
          }
        }
      }

      return {
        content: [
          { type: "text" as const, text: `Dismiss popup steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` },
          ...await getPageSnapshot(session, { includeHtml: false, includeScreenshot: screenshot }),
        ],
      };
    },
  );

  server.tool(
    "browser_task",
    {
      sessionId: z.string().optional().describe("Optional existing session. If omitted, a temporary session is created and closed after the task."),
      startUrl: z.string().optional().describe("Optional URL to navigate to before returning the snapshot."),
      task: z.string().describe("Description of the task (informational — used as a label in the response). Use individual tools like type, click, select, etc. to interact with the page."),
      timeout: z.number().min(5000).max(300000).optional().default(DEFAULT_TIMEOUT),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, startUrl, task, timeout, waitStrategy, screenshot }) => {
      const temporarySession = !sessionId;
      const session = sessionId ? getSession(sessionId) : await createSession();

      try {
        if (startUrl) {
          await navigateSession(session, startUrl, waitStrategy, timeout);
        }

        const snapshot = await getPageSnapshot(session, { includeHtml: true, includeScreenshot: screenshot });
        const header = { type: "text" as const, text: `Session ID: ${session.id}\nTask: ${task}` };

        return { content: [header, ...snapshot] };
      } finally {
        updateLastUsed(session);
        if (temporarySession) {
          await safeCloseSession(session.id);
        }
      }
    },
  );

  server.tool(
    "browse",
    {
      url: z.string().describe("Open a page in an ephemeral session and return the HTML snapshot."),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      timeout: z.number().min(5000).max(300000).optional().default(DEFAULT_TIMEOUT),
      screenshot: z.boolean().optional().default(false),
      ...sessionLaunchSchema(),
    },
    async ({ url, waitStrategy, timeout, screenshot, ...options }) => {
      const session = await createSession(options);

      try {
        await navigateSession(session, url, waitStrategy, timeout);
        return {
          content: await getPageSnapshot(session, {
            includeHtml: true,
            includeScreenshot: screenshot,
          }),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to browse URL ${url}. Error: ${errorMessage}`,
          }],
          isError: true,
        };
      } finally {
        await safeCloseSession(session.id);
      }
    },
  );

  return server;
}

function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.MCP_AUTH_TOKEN;
  if (!expectedToken) {
    next();
    return;
  }

  const authHeader = req.header("authorization");
  if (authHeader === `Bearer ${expectedToken}`) {
    next();
    return;
  }

  res.status(401).json({
    error: "Unauthorized",
    message: "Provide Authorization: Bearer <MCP_AUTH_TOKEN>.",
  });
}

async function runStdioServer(): Promise<void> {
  try {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(chalk.yellow("Camoufox MCP Server is running on stdio..."));
  } catch (error) {
    console.error(chalk.red("Fatal error during stdio server initialization:", error));
    process.exit(1);
  }
}

async function runHttpServer(): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/", async (_req, res) => {
    await pruneExpiredSessions();
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      transport: "streamable-http",
      mcpPath: HTTP_PATH,
      healthPath: "/health",
      auth: process.env.MCP_AUTH_TOKEN ? "bearer" : "disabled",
      defaultProxyConfigured: Boolean(getDefaultProxy()),
      activeSessions: sessions.size,
    });
  });

  app.get("/health", async (_req, res) => {
    await pruneExpiredSessions();
    res.json({
      ok: true,
      transport: "streamable-http",
      proxyConfigured: Boolean(getDefaultProxy()),
      activeSessions: sessions.size,
    });
  });

  app.post(HTTP_PATH, requireBearerToken, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let cleanedUp = false;

    const cleanup = async (): Promise<void> => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    res.on("finish", () => {
      void cleanup();
    });

    res.on("close", () => {
      void cleanup();
    });

    try {
      await pruneExpiredSessions();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(chalk.red("Error handling MCP request:"), error);
      await cleanup();

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.all(HTTP_PATH, requireBearerToken, (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      error: "Method Not Allowed",
      message: `Use POST ${HTTP_PATH} for MCP requests.`,
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.error(chalk.yellow(`Camoufox MCP Server is running on streamable HTTP at http://0.0.0.0:${PORT}${HTTP_PATH}`));
  });
}

setInterval(() => {
  void pruneExpiredSessions();
}, Math.max(30_000, Math.floor(SESSION_TTL_MS / 2))).unref();

process.on("SIGINT", () => {
  console.error(chalk.yellow("\n[Camoufox] Shutting down server..."));
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error(chalk.yellow("\n[Camoufox] Shutting down server..."));
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error(chalk.red("[Camoufox] Uncaught exception:", error));
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(chalk.red("[Camoufox] Unhandled rejection at:", promise, "reason:", reason));
  process.exit(1);
});

const runner = TRANSPORT_MODE === "http" || TRANSPORT_MODE === "streamable-http"
  ? runHttpServer
  : runStdioServer;

runner().catch((error) => {
  console.error(chalk.red("Fatal error running server:", error));
  process.exit(1);
});
