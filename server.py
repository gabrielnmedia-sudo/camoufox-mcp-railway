#!/usr/bin/env python3
"""
Camoufox MCP Server v3.4.0 — Python edition
Uses the original camoufox Python package for correct fingerprint generation.

Return-type fix: all tools return str (FastMCP serializes str correctly).
The screenshot() tool is the dedicated way to capture images.
"""

import asyncio
import base64
import json
import os
import random
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Union

from fastmcp import FastMCP
from playwright.async_api import Page

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
APP_NAME = "camoufox-mcp-server"
APP_VERSION = "3.5.1"
PORT = int(os.environ.get("PORT", 3000))
SESSION_TTL_S = int(os.environ.get("SESSION_TTL_MS", 30 * 60 * 1000)) // 1000
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", 10))
DEFAULT_TIMEOUT = 60_000
DEFAULT_WAIT = "domcontentloaded"
MCP_AUTH_TOKEN = os.environ.get("MCP_AUTH_TOKEN")
PROXY_URL = os.environ.get("PROXY_URL")
PROXY_SERVER = os.environ.get("PROXY_SERVER")
PROXY_USERNAME = os.environ.get("PROXY_USERNAME")
PROXY_PASSWORD = os.environ.get("PROXY_PASSWORD")
CAPSOLVER_API_KEY = os.environ.get("CAPSOLVER_API_KEY")

# ---------------------------------------------------------------------------
# Session store
# ---------------------------------------------------------------------------
_sessions: dict[str, dict] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_default_proxy() -> Optional[dict]:
    if PROXY_URL:
        return {"server": PROXY_URL}
    if PROXY_SERVER:
        p: dict = {"server": PROXY_SERVER}
        if PROXY_USERNAME:
            p["username"] = PROXY_USERNAME
        if PROXY_PASSWORD:
            p["password"] = PROXY_PASSWORD
        return p
    return None


def _resolve_proxy(proxy=None):
    if proxy is not None:
        return proxy
    return _get_default_proxy()


async def _human_delay(mn: int = 50, mx: int = 300):
    await asyncio.sleep((mn + random.randint(0, mx - mn)) / 1000)


async def _prune_expired():
    now = datetime.now(timezone.utc)
    expired = [
        sid for sid, s in list(_sessions.items())
        if (now - datetime.fromisoformat(s["last_used_at"])).total_seconds() > SESSION_TTL_S
    ]
    for sid in expired:
        await _safe_close(sid)


async def _safe_close(session_id: str) -> bool:
    s = _sessions.pop(session_id, None)
    if not s:
        return False
    try:
        await s["page"].close()
    except Exception:
        pass
    ctx = s.get("ctx")
    if ctx:
        try:
            await ctx.__aexit__(None, None, None)
        except Exception:
            pass
    else:
        try:
            await s["browser"].close()
        except Exception:
            pass
    return True


def _get_session(session_id: str) -> dict:
    s = _sessions.get(session_id)
    if not s:
        raise ValueError(f"Session {session_id} not found. Create a session first.")
    s["last_used_at"] = _now_iso()
    return s


async def _new_session(
    os_name: Optional[str] = None,
    headless: Union[bool, str] = "virtual",
    humanize: bool = True,
    geoip: bool = True,
    block_webrtc: bool = True,
    block_webgl: bool = False,
    block_images: bool = False,
    disable_coop: bool = False,
    locale: Optional[str] = None,
    viewport: Optional[dict] = None,
    proxy: Any = None,
    enable_cache: bool = True,
    firefox_user_prefs: Optional[dict] = None,
    window: Optional[list] = None,
) -> dict:
    await _prune_expired()
    if len(_sessions) >= MAX_SESSIONS:
        raise RuntimeError(f"Session limit reached ({MAX_SESSIONS}). Close a session first.")

    os_options = ["windows", "macos", "linux"]
    selected_os = os_name or random.choice(os_options)
    resolved_proxy = _resolve_proxy(proxy)

    from camoufox.async_api import AsyncCamoufox

    win = window or (viewport and [viewport["width"], viewport["height"]]) or [1920, 1080]

    launch_kwargs: dict[str, Any] = {
        "os": selected_os,
        "headless": headless,
        "humanize": humanize,
        "geoip": geoip,
        "block_webrtc": block_webrtc,
        "block_webgl": block_webgl,
        "block_images": block_images,
        "disable_coop": disable_coop,
        "enable_cache": enable_cache,
        "window": tuple(win),
    }
    if locale:
        launch_kwargs["locale"] = locale
    if resolved_proxy:
        launch_kwargs["proxy"] = resolved_proxy
    if firefox_user_prefs:
        launch_kwargs["firefox_user_prefs"] = firefox_user_prefs

    ctx = AsyncCamoufox(**launch_kwargs)
    browser = await ctx.__aenter__()
    page = await browser.new_page()

    sid = str(uuid.uuid4())
    _sessions[sid] = {
        "id": sid,
        "browser": browser,
        "page": page,
        "ctx": ctx,
        "created_at": _now_iso(),
        "last_used_at": _now_iso(),
        "os": selected_os,
        "proxy": resolved_proxy,
    }
    return _sessions[sid]


