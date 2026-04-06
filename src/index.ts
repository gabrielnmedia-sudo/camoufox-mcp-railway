#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Camoufox } from "camoufox-js";
import chalk from "chalk";

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

const APP_NAME = "camoufox-mcp-server";
const APP_VERSION = "1.5.0";
const TRANSPORT_MODE = (process.env.TRANSPORT ?? (process.env.PORT ? "http" : "stdio")).toLowerCase();
const HTTP_PATH = process.env.MCP_HTTP_PATH || "/mcp";
const PORT = Number(process.env.PORT || 3000);

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

function createServer(): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: APP_VERSION,
  });

  server.tool(
    "browse",
    {
      url: z.string().describe("The URL to navigate to and retrieve content from. Use this tool when users ask to visit, check, search, navigate, browse, fetch, or scrape websites. Must be a fully qualified URL (e.g., 'https://example.com')."),
      os: z.enum(["windows", "macos", "linux"]).optional().describe("Optional OS to spoof. Can be 'windows', 'macos', or 'linux'. If not specified, will rotate between all OS types."),
      waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default("domcontentloaded").describe("Wait strategy for page load. 'domcontentloaded' waits for DOM, 'load' waits for all resources, 'networkidle' waits for network activity to finish."),
      timeout: z.number().min(5000).max(300000).optional().default(60000).describe("Timeout in milliseconds for page load (5-300 seconds)."),
      humanize: z.boolean().optional().default(true).describe("Enable realistic cursor movements and human-like behavior for better stealth and anti-detection. Helps avoid bot detection by simulating natural user interactions."),
      locale: z.string().optional().describe("Browser locale (e.g., 'en-US', 'fr-FR')."),
      viewport: z.object({
        width: z.number().min(320).max(3840).default(1920),
        height: z.number().min(240).max(2160).default(1080),
      }).optional().describe("Custom viewport dimensions."),
      screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image of the page after loading. Use when users ask to take a screenshot, capture an image, show them visually, or want to see how the page looks."),
      block_webrtc: z.boolean().optional().default(true).describe("Block WebRTC entirely for enhanced privacy and stealth. Use when users want private browsing, to hide their real IP, prevent WebRTC leaks, or browse in stealth mode."),
      proxy: z.union([
        z.string().describe("Proxy URL (e.g., 'http://proxy.example.com:8080')"),
        z.object({
          server: z.string().describe("Proxy server URL"),
          username: z.string().optional().describe("Proxy username for authentication"),
          password: z.string().optional().describe("Proxy password for authentication"),
        }),
      ]).optional().describe("Proxy configuration for anonymous browsing. Use when users want to browse through a proxy, hide their IP, browse anonymously, or access content via a specific server location."),
      enable_cache: z.boolean().optional().default(false).describe("Cache pages, requests, etc. Uses more memory but improves performance when revisiting pages."),
      firefox_user_prefs: z.record(z.any()).optional().describe("Custom Firefox user preferences to set."),
      exclude_addons: z.array(z.string()).optional().describe("List of default addons to exclude (e.g., ['ublock_origin'])."),
      window: z.preprocess(
        (arg) => {
          if (Array.isArray(arg) && arg.length === 0) {
            return undefined;
          }
          return arg;
        },
        z.tuple([
          z.number().min(320).max(3840),
          z.number().min(240).max(2160),
        ]).optional(),
      ).describe("Set fixed window size [width, height] instead of random generation. An empty array [] is accepted and treated as if the window parameter was not specified."),
      args: z.array(z.string()).optional().describe("Additional command-line arguments to pass to the browser."),
      block_images: z.boolean().optional().default(false).describe("Block all images for faster loading, reduced bandwidth, and lightweight browsing. Use when users want quick/fast browsing, text-only content, or to save bandwidth."),
      block_webgl: z.boolean().optional().default(false).describe("Block WebGL to prevent fingerprinting and tracking. Use for maximum privacy/stealth mode, but note it may cause detection on some sites that rely heavily on WebGL."),
      disable_coop: z.boolean().optional().default(false).describe("Disable Cross-Origin-Opener-Policy to allow interaction with iframes and cross-origin content. Use when users need to click elements in iframes or access embedded content."),
      geoip: z.boolean().optional().default(true).describe("Automatically detect geolocation based on IP address."),
      headless: z.boolean().optional().describe("Run browser in headless mode. Auto-detects best mode for environment if not specified."),
    },
    async ({ url, os, waitStrategy, timeout, humanize, locale, viewport, screenshot, block_webrtc, proxy, enable_cache, firefox_user_prefs, exclude_addons, window, args, block_images, block_webgl, disable_coop, geoip, headless }) => {
      let browser: BrowserInstance | undefined;

      try {
        console.error(chalk.blue(`[Camoufox] Launching browser to browse: ${url}`));

        const headlessMode = headless ?? true;
        const osOptions = ["windows", "macos", "linux"];
        const selectedOS = os || osOptions[Math.floor(Math.random() * osOptions.length)];
        const effectiveProxy = resolveProxy(proxy);

        browser = await Camoufox({
          os: [selectedOS],
          headless: headlessMode,
          humanize,
          geoip,
          ublock: true,
          block_webgl,
          block_images,
          block_webrtc,
          disable_coop,
          locale,
          viewport: viewport ? {
            width: viewport.width,
            height: viewport.height,
          } : undefined,
          proxy: effectiveProxy,
          enable_cache,
          firefox_user_prefs,
          exclude_addons,
          window,
          args,
        } as CamoufoxOptions);

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: waitStrategy, timeout });

        const pageContent = await page.content();

        let screenshotBase64: string | undefined;
        if (screenshot) {
          try {
            const screenshotBuffer = await page.screenshot({ type: "png" });
            screenshotBase64 = screenshotBuffer.toString("base64");
            console.error(chalk.green(`[Camoufox] Screenshot captured for ${url}.`));
          } catch (screenshotError) {
            console.error(chalk.yellow(`[Camoufox] Screenshot failed: ${screenshotError instanceof Error ? screenshotError.message : String(screenshotError)}`));
          }
        }

        const features = [
          `OS: ${selectedOS}`,
          `wait: ${waitStrategy}`,
          effectiveProxy ? "proxy: enabled" : null,
          block_webrtc ? "WebRTC: blocked" : null,
          block_images ? "images: blocked" : null,
          block_webgl ? "WebGL: blocked" : null,
          disable_coop ? "COOP: disabled" : null,
          !geoip ? "geoip: disabled" : null,
        ].filter(Boolean).join(", ");

        console.error(chalk.green(`[Camoufox] Successfully retrieved content from ${url} (${features}).`));

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
          type: "text",
          text: pageContent,
        }];

        if (screenshotBase64) {
          content.push({
            type: "image",
            data: screenshotBase64,
            mimeType: "image/png",
          });
        }

        return { content };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`[Camoufox] Error during browsing: ${errorMessage}`));

        return {
          content: [{
            type: "text",
            text: `Failed to browse URL ${url}. Error: ${errorMessage}`,
          }],
          isError: true,
        };
      } finally {
        if (browser) {
          console.error(chalk.blue("[Camoufox] Closing browser."));
          await browser.close();
        }
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
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      transport: "streamable-http",
      mcpPath: HTTP_PATH,
      healthPath: "/health",
      auth: process.env.MCP_AUTH_TOKEN ? "bearer" : "disabled",
      defaultProxyConfigured: Boolean(getDefaultProxy()),
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      transport: "streamable-http",
      proxyConfigured: Boolean(getDefaultProxy()),
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
