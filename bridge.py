#!/usr/bin/env python3
"""
bridge.py — Z2U Local Playwright Upload Bridge
===============================================
Runs a small Flask web server on port 5000. The Z2U Chrome extension
sends the filled XLSX file bytes here; this script uses
playwright.connect_over_cdp() to attach to your already-open Chrome
instance and upload the file from inside your real session.

Result: Z2U sees a real browser, on your real home IP, with your real
cookies, performing a legitimate file selection — nothing to detect.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — Install dependencies (run once):
  pip install flask playwright
  playwright install chromium

STEP 2 — Start Chrome with remote debugging:

  Windows:
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ^
      --remote-debugging-port=9222 ^
      --user-data-dir=C:\\chrome-cdp-profile

  macOS:
    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
      --remote-debugging-port=9222 \\
      --user-data-dir=/tmp/chrome-cdp-profile

  Linux:
    google-chrome --remote-debugging-port=9222 \\
      --user-data-dir=/tmp/chrome-cdp-profile

  ⚠ Use a separate --user-data-dir so it opens as a fresh window.
     Log in to Z2U in that window and keep it open.

STEP 3 — Run this script:
  python bridge.py

STEP 4 — The extension sends orders automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import os
import tempfile
import time
import traceback
import urllib.request
import json as _json

from flask import Flask, jsonify, request
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ── Configuration ─────────────────────────────────────────────────────────────
CDP_URL     = "http://localhost:9222"   # Chrome remote debugging endpoint
BRIDGE_PORT = 5000                      # Port the extension POSTs to
# ─────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _dump_page_state(page, label: str):
    """Print every visible button/link text + the current URL for debugging."""
    try:
        url = page.url
        texts = []
        for el in page.locator("button, a, [role='button']").all():
            try:
                t = el.inner_text(timeout=300).strip()
                if t:
                    texts.append(repr(t))
            except Exception:
                pass
        print(f"[bridge] PAGE DUMP [{label}]  url={url}")
        print(f"[bridge] PAGE DUMP [{label}]  elements: {texts[:60]}")
    except Exception as e:
        print(f"[bridge] PAGE DUMP [{label}] failed: {e}")


def _find_upload_btn(page):
    """
    Scan for any visible Upload-Form button variant.
    Returns (element, matched_text) or (None, None).
    Tries <a>, <button>, and [role=button] with several text variants.
    """
    TEXT_VARIANTS = [
        "Upload Form",
        "Upload Delivery",
        "Batch Upload",
        "Upload",
        "上传交付",
        "上传",
    ]
    for text in TEXT_VARIANTS:
        for sel in [
            f"a:has-text('{text}')",
            f"button:has-text('{text}')",
            f"[role='button']:has-text('{text}')",
        ]:
            try:
                el = page.locator(sel).first
                el.wait_for(state="visible", timeout=1500)
                return el, text
            except PWTimeout:
                continue
            except Exception:
                continue
    return None, None


def _all_tab_urls(browser) -> list:
    """Return a list of all open tab URLs for debugging."""
    try:
        return [p.url for ctx in browser.contexts for p in ctx.pages]
    except Exception:
        return []


def _get_or_open_z2u_tab(browser, page_url: str):
    """
    Use contexts[0] (the permanent Chrome profile — the one with cookies/login).
    Look for an existing Z2U tab in that context.  If none exists, open a new
    page in the same context and navigate to page_url so the session is reused.
    Returns (context, page).
    """
    # contexts[0] is the user's permanent profile (has Z2U login cookies)
    ctx = browser.contexts[0] if browser.contexts else None
    if ctx is None:
        return None, None

    # Prefer a tab already on the Z2U order detail page
    for p in ctx.pages:
        if page_url and page_url in p.url:
            return ctx, p
    for p in ctx.pages:
        if "z2u.com/sellOrder" in p.url and "/index" not in p.url:
            return ctx, p
    for p in ctx.pages:
        if "z2u.com" in p.url:
            return ctx, p

    # No Z2U tab open — create one in the SAME context (shares cookies)
    print("[bridge] No Z2U tab found — opening one in the existing Chrome profile…")
    page = ctx.new_page()
    return ctx, page


def do_upload(tmp_path: str, order_id: str, page_url: str) -> dict:
    """
    Connect to Chrome via CDP, navigate directly to the order detail page,
    then upload the filled XLSX using Playwright's expect_file_chooser().

    Key design decisions
    --------------------
    • We ALWAYS call page.goto(page_url) so we are guaranteed to be on the
      correct page — even if the extension's background alarm already navigated
      the tab back to /sellOrder/index while we were waiting.
    • We scroll through the page in 3 passes so the "Upload Form" button is
      exposed even when it sits below the fold.
    • We dump every visible button/link text to the terminal when the button
      is not found, so you can copy the exact label and fix the selector.
    • expect_file_chooser() intercepts the native OS file-picker that Z2U's
      button triggers — set_input_files() on the hidden <input> does not work.
    """
    with sync_playwright() as pw:
        # ── Connect to Chrome ─────────────────────────────────────────────
        try:
            browser = pw.chromium.connect_over_cdp(CDP_URL, timeout=6000)
        except Exception as e:
            return {
                "ok": False,
                "error": (
                    f"CDP connect failed — is Chrome running with "
                    f"--remote-debugging-port=9222? Detail: {e}"
                ),
            }

        # ── List all tabs for diagnostics ─────────────────────────────────
        all_urls = _all_tab_urls(browser)
        print(f"[bridge] CDP Chrome has {len(all_urls)} tab(s): {all_urls}")

        # ── Get (or create) the right Z2U tab using contexts[0] ──────────
        _ctx, page = _get_or_open_z2u_tab(browser, page_url)
        if not page:
            return {
                "ok": False,
                "error": (
                    f"No browser context found in CDP Chrome. "
                    f"Open Chrome with --remote-debugging-port=9222. "
                    f"Tabs seen: {all_urls}"
                ),
            }

        print(f"[bridge] Selected tab: {page.url}")
        print(f"[bridge] Navigating to: {page_url}")
        print(f"[bridge] File path: {tmp_path}")

        try:
            page.bring_to_front()
        except Exception:
            pass

        try:
            # ── Step 1: Navigate directly to the order detail page ────────
            # This is the critical fix: always go to page_url so the tab is
            # guaranteed to be showing the order that needs uploading, not the
            # list page or some previously-navigated page.
            if page_url:
                if page.url != page_url:
                    print("[bridge] Navigating to order page…")
                    page.goto(page_url, wait_until="domcontentloaded", timeout=25000)
                    time.sleep(2.5)  # wait for React to render order detail
                else:
                    print("[bridge] Already on the correct page — waiting for render…")
                    time.sleep(1.0)
            else:
                print("[bridge] ⚠ No page_url provided — using whatever tab is open.")
                time.sleep(1.0)

            print(f"[bridge] Current URL after navigation: {page.url}")
            _dump_page_state(page, "after-navigate")

            # ── Step 2: Find the Upload button (scroll if needed) ─────────
            upload_el, matched_text = _find_upload_btn(page)

            if not upload_el:
                print("[bridge] Button not found in viewport — scrolling to expose it…")
                for scroll_frac in [0.33, 0.66, 1.0]:
                    page.evaluate(
                        f"window.scrollTo(0, document.body.scrollHeight * {scroll_frac})"
                    )
                    time.sleep(0.8)
                    upload_el, matched_text = _find_upload_btn(page)
                    if upload_el:
                        print(f"[bridge] Found after scroll ({int(scroll_frac*100)}%)")
                        break

            if not upload_el:
                _dump_page_state(page, "upload-btn-not-found")
                return {
                    "ok": False,
                    "error": (
                        "Selector Not Found — 'Upload Form' button not visible after "
                        "navigation + 3-pass page scroll. "
                        "Check the PAGE DUMP lines printed above in the bridge terminal "
                        "to see what buttons Z2U is actually showing on this page."
                    ),
                }

            print(f"[bridge] ✅ Found upload button: '{matched_text}'")
            upload_el.scroll_into_view_if_needed()
            time.sleep(0.4)

            # ── Step 3: Click + intercept the native OS file chooser ──────
            # Z2U's button triggers a native <input type="file"> dialog.
            # expect_file_chooser() captures that dialog so we can set the
            # file path without the OS picker ever appearing on screen.
            print("[bridge] Waiting for file chooser…")
            with page.expect_file_chooser(timeout=10000) as fc_info:
                upload_el.click()

            file_chooser = fc_info.value
            file_chooser.set_files(tmp_path)
            print(f"[bridge] ✅ File chooser resolved — attached: {tmp_path}")
            time.sleep(1.5)  # wait for React to process the chosen file

            # ── Step 4: Fill "Note" field in the upload popup ─────────────
            MODAL_SEL = (
                ".ant-modal-content, [role='dialog'], "
                "[class*='modal']:not([class*='modalClose']), [class*='Modal']"
            )
            try:
                modal = page.locator(MODAL_SEL).first
                modal.wait_for(state="visible", timeout=6000)
                note_inputs = modal.locator(
                    "textarea:visible, input[type='text']:visible"
                ).all()
                for ni in note_inputs:
                    try:
                        if not ni.input_value().strip():
                            ni.fill("Delivered")
                            time.sleep(0.3)
                            print("[bridge] Filled note field: 'Delivered'")
                    except Exception:
                        pass
            except PWTimeout:
                print("[bridge] No modal visible after file attach — trying submit directly.")
            except Exception:
                pass  # non-fatal

            # ── Step 5: Click Submit / Confirm ────────────────────────────
            submit_btn = None
            for label in ["Submit", "Confirm", "OK", "确定", "提交"]:
                for sel in [
                    f"{MODAL_SEL} button:has-text('{label}')",
                    f"button:has-text('{label}')",
                ]:
                    try:
                        btn = page.locator(sel).first
                        btn.wait_for(state="visible", timeout=3000)
                        submit_btn = btn
                        print(f"[bridge] Found submit button: '{label}'")
                        break
                    except PWTimeout:
                        continue
                    except Exception:
                        continue
                if submit_btn:
                    break

            if not submit_btn:
                _dump_page_state(page, "submit-not-found")
                return {
                    "ok": False,
                    "error": (
                        "Submit/Confirm button not found in upload popup after file attach. "
                        "See PAGE DUMP above for what is visible."
                    ),
                }

            submit_btn.click()
            print("[bridge] ✅ Clicked Submit. Waiting for popup to close…")

            # ── Step 6: Wait for modal to close ───────────────────────────
            try:
                page.locator(MODAL_SEL).first.wait_for(state="hidden", timeout=15000)
                print("[bridge] ✅ Modal closed — upload accepted by Z2U.")
            except PWTimeout:
                print("[bridge] ⚠ Modal did not close in 15 s — checking for error toast.")

            # ── Step 7: Check for error toast ─────────────────────────────
            try:
                err_loc = page.locator(
                    ".ant-message-error:visible, .ant-message-warning:visible"
                ).first
                err_loc.wait_for(state="visible", timeout=2000)
                msg = err_loc.inner_text().strip()
                if msg:
                    print(f"[bridge] ❌ Z2U toast: {msg}")
                    return {"ok": False, "error": f"Z2U rejected upload: {msg[:300]}"}
            except PWTimeout:
                pass  # no error toast — good

            print("[bridge] ✅ Upload complete.")
            return {"ok": True, "message": "File uploaded via Playwright file-chooser."}

        except Exception:
            tb = traceback.format_exc()
            print(f"[bridge] ❌ Exception in do_upload:\n{tb}")
            return {"ok": False, "error": tb}


# ── Flask routes ──────────────────────────────────────────────────────────────

@app.after_request
def cors(resp):
    """Allow the Chrome extension (running on z2u.com origin) to POST here."""
    resp.headers["Access-Control-Allow-Origin"]  = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


@app.route("/debug/tabs", methods=["GET"])
def debug_tabs():
    """
    Visit http://localhost:5000/debug/tabs to instantly see every tab open in
    the CDP Chrome.  Uses Chrome's built-in /json/list endpoint — no Playwright
    needed, responds in milliseconds.

    If your Z2U order page is NOT in the list, the bridge is watching a
    different Chrome instance than the one your extension is running in.
    """
    json_url = f"{CDP_URL}/json/list"
    try:
        with urllib.request.urlopen(json_url, timeout=4) as resp:
            raw = _json.loads(resp.read())
        tabs = [
            {"url": t.get("url", ""), "title": t.get("title", ""), "type": t.get("type", "")}
            for t in raw
            if t.get("type") in ("page", "")
        ]
        z2u_tabs = [t for t in tabs if "z2u.com" in t["url"]]
        return jsonify({
            "ok": True,
            "cdp_url": CDP_URL,
            "total_tabs": len(tabs),
            "z2u_tabs": z2u_tabs,
            "all_tabs": tabs,
            "diagnosis": (
                "GOOD — bridge sees your Z2U tab." if z2u_tabs
                else (
                    "PROBLEM — no Z2U tab visible to the bridge. "
                    "The Chrome with --remote-debugging-port=9222 is NOT the same "
                    "Chrome where Z2U is open. Open Z2U in the CDP Chrome window, "
                    "or restart Chrome with --remote-debugging-port=9222 and log in to Z2U there."
                )
            ),
        })
    except OSError as e:
        return jsonify({
            "ok": False,
            "error": f"Cannot reach {json_url}: {e}",
            "diagnosis": (
                "Chrome is NOT running with --remote-debugging-port=9222, "
                "OR it is running on a different port. "
                "Start Chrome with: --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp"
            ),
        }), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/upload", methods=["OPTIONS"])
def upload_preflight():
    return "", 204


@app.route("/upload", methods=["POST"])
def upload():
    data = request.get_json(force=True, silent=True) or {}

    file_bytes_list = data.get("fileBytes")
    order_id        = data.get("orderId", "")
    page_url        = data.get("pageUrl", "")
    filename        = data.get("filename", "order_form.xlsx")

    if not file_bytes_list:
        return jsonify({"ok": False, "error": "No fileBytes in request"}), 400

    suffix   = os.path.splitext(filename)[-1] or ".xlsx"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix,
            prefix=f"z2u_{order_id}_",
        ) as tmp:
            tmp.write(bytes(file_bytes_list))
            tmp_path = tmp.name

        print(f"\n[bridge] ▶ Upload request — orderId={order_id!r}  file={filename!r}  bytes={len(file_bytes_list)}")
        result = do_upload(tmp_path, order_id, page_url)
        status = "✅" if result["ok"] else "❌"
        print(f"[bridge] {status} Result: {result}")
        return jsonify(result)

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[bridge] ❌ Unhandled error:\n{tb}")
        return jsonify({"ok": False, "error": str(e)}), 500

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


# ── Chat reply via Playwright keyboard ────────────────────────────────────────

def find_chat_page(browser):
    """Return the Playwright Page for the open Z2U Chat page."""
    all_pages = [p for ctx in browser.contexts for p in ctx.pages]
    # Exact Chat URL
    for page in all_pages:
        if "z2u.com/Chat" in page.url or "z2u.com/chat" in page.url:
            return page
    # Fallback: any z2u tab
    for page in all_pages:
        if "z2u.com" in page.url:
            return page
    return None


def do_chat_reply(username: str, message: str) -> dict:
    """
    Connect to Chrome via CDP, find the Z2U Chat tab, click the
    correct conversation sidebar item, then type the message using
    real keyboard events (isTrusted=true, delay=50ms per char).
    """
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp(CDP_URL, timeout=6000)
        except Exception as e:
            return {
                "ok": False,
                "error": f"CDP connect failed — is Chrome running with --remote-debugging-port=9222? {e}",
            }

        page = find_chat_page(browser)
        if not page:
            return {
                "ok": False,
                "error": "No Z2U Chat tab found. Open z2u.com/Chat in Chrome.",
            }

        try:
            page.bring_to_front()
        except Exception:
            pass

        print(f"[bridge/chat] Found chat page: {page.url}")

        try:
            # ── Click the sidebar item for this username ───────────────────
            if username:
                clicked = False
                # Try class-based selectors first
                sidebar_sels = [
                    "[class*='chatListItem']",
                    "[class*='chatItem']",
                    "[class*='contactItem']",
                    "[class*='userItem']",
                    "[class*='imItem']",
                    "li",
                ]
                for sel in sidebar_sels:
                    try:
                        items = page.locator(sel).all()
                        for item in items:
                            try:
                                txt = item.inner_text(timeout=300)
                                if username in txt:
                                    item.click()
                                    clicked = True
                                    print(f"[bridge/chat] Clicked sidebar for '{username}'")
                                    break
                            except Exception:
                                continue
                        if clicked:
                            break
                    except Exception:
                        continue

                if not clicked:
                    print(f"[bridge/chat] ⚠ Sidebar item for '{username}' not found — trying to type in current open chat.")

                time.sleep(0.8)  # wait for chat panel to render

            # ── Find the message input ─────────────────────────────────────
            # Priority: textarea → contenteditable → text input
            # Must NOT be inside the sidebar / search bar.
            SIDEBAR_SEL = (
                "[class*='sideBar'], [class*='sidebar'], [class*='chatList'], "
                "[class*='chat-list'], aside, nav"
            )
            chat_input = None

            for sel in [
                "textarea:visible",
                "div[contenteditable='true']:visible",
                "input[type='text']:visible",
            ]:
                candidates = page.locator(sel).all()
                for c in candidates:
                    try:
                        # Skip sidebar elements
                        in_sidebar = page.evaluate(
                            """(el) => !!el.closest(
                                "[class*='sideBar'],[class*='sidebar'],[class*='chatList'],aside,nav"
                            )""",
                            c.element_handle(),
                        )
                        if in_sidebar:
                            continue
                        # Skip search-like inputs
                        ph = (c.get_attribute("placeholder") or "").lower()
                        if any(w in ph for w in ["search", "find", "filter"]):
                            continue
                        chat_input = c
                        break
                    except Exception:
                        continue
                if chat_input:
                    break

            if not chat_input:
                return {"ok": False, "error": "Chat message input not found on page."}

            # ── Focus + click, then keyboard.type with real events ─────────
            chat_input.scroll_into_view_if_needed()
            chat_input.click()
            time.sleep(0.3)

            # keyboard.type() dispatches real KeyboardEvents via CDP —
            # the browser marks them isTrusted=true, same as hardware input.
            page.keyboard.type(message, delay=50)
            time.sleep(0.2)

            # ── Press Enter to submit ──────────────────────────────────────
            page.keyboard.press("Enter")
            time.sleep(1.0)

            # ── If the Send button is STILL visible, click it too ─────────
            send_clicked = False
            try:
                send_sels = [
                    "button[class*='send']:visible",
                    "button[aria-label*='Send']:visible",
                    "button[title*='Send']:visible",
                    "[role='button'][class*='send']:visible",
                ]
                for s in send_sels:
                    btn = page.locator(s).first
                    if btn.is_visible(timeout=800):
                        btn.click()
                        send_clicked = True
                        print("[bridge/chat] Clicked Send button.")
                        break

                # Text-based fallback
                if not send_clicked:
                    all_btns = page.locator("button:visible").all()
                    for b in all_btns:
                        try:
                            txt = b.inner_text(timeout=300).strip().lower()
                            if txt in ("send", "发送", "확인", "submit"):
                                # Make sure it's NOT in the sidebar
                                in_side = page.evaluate(
                                    "(el) => !!el.closest('[class*=\"chatList\"],aside,nav')",
                                    b.element_handle(),
                                )
                                if not in_side:
                                    b.click()
                                    send_clicked = True
                                    print(f"[bridge/chat] Clicked send button: '{txt}'")
                                    break
                        except Exception:
                            continue
            except Exception:
                pass  # Send button not found / already dismissed — that's fine

            print(f"[bridge/chat] ✅ Reply sent to '{username}': '{message[:60]}'")
            return {"ok": True, "message": f"Reply sent to {username!r} via Playwright keyboard."}

        except Exception:
            tb = traceback.format_exc()
            print(f"[bridge/chat] ❌ Exception:\n{tb}")
            return {"ok": False, "error": tb}


@app.route("/chat-reply", methods=["OPTIONS"])
def chat_reply_preflight():
    return "", 204


@app.route("/chat-reply", methods=["POST"])
def chat_reply():
    data     = request.get_json(force=True, silent=True) or {}
    username = data.get("username", "")
    message  = data.get("message", "")
    order_id = data.get("orderId", "")

    if not message:
        return jsonify({"ok": False, "error": "No message provided"}), 400
    if not username:
        return jsonify({"ok": False, "error": "No username provided"}), 400

    print(f"\n[bridge/chat] ▶ Chat-reply request — username={username!r}  orderId={order_id!r}  msg={message[:80]!r}")
    result = do_chat_reply(username, message)
    status = "✅" if result["ok"] else "❌"
    print(f"[bridge/chat] {status} Result: {result}")
    return jsonify(result)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "status": "bridge running", "port": BRIDGE_PORT})


# ── Entry point ───────────────────────────────────────────────────────────────

def _startup_chrome_check():
    """
    At startup, hit Chrome's /json/list endpoint and print a summary of open
    tabs.  This immediately tells the user whether the bridge can see Chrome
    and whether any Z2U tabs are open — without any Playwright overhead.
    """
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/list", timeout=3) as r:
            tabs = _json.loads(r.read())
        pages = [t for t in tabs if t.get("type") == "page"]
        z2u   = [t for t in pages if "z2u.com" in t.get("url", "")]
        print(f"[bridge] ✅ Chrome detected at {CDP_URL}  —  {len(pages)} tab(s), {len(z2u)} Z2U tab(s)")
        for t in pages:
            marker = "  ← Z2U ✅" if "z2u.com" in t.get("url", "") else ""
            print(f"[bridge]   {t.get('url', '?')[:90]}{marker}")
        if not z2u:
            print("[bridge] ⚠  No Z2U tab found. Open z2u.com/sellOrder in this Chrome window.")
    except OSError:
        print(f"[bridge] ⚠  Chrome NOT detected at {CDP_URL}.")
        print("[bridge]    Start Chrome with:")
        print("[bridge]      macOS  : /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\")
        print("[bridge]                 --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp")
        print("[bridge]      Windows: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\chrome-cdp")
        print("[bridge]    Then log in to Z2U in that Chrome window.")


if __name__ == "__main__":
    print("""
╔══════════════════════════════════════════════════════════════════════╗
║         Z2U Local Playwright Bridge  —  listening on :5000          ║
╚══════════════════════════════════════════════════════════════════════╝
""")
    _startup_chrome_check()
    print()
    app.run(host="127.0.0.1", port=BRIDGE_PORT, debug=False, threaded=True)