# ---------------------------------------------------------------------------
# Capsolver — auto-solve Cloudflare managed challenges
# ---------------------------------------------------------------------------
def _capsolver_post(endpoint: str, payload: dict) -> dict:
    """Synchronous HTTP POST to Capsolver API."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"https://api.capsolver.com/{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


async def _solve_cf_challenge(page: Page, url: str, proxy_dict: Optional[dict] = None) -> bool:
    """Solve a Cloudflare managed challenge using Capsolver. Returns True if solved."""
    if not CAPSOLVER_API_KEY:
        return False
    print(f"[Capsolver] Solving CF challenge for {url}")

    # Build proxy string
    proxy_str = None
    if proxy_dict:
        server = proxy_dict.get("server", "")
        username = proxy_dict.get("username", "")
        password = proxy_dict.get("password", "")
        if username and password:
            if "://" in server:
                scheme, rest = server.split("://", 1)
                proxy_str = f"{scheme}://{username}:{password}@{rest}"
            else:
                proxy_str = f"http://{username}:{password}@{server}"
        else:
            proxy_str = server

    task: dict = {"type": "AntiCloudflareTask", "websiteURL": url}
    if proxy_str:
        task["proxy"] = proxy_str

    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _capsolver_post, "createTask", {"clientKey": CAPSOLVER_API_KEY, "task": task}
        )
    except Exception as e:
        print(f"[Capsolver] createTask failed: {e}")
        return False

    if result.get("errorId"):
        print(f"[Capsolver] Error: {result.get('errorDescription')}")
        return False

    task_id = result.get("taskId")
    if not task_id:
        return False

    print(f"[Capsolver] Task {task_id} created, polling up to 360s...")
    for attempt in range(120):
        await asyncio.sleep(3)
        try:
            res2 = await asyncio.get_event_loop().run_in_executor(
                None, _capsolver_post, "getTaskResult",
                {"clientKey": CAPSOLVER_API_KEY, "taskId": task_id}
            )
        except Exception as poll_err:
            print(f"[Capsolver] Poll {attempt+1} error: {poll_err}")
            continue

        status = res2.get("status")
        if attempt % 10 == 9:  # Log every 30s
            print(f"[Capsolver] Poll {attempt+1}/120: status={status} errorId={res2.get('errorId')}")
        if status == "ready":
            solution = res2.get("solution", {})
            cf_clearance = solution.get("cf_clearance") or solution.get("cookies", {}).get("cf_clearance")
            if cf_clearance:
                parsed = urllib.parse.urlparse(url)
                host = parsed.netloc.split(":")[0]
                parts = host.split(".")
                root_domain = "." + ".".join(parts[-2:]) if len(parts) >= 2 else host
                await page.context.add_cookies([{
                    "name": "cf_clearance",
                    "value": cf_clearance,
                    "domain": root_domain,
                    "path": "/",
                    "httpOnly": True,
                    "secure": True,
                }])
                print(f"[Capsolver] Got cf_clearance (domain={root_domain}), navigating to clean URL...")
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                title = await page.title()
                print(f"[Capsolver] After goto title: {title}")
                return "just a moment" not in title.lower()
        elif status == "failed":
            print(f"[Capsolver] Task failed: {res2.get('errorDescription')}")
            return False

    print("[Capsolver] Timed out waiting for solution")
    return False


async def _is_cf_challenge(page: Page) -> bool:
    """Check if current page is a Cloudflare challenge."""
    title = await page.title()
    url = page.url
    return (
        "just a moment" in title.lower()
        or "checking your browser" in title.lower()
        or "__cf_chl" in url
        or "cf_chl_rt_tk" in url
    )


# ---------------------------------------------------------------------------
# Page helpers — all return plain str
# ---------------------------------------------------------------------------
async def _wait_cf_auto_resolve(page: Page, max_wait_s: int = 60) -> bool:
    """Wait for Cloudflare's challenge JS to auto-complete. Returns True if resolved."""
    print(f"[CF] Waiting up to {max_wait_s}s for auto-resolve...")
    try:
        await page.wait_for_function(
            """() => {
                const t = document.title.toLowerCase();
                return !t.includes('just a moment') && !t.includes('checking your browser') && t.length > 0;
            }""",
            timeout=max_wait_s * 1000,
            polling=2000,
        )
        title = await page.title()
        print(f"[CF] Auto-resolved! Title: {title}")
        return True
    except Exception:
        title = await page.title()
        print(f"[CF] Did not auto-resolve in {max_wait_s}s. Title: {title}")
        return False


