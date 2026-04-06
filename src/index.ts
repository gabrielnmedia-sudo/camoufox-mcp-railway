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
  headless?: boolean;
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

const searchInputSelectors = [
  "input[type='search']",
  "input[name*='search' i]",
  "input[id*='search' i]",
  "input[placeholder*='search' i]",
  "input[placeholder*='name' i]",
  "input[name*='name' i]",
  "input[id*='name' i]",
];

const searchButtonSelectors = [
  "button[type='submit']",
  "input[type='submit']",
  "button[aria-label*='search' i]",
  "button:has-text('Search')",
];

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
    headless: options.headless ?? true,
    humanize: options.humanize ?? true,
    geoip: options.geoip ?? true,
    ublock: true,
    block_webgl: options.block_webgl ?? false,
    block_images: options.block_images ?? false,
    block_webrtc: options.block_webrtc ?? true,
    disable_coop: options.disable_coop ?? false,
    locale: options.locale,
    viewport: options.viewport,
    proxy: resolveProxy(options.proxy),
    enable_cache: options.enable_cache ?? false,
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
  } = {},
): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
  const { includeHtml = true, includeScreenshot = false, fullPageScreenshot = true, interactiveLimit = 25 } = options;
  const title = await session.page.title();
  const url = session.page.url();
  const bodyText = await session.page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000));
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

function extractUrl(task: string): string | undefined {
  const match = task.match(/https?:\/\/\S+/i);
  return match?.[0];
}

function extractSearchText(task: string): string | undefined {
  const quoted = task.match(/["“](.+?)["”]/);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const patterns = [
    /search for (.+)$/i,
    /look up (.+)$/i,
    /find (.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

async function trySelectors<T>(
  page: PageInstance,
  selectors: string[],
  action: (selector: string) => Promise<T>,
): Promise<{ selector: string; result: T } | undefined> {
  for (const selector of selectors) {
    try {
      const result = await action(selector);
      return { selector, result };
    } catch {
      continue;
    }
  }

  return undefined;
}

async function runBrowserTask(
  task: string,
  options: {
    sessionId?: string;
    startUrl?: string;
    timeout?: number;
    screenshot?: boolean;
    waitStrategy?: WaitStrategy;
  },
): Promise<{ sessionId: string; content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; temporarySession: boolean }> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const waitStrategy = options.waitStrategy ?? DEFAULT_WAIT;
  const temporarySession = !options.sessionId;
  const session = options.sessionId ? getSession(options.sessionId) : await createSession();
  const steps: string[] = [];

  try {
    const url = options.startUrl ?? extractUrl(task);
    if (url) {
      await navigateSession(session, url, waitStrategy, timeout);
      steps.push(`Navigated to ${url}.`);
    }

    const searchText = extractSearchText(task);
    if (searchText) {
      const foundInput = await trySelectors(session.page, searchInputSelectors, async (selector) => {
        await ensureSelector(session.page, selector, Math.min(timeout, 10_000));
        await session.page.fill(selector, searchText);
        return true;
      });

      if (foundInput) {
        steps.push(`Filled search input using selector ${foundInput.selector}.`);

        const foundButton = await trySelectors(session.page, searchButtonSelectors, async (selector) => {
          await ensureSelector(session.page, selector, 5_000);
          await session.page.click(selector);
          return true;
        });

        if (foundButton) {
          steps.push(`Clicked search button ${foundButton.selector}.`);
        } else {
          await session.page.keyboard.press("Enter");
          steps.push("Pressed Enter to submit search.");
        }

        await wait(2_000);
      } else {
        steps.push("Could not find an obvious search input automatically.");
      }
    }

    const snapshot = await getPageSnapshot(session, {
      includeHtml: true,
      includeScreenshot: options.screenshot ?? true,
    });

    const taskSummary = {
      type: "text" as const,
      text: [
        `Session ID: ${session.id}`,
        `Task: ${task}`,
        `Steps:`,
        ...steps.map((step, index) => `${index + 1}. ${step}`),
      ].join("\n"),
    };

    return {
      sessionId: session.id,
      content: [taskSummary, ...snapshot],
      temporarySession,
    };
  } finally {
    updateLastUsed(session);
  }
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
    enable_cache: z.boolean().optional().default(false).describe("Enable browser cache."),
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
    headless: z.boolean().optional().default(true).describe("Run headless."),
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
      interactiveLimit: z.number().min(1).max(100).optional().default(25),
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
    },
    async ({ sessionId, selector, timeout, waitStrategy, screenshot }) => {
      const session = getSession(sessionId);
      await ensureSelector(session.page, selector, timeout);
      await session.page.click(selector);
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
    },
    async ({ sessionId, selector, value, timeout, screenshot, submit }) => {
      const session = getSession(sessionId);
      await ensureSelector(session.page, selector, timeout);
      await session.page.fill(selector, value);
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
    "browser_task",
    {
      sessionId: z.string().optional().describe("Optional existing session. If omitted, a temporary session is created."),
      startUrl: z.string().optional().describe("Optional page to open before attempting the task."),
      task: z.string().describe("High-level browser task such as 'Open example.com and search for John Doe'."),
      timeout: z.number().min(5000).max(300000).optional().default(DEFAULT_TIMEOUT),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT),
      screenshot: z.boolean().optional().default(true),
    },
    async ({ sessionId, startUrl, task, timeout, waitStrategy, screenshot }) => {
      const result = await runBrowserTask(task, {
        sessionId,
        startUrl,
        timeout,
        waitStrategy,
        screenshot,
      });

      try {
        return { content: result.content };
      } finally {
        if (result.temporarySession) {
          await safeCloseSession(result.sessionId);
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