async def _navigate(page: Page, url: str, wait_strategy: str, timeout: int,
                    proxy_dict: Optional[dict] = None):
    """Navigate to URL. CF challenges are NOT auto-solved here to avoid proxy timeout.
    If a challenge is detected, the snapshot will include CF_CHALLENGE_DETECTED marker.
    Call the `solve_cf` tool separately to resolve it."""
    await page.goto(url, wait_until=wait_strategy, timeout=timeout)


async def _inspect_elements(page: Page, limit: int = 50) -> list:
    return await page.evaluate("""(max) => {
        const sel = "a, button, input, textarea, select, [role='button'], [role='link']";
        return Array.from(document.querySelectorAll(sel))
            .filter(el => {
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
            })
            .slice(0, max)
            .map(el => {
                const id = el.id || '';
                const name = el.getAttribute('name') || '';
                const text = (el.innerText || el.getAttribute('value') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
                const type = el.getAttribute('type') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                const href = el.getAttribute('href') || '';
                const hint = id ? '#' + id
                    : name ? el.tagName.toLowerCase() + '[name="' + name + '"]'
                    : placeholder ? el.tagName.toLowerCase() + '[placeholder="' + placeholder + '"]'
                    : el.tagName.toLowerCase() + ':text("' + text.slice(0, 40) + '")';
                return { tag: el.tagName.toLowerCase(), text, id, name, type, placeholder, ariaLabel, href, selectorHint: hint };
            });
    }""", limit)


async def _page_text(
    session: dict,
    include_html: bool = True,
    interactive_limit: int = 50,
    max_text_length: int = 10000,
) -> str:
    """Returns page snapshot as a plain string."""
    page: Page = session["page"]
    title = await page.title()
    url = page.url
    body_text = await page.evaluate(
        "(max) => (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, max)",
        max_text_length,
    )
    elements = await _inspect_elements(page, interactive_limit)
    html = await page.content() if include_html else None

    cf_blocked = await _is_cf_challenge(session["page"])
    lines = [
        f"URL: {url}",
        f"Title: {title}",
        *(["⚠️  CF_CHALLENGE_DETECTED — call solve_cf(session_id) to bypass Cloudflare."] if cf_blocked else []),
        f"Visible text: {body_text}",
        f"Interactive elements ({len(elements)}):",
        *[
            f"{i+1}. {e['tag']} | text=\"{e['text']}\" | selectorHint=\"{e['selectorHint']}\" | "
            f"name=\"{e['name']}\" | type=\"{e['type']}\" | placeholder=\"{e['placeholder']}\" | href=\"{e['href']}\""
            for i, e in enumerate(elements)
        ],
    ]
    if html:
        lines += ["", "HTML:", html]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------
mcp = FastMCP(APP_NAME)


@mcp.tool
async def create_session(
    os_name: Optional[str] = None,
    headless: Union[bool, str] = "virtual",
    humanize: bool = True,
    geoip: bool = True,
    block_webrtc: bool = True,
    block_webgl: bool = False,
    block_images: bool = False,
    disable_coop: bool = False,
    locale: Optional[str] = None,
    viewport: Optional[dict] = None,
    proxy: Optional[Any] = None,
    enable_cache: bool = True,
    firefox_user_prefs: Optional[dict] = None,
    window: Optional[list] = None,
    start_url: Optional[str] = None,
    wait_strategy: str = DEFAULT_WAIT,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Create a persistent Camoufox browser session with anti-detection fingerprinting.
    Returns session ID and initial page snapshot.

    Parameters:
    - os_name: OS fingerprint — 'windows', 'macos', 'linux' (random if omitted)
    - headless: true=headless, false=headed, 'virtual'=Xvfb virtual display (default, best anti-detection)
    - humanize: human-like mouse movement (default true)
    - geoip: auto timezone/locale from proxy IP (default true)
    - block_webrtc: block WebRTC (default true)
    - start_url: optional URL to navigate to immediately after session creation
    """
    s = await _new_session(
        os_name=os_name, headless=headless, humanize=humanize, geoip=geoip,
        block_webrtc=block_webrtc, block_webgl=block_webgl, block_images=block_images,
        disable_coop=disable_coop, locale=locale, viewport=viewport, proxy=proxy,
        enable_cache=enable_cache, firefox_user_prefs=firefox_user_prefs, window=window,
    )
    try:
        if start_url:
            await _navigate(s["page"], start_url, wait_strategy, timeout, proxy_dict=s.get("proxy"))
        snap = await _page_text(s)
        return f"Created session {s['id']} (os={s['os']}).\n{snap}"
    except Exception:
        await _safe_close(s["id"])
        raise


@mcp.tool
async def list_sessions() -> str:
    """List all active browser sessions with their IDs and current URLs."""
    await _prune_expired()
    if not _sessions:
        return "No active sessions."
    return "\n".join(
        f"{s['id']} | url={s['page'].url} | os={s['os']} | created={s['created_at']} | last_used={s['last_used_at']}"
        for s in _sessions.values()
    )


@mcp.tool
async def close_session(session_id: str) -> str:
    """Close and clean up a browser session."""
    closed = await _safe_close(session_id)
    return f"Closed session {session_id}." if closed else f"Session {session_id} was already closed."


@mcp.tool
async def goto(
    session_id: str,
    url: str,
    wait_strategy: str = DEFAULT_WAIT,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Navigate an existing session to a URL and return the page snapshot."""
    s = _get_session(session_id)
    await _navigate(s["page"], url, wait_strategy, timeout, proxy_dict=s.get("proxy"))
    return await _page_text(s)


@mcp.tool
async def get_content(session_id: str) -> str:
    """Get full HTML content and visible text of the current page."""
    s = _get_session(session_id)
    return await _page_text(s, include_html=True)


@mcp.tool
async def inspect_page(
    session_id: str,
    interactive_limit: int = 50,
) -> str:
    """Inspect the current page: URL, title, visible text, and interactive elements (no full HTML).
    Use this to find selectors for form fields and buttons."""
    s = _get_session(session_id)
    return await _page_text(s, include_html=False, interactive_limit=interactive_limit)


@mcp.tool
async def screenshot(session_id: str, full_page: bool = True) -> str:
    """Capture a PNG screenshot of the current page. Returns base64-encoded PNG."""
    s = _get_session(session_id)
    img_data = await s["page"].screenshot(type="png", full_page=full_page)
    b64 = base64.b64encode(img_data).decode()
    return f"data:image/png;base64,{b64}"


@mcp.tool
async def click(
    session_id: str,
    selector: str,
    timeout: int = DEFAULT_TIMEOUT,
    wait_strategy: str = DEFAULT_WAIT,
    double_click: bool = False,
    button: str = "left",
) -> str:
    """Click an element by CSS selector. Supports double-click and right-click."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    if double_click:
        await s["page"].dblclick(selector, button=button)
    else:
        await s["page"].click(selector, button=button)
    await asyncio.sleep(2.0 if wait_strategy == "networkidle" else 0.75)
    return await _page_text(s, include_html=False)


@mcp.tool
async def fill(
    session_id: str,
    selector: str,
    value: str,
    timeout: int = DEFAULT_TIMEOUT,
    submit: bool = False,
    humanize: bool = False,
) -> str:
    """Fill a form field. Set humanize=true to type character-by-character for better anti-detection."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    if humanize:
        await s["page"].click(selector)
        await s["page"].keyboard.press("Control+a")
        await s["page"].keyboard.press("Delete")
        await s["page"].type(selector, value, delay=80 + random.randint(0, 50))
    else:
        await s["page"].fill(selector, value)
    if submit:
        await s["page"].press(selector, "Enter")
        await asyncio.sleep(1.0)
    return await _page_text(s, include_html=False)


@mcp.tool
async def type_text(
    session_id: str,
    selector: str,
    text: str,
    delay: int = 80,
    clear_first: bool = True,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Type text character-by-character with realistic keystroke delays. Best for anti-bot form fields."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    await s["page"].click(selector)
    if clear_first:
        await s["page"].keyboard.press("Control+a")
        await s["page"].keyboard.press("Delete")
    await s["page"].type(selector, text, delay=delay + random.randint(0, 50))
    return await _page_text(s, include_html=False)


@mcp.tool
async def press(session_id: str, key: str) -> str:
    """Press a keyboard key e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].keyboard.press(key)
    await asyncio.sleep(0.75)
    return await _page_text(s, include_html=False)


@mcp.tool
async def wait_for(
    session_id: str,
    selector: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    milliseconds: int = 0,
) -> str:
    """Wait for a CSS selector to become visible, or wait a fixed number of milliseconds."""
    s = _get_session(session_id)
    if selector:
        await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    if milliseconds > 0:
        await asyncio.sleep(milliseconds / 1000)
    return await _page_text(s, include_html=False)


@mcp.tool
async def select(
    session_id: str,
    selector: str,
    value: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Select an option from a <select> dropdown by value or visible label text."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    try:
        await s["page"].select_option(selector, value=value)
    except Exception:
        await s["page"].select_option(selector, label=value)
    return await _page_text(s, include_html=False)


@mcp.tool
async def scroll(
    session_id: str,
    direction: str = "down",
    amount: int = 500,
    selector: Optional[str] = None,
) -> str:
    """Scroll the page up or down, or scroll a specific element into view."""
    s = _get_session(session_id)
    if selector:
        await s["page"].locator(selector).scroll_into_view_if_needed()
    else:
        delta = amount if direction == "down" else -amount
        await s["page"].mouse.wheel(0, delta)
    await asyncio.sleep(0.5)
    return await _page_text(s, include_html=False)


@mcp.tool
async def evaluate(
    session_id: str,
    script: str,
) -> str:
    """Execute JavaScript in the browser page context and return the serialized result."""
    s = _get_session(session_id)
    try:
        result = await s["page"].evaluate(script)
        result_text = result if isinstance(result, str) else json.dumps(result, indent=2)
    except Exception as e:
        result_text = f"Error: {e}"
    return f"Result:\n{result_text}"


@mcp.tool
async def hover(
    session_id: str,
    selector: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Move the mouse over an element (hover)."""
    s = _get_session(session_id)
    await _human_delay()
    await s["page"].wait_for_selector(selector, timeout=timeout, state="visible")
    await s["page"].hover(selector)
    await asyncio.sleep(0.5)
    return await _page_text(s, include_html=False)


@mcp.tool
async def dismiss_popup(
    session_id: str,
    strategy: str = "auto",
    selector: Optional[str] = None,
) -> str:
    """Dismiss cookie banners, consent modals, and overlays.
    strategy: 'auto' tries Escape then common close buttons, 'escape' presses Escape only, 'click_close' clicks close buttons."""
    s = _get_session(session_id)
    steps = []

    if selector:
        try:
            await s["page"].wait_for_selector(selector, timeout=5000, state="visible")
            await s["page"].click(selector)
            steps.append(f"Clicked: {selector}")
        except Exception:
            steps.append(f"Selector not found: {selector}")
    else:
        close_selectors = [
            "#onetrust-accept-btn-handler",
            "[aria-label*='close' i]", "[aria-label*='dismiss' i]", "[aria-label*='accept' i]",
            "button:has-text('Accept all')", "button:has-text('Accept cookies')",
            "button:has-text('Accept')", "button:has-text('Got it')", "button:has-text('OK')",
            "button:has-text('Close')", "button:has-text('Dismiss')", "button:has-text('No thanks')",
            ".modal-close", ".close-button", "[data-dismiss='modal']", "[data-testid*='close' i]",
        ]
        if strategy in ("escape", "auto"):
            await s["page"].keyboard.press("Escape")
            await asyncio.sleep(0.3)
            steps.append("Pressed Escape.")
        if strategy in ("click_close", "auto"):
            for sel in close_selectors:
                try:
                    await s["page"].wait_for_selector(sel, timeout=1500, state="visible")
                    await s["page"].click(sel)
                    steps.append(f"Clicked: {sel}")
                    await asyncio.sleep(0.5)
                    break
                except Exception:
                    continue

    snap = await _page_text(s, include_html=False)
    steps_text = "Steps:\n" + "\n".join(f"{i+1}. {st}" for i, st in enumerate(steps))
    return f"{steps_text}\n\n{snap}"


@mcp.tool
async def solve_cf(
    session_id: str,
    wait_seconds: int = 30,
) -> str:
    """Attempt to solve a Cloudflare managed challenge on the current page.
    Tries two strategies in sequence:
    1. Wait up to `wait_seconds` for Camoufox's JS to auto-solve the challenge.
    2. If still blocked and CAPSOLVER_API_KEY is configured, use Capsolver AntiCloudflareTask.

    Returns the page snapshot with status. Call this after goto/click returns CF_CHALLENGE_DETECTED.
    May need to be called multiple times — each call waits `wait_seconds` before reporting.
    Capsolver polling is done in a background task to avoid HTTP timeouts; call again to check."""
    s = _get_session(session_id)
    page: Page = s["page"]

    if not await _is_cf_challenge(page):
        return "No CF challenge detected on current page.\n" + await _page_text(s, include_html=False)

    # Strip CF challenge tokens (__cf_chl_rt_tk etc) from URL so Capsolver gets a clean URL
    _raw_url = page.url
    _parsed = urllib.parse.urlparse(_raw_url)
    _qs = urllib.parse.parse_qs(_parsed.query, keep_blank_values=True)
    _qs = {k: v for k, v in _qs.items() if not k.startswith("__cf_")}
    _clean_query = urllib.parse.urlencode(_qs, doseq=True)
    current_url = urllib.parse.urlunparse(_parsed._replace(query=_clean_query))
    print(f"[solve_cf] Challenge on {current_url}, waiting {wait_seconds}s for auto-resolve...")

    # Phase 1: wait for auto-resolve (bounded to wait_seconds so HTTP doesn't timeout)
    resolved = await _wait_cf_auto_resolve(page, max_wait_s=min(wait_seconds, 60))
    if resolved:
        return "✅ CF challenge auto-resolved.\n" + await _page_text(s, include_html=False)

    # Phase 2: try Capsolver (single poll cycle — max ~30s per call to avoid proxy timeout)
    if not CAPSOLVER_API_KEY:
        return "⚠️  CF challenge still active. No CAPSOLVER_API_KEY configured.\n" + await _page_text(s, include_html=False)

    print(f"[solve_cf] Starting Capsolver task for {current_url}...")
    proxy_dict = s.get("proxy")

    # Build proxy string
    proxy_str = None
    if proxy_dict:
        server = proxy_dict.get("server", "")
        username = proxy_dict.get("username", "")
        password = proxy_dict.get("password", "")
        if username and password:
            if "://" in server:
                scheme, rest = server.split("://", 1)
                proxy_str = f"{scheme}://{username}:{password}@{rest}"
            else:
                proxy_str = f"http://{username}:{password}@{server}"
        else:
            proxy_str = server

    task: dict = {"type": "AntiCloudflareTask", "websiteURL": current_url}
    if proxy_str:
        task["proxy"] = proxy_str

    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _capsolver_post, "createTask", {"clientKey": CAPSOLVER_API_KEY, "task": task}
        )
    except Exception as e:
        return f"⚠️  Capsolver createTask failed: {e}\n" + await _page_text(s, include_html=False)

    if result.get("errorId"):
        return f"⚠️  Capsolver error: {result.get('errorDescription')}\n" + await _page_text(s, include_html=False)

    task_id = result.get("taskId")
    if not task_id:
        return f"⚠️  Capsolver returned no taskId: {result}\n" + await _page_text(s, include_html=False)

    print(f"[solve_cf] Capsolver task {task_id} created. Polling up to {wait_seconds}s...")
    deadline = asyncio.get_event_loop().time() + max(wait_seconds - 5, 10)
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(3)
        try:
            res2 = await asyncio.get_event_loop().run_in_executor(
                None, _capsolver_post, "getTaskResult",
                {"clientKey": CAPSOLVER_API_KEY, "taskId": task_id}
            )
        except Exception:
            continue

        status = res2.get("status")
        print(f"[solve_cf] Capsolver poll: status={status}")
        if status == "ready":
            solution = res2.get("solution", {})
            cf_clearance = solution.get("cf_clearance") or solution.get("cookies", {}).get("cf_clearance")
            if cf_clearance:
                parsed = urllib.parse.urlparse(current_url)
                # CF sets cf_clearance on the root domain (e.g. .whitepages.com)
                host = parsed.netloc.split(":")[0]  # strip port if any
                parts = host.split(".")
                root_domain = "." + ".".join(parts[-2:]) if len(parts) >= 2 else host
                await page.context.add_cookies([{
                    "name": "cf_clearance",
                    "value": cf_clearance,
                    "domain": root_domain,
                    "path": "/",
                    "httpOnly": True,
                    "secure": True,
                }])
                print(f"[solve_cf] cf_clearance injected (domain={root_domain}), navigating to clean URL...")
                # Navigate to clean URL (not reload) to avoid __cf_chl_rt_tk re-challenge
                await page.goto(current_url, wait_until="domcontentloaded", timeout=30000)
                if not await _is_cf_challenge(page):
                    return "✅ CF challenge solved via Capsolver.\n" + await _page_text(s, include_html=False)
                return "⚠️  Capsolver gave cf_clearance but challenge persists.\n" + await _page_text(s, include_html=False)
            return f"⚠️  Capsolver ready but no cf_clearance in solution: {solution}\n" + await _page_text(s, include_html=False)
        elif status == "failed":
            return f"⚠️  Capsolver task failed: {res2.get('errorDescription')}\n" + await _page_text(s, include_html=False)

    return (
        f"⏳ Capsolver task {task_id} still processing. Call solve_cf again to continue waiting.\n"
        + await _page_text(s, include_html=False)
    )


@mcp.tool
async def fetch_cf_page(
    url: str,
    impersonate: str = "chrome131",
) -> str:
    """Fetch a Cloudflare-protected page using curl_cffi Chrome TLS impersonation.
    Uses Capsolver to get cf_clearance if CAPSOLVER_API_KEY is set, then fetches
    with the matching Chrome UA so CF accepts the cookie.
    Falls back to direct fetch if no Capsolver key (works on some CF tiers).
    Returns page text content."""
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        return "⚠️  curl_cffi not installed. Add curl_cffi to requirements.txt."

    proxy_str = None
    raw_proxy = os.environ.get("PROXY_SERVER", "")
    proxy_user = os.environ.get("PROXY_USERNAME", "")
    proxy_pass = os.environ.get("PROXY_PASSWORD", "")
    if raw_proxy and proxy_user and proxy_pass:
        if "://" in raw_proxy:
            scheme, rest = raw_proxy.split("://", 1)
            proxy_str = f"{scheme}://{proxy_user}:{proxy_pass}@{rest}"
        else:
            proxy_str = f"http://{proxy_user}:{proxy_pass}@{raw_proxy}"

    cookies: dict = {}

    if CAPSOLVER_API_KEY:
        task: dict = {"type": "AntiCloudflareTask", "websiteURL": url}
        if proxy_str:
            task["proxy"] = proxy_str
        try:
            result = await asyncio.get_event_loop().run_in_executor(
                None, _capsolver_post, "createTask", {"clientKey": CAPSOLVER_API_KEY, "task": task}
            )
        except Exception as e:
            return f"⚠️  Capsolver createTask failed: {e}"

        if result.get("errorId"):
            return f"⚠️  Capsolver error: {result.get('errorDescription')}"

        task_id = result.get("taskId")
        if task_id:
            print(f"[fetch_cf_page] Capsolver task {task_id} created, polling up to 60s...")
            deadline = asyncio.get_event_loop().time() + 60
            while asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(3)
                try:
                    res2 = await asyncio.get_event_loop().run_in_executor(
                        None, _capsolver_post, "getTaskResult",
                        {"clientKey": CAPSOLVER_API_KEY, "taskId": task_id}
                    )
                except Exception:
                    continue
                status = res2.get("status")
                if status == "ready":
                    solution = res2.get("solution", {})
                    cf_clearance = solution.get("cf_clearance") or solution.get("cookies", {}).get("cf_clearance")
                    ua = solution.get("userAgent")
                    if cf_clearance:
                        cookies["cf_clearance"] = cf_clearance
                        if ua:
                            impersonate_ua = ua
                        print(f"[fetch_cf_page] Got cf_clearance, fetching page...")
                    break
                elif status == "failed":
                    print(f"[fetch_cf_page] Capsolver failed: {res2.get('errorDescription')}")
                    break

    proxies = {"https": proxy_str, "http": proxy_str} if proxy_str else None
    try:
        resp = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: cffi_requests.get(
                url,
                impersonate=impersonate,
                cookies=cookies if cookies else None,
                proxies=proxies,
                timeout=30,
                allow_redirects=True,
            )
        )
        html = resp.text
        import re as _re
        status_line = f"HTTP {resp.status_code} — {url}"
        title_m = _re.search(r'<title[^>]*>([^<]+)</title>', html, _re.I)
        title = title_m.group(1).strip() if title_m else "(no title)"
        cf_ok = "just a moment" not in title.lower() and "checking your browser" not in title.lower()
        status_emoji = "✅" if cf_ok else "⚠️  CF still blocking"

        # Try to extract embedded JSON state (Vue/Nuxt/React SSR pattern)
        json_state = None
        for pattern in [
            r'<script[^>]+id="__NUXT_DATA__"[^>]*>(.*?)</script>',
            r'window\.__NUXT__\s*=\s*(\{.*?\});?\s*</script>',
            r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})',
            r'<script[^>]+type="application/json"[^>]*>(.*?)</script>',
        ]:
            m = _re.search(pattern, html, _re.DOTALL | _re.IGNORECASE)
            if m:
                raw_json = m.group(1).strip()
                if len(raw_json) > 100:
                    json_state = raw_json[:12000]
                    break

        # Strip tags for readable text
        # Remove script/style blocks first
        clean = _re.sub(r'<script[^>]*>.*?</script>', ' ', html, flags=_re.DOTALL | _re.IGNORECASE)
        clean = _re.sub(r'<style[^>]*>.*?</style>', ' ', clean, flags=_re.DOTALL | _re.IGNORECASE)
        text = _re.sub(r'<[^>]+>', ' ', clean)
        text = _re.sub(r'\s+', ' ', text).strip()

        result = f"{status_emoji}\n{status_line}\nTitle: {title}\n"
        if json_state:
            result += f"\nEmbedded JSON state ({len(json_state)} chars):\n{json_state}\n"
        result += f"\nPage text ({len(text)} chars):\n{text[:6000]}"
        return result
    except Exception as e:
        return f"⚠️  fetch_cf_page error: {e}"


@mcp.tool
async def browse(
    url: str,
    wait_strategy: str = DEFAULT_WAIT,
    timeout: int = DEFAULT_TIMEOUT,
    os_name: Optional[str] = None,
    headless: Union[bool, str] = "virtual",
    humanize: bool = True,
    geoip: bool = True,
    block_webrtc: bool = True,
    block_webgl: bool = False,
    block_images: bool = False,
    proxy: Optional[Any] = None,
    enable_cache: bool = True,
) -> str:
    """Open a URL in a one-shot ephemeral session and return its snapshot. Session closes automatically."""
    s = await _new_session(
        os_name=os_name, headless=headless, humanize=humanize, geoip=geoip,
        block_webrtc=block_webrtc, block_webgl=block_webgl, block_images=block_images,
        proxy=proxy, enable_cache=enable_cache,
    )
    try:
        await _navigate(s["page"], url, wait_strategy, timeout, proxy_dict=s.get("proxy"))
        return await _page_text(s, include_html=True)
    except Exception as e:
        return f"Failed to browse {url}: {e}"
    finally:
        await _safe_close(s["id"])


@mcp.tool
async def browser_task(
    task: str,
    session_id: Optional[str] = None,
    start_url: Optional[str] = None,
    wait_strategy: str = DEFAULT_WAIT,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Navigate to a URL and return a page snapshot ready for interaction.
    Use individual tools (type_text, click, select, scroll, etc.) to interact with the page.
    If session_id is omitted a temporary session is created and closed after."""
    temporary = not session_id
    s = await _new_session() if temporary else _get_session(session_id)
    try:
        if start_url:
            await _navigate(s["page"], start_url, wait_strategy, timeout, proxy_dict=s.get("proxy"))
        snap = await _page_text(s, include_html=True)
        return f"Session ID: {s['id']}\nTask: {task}\n{snap}"
    finally:
        s["last_used_at"] = _now_iso()
        if temporary:
            await _safe_close(s["id"])


# ---------------------------------------------------------------------------
# Background pruning loop
# ---------------------------------------------------------------------------
async def _prune_loop():
    while True:
        await asyncio.sleep(max(30, SESSION_TTL_S // 2))
        await _prune_expired()


# ---------------------------------------------------------------------------
# Entry point — pure ASGI wrapper so FastMCP's lifespan runs intact
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    _mcp_asgi = mcp.http_app(path="/mcp")

    async def _send_json(send, status: int, body: dict):
        data = json.dumps(body).encode()
        await send({"type": "http.response.start", "status": status,
                     "headers": [[b"content-type", b"application/json"],
                                  [b"content-length", str(len(data)).encode()]]})
        await send({"type": "http.response.body", "body": data})

    class CamoufoxApp:
        """Thin ASGI wrapper: handles /, /health, Bearer auth, then delegates to FastMCP."""

        async def __call__(self, scope, receive, send):
            if scope["type"] == "lifespan":
                await self._lifespan(scope, receive, send)
                return

            if scope["type"] != "http":
                await _mcp_asgi(scope, receive, send)
                return

            path = scope.get("path", "")

            if path == "/health":
                await _prune_expired()
                await _send_json(send, 200, {
                    "ok": True, "name": APP_NAME, "version": APP_VERSION,
                    "transport": "streamable-http",
                    "activeSessions": len(_sessions),
                    "proxyConfigured": bool(_get_default_proxy()),
                })
                return

            if path == "/":
                await _send_json(send, 200, {
                    "name": APP_NAME, "version": APP_VERSION,
                    "mcpPath": "/mcp", "activeSessions": len(_sessions),
                })
                return

            if MCP_AUTH_TOKEN:
                headers = {k.lower(): v for k, v in scope.get("headers", [])}
                auth = headers.get(b"authorization", b"").decode()
                if auth != f"Bearer {MCP_AUTH_TOKEN}":
                    await _send_json(send, 401, {"error": "Unauthorized"})
                    return

            await _mcp_asgi(scope, receive, send)

        async def _lifespan(self, scope, receive, send):
            prune_task = None
            startup_complete = asyncio.Event()
            shutdown_event = asyncio.Event()

            async def patched_receive():
                msg = await receive()
                if msg["type"] == "lifespan.shutdown":
                    shutdown_event.set()
                return msg

            async def patched_send(msg):
                if msg["type"] == "lifespan.startup.complete":
                    startup_complete.set()
                await send(msg)

            fastmcp_task = asyncio.create_task(
                _mcp_asgi(scope, patched_receive, patched_send)
            )

            await startup_complete.wait()
            prune_task = asyncio.create_task(_prune_loop())

            await fastmcp_task

            if prune_task:
                prune_task.cancel()
            for sid in list(_sessions.keys()):
                await _safe_close(sid)

    print(f"[Camoufox MCP] v{APP_VERSION} starting on http://0.0.0.0:{PORT}/mcp")
    uvicorn.run(CamoufoxApp(), host="0.0.0.0", port=PORT, log_level="info")
