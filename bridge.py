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

from flask import Flask, jsonify, request
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ── Configuration ─────────────────────────────────────────────────────────────
CDP_URL     = "http://localhost:9222"   # Chrome remote debugging endpoint
BRIDGE_PORT = 5000                      # Port the extension POSTs to
# ─────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def find_z2u_page(browser, order_id: str, page_url: str):
    """
    Return the Playwright Page for the open Z2U order-detail page.
    Priority:
      1. Exact URL match
      2. URL contains the orderId
      3. URL contains z2u.com/sellOrder (any detail page)
      4. URL contains z2u.com (fallback)
    """
    all_pages = [p for ctx in browser.contexts for p in ctx.pages]

    for page in all_pages:
        if page_url and page.url == page_url:
            return page

    for page in all_pages:
        if order_id and order_id in page.url:
            return page

    for page in all_pages:
        if "z2u.com/sellOrder" in page.url and "/index" not in page.url:
            return page

    for page in all_pages:
        if "z2u.com" in page.url:
            return page

    return None


def do_upload(tmp_path: str, order_id: str, page_url: str) -> dict:
    """
    Connect to Chrome via CDP, find the Z2U tab, and upload the XLSX file.

    Strategy:
      1. Click the green "Upload Form" button using has-text selectors.
      2. Intercept the native OS file-chooser via expect_file_chooser().
         Z2U's button triggers a real file-chooser dialog — this is why
         set_input_files() on the hidden <input> didn't work. The file-chooser
         intercept captures that dialog and sets the file path directly.
      3. Fill the note textarea ("Delivered").
      4. Click Submit / Confirm inside the popup.
      5. Wait for the modal to close (button removed from DOM).

    tmp_path on macOS will be a POSIX path such as
      /var/folders/.../z2u_ORDER_abc.xlsx
    which is exactly what Playwright expects on Mac.
    """
    with sync_playwright() as pw:
        # ── Connect ───────────────────────────────────────────────────────
        try:
            browser = pw.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            return {
                "ok": False,
                "error": (
                    f"CDP connection failed — is Chrome running with "
                    f"--remote-debugging-port=9222? Detail: {e}"
                ),
            }

        # ── Find the order-detail tab ─────────────────────────────────────
        page = find_z2u_page(browser, order_id, page_url)
        if not page:
            return {
                "ok": False,
                "error": (
                    "No Z2U tab found in Chrome. "
                    "Open z2u.com/sellOrder and navigate to the order detail page."
                ),
            }

        try:
            page.bring_to_front()
        except Exception:
            pass

        print(f"[bridge] Found Z2U page: {page.url}")
        print(f"[bridge] File to upload (POSIX path): {tmp_path}")

        try:
            # ── Step 1: Locate the "Upload Form" green button ─────────────
            # Z2U renders it as either an <a> or <button> depending on page version.
            UPLOAD_BTN_SEL = (
                "a:has-text('Upload Form'), "
                "button:has-text('Upload Form'), "
                "a:has-text('Upload Delivery'), "
                "button:has-text('Upload Delivery'), "
                "a:has-text('Batch Upload'), "
                "button:has-text('Batch Upload')"
            )

            try:
                page.wait_for_selector(UPLOAD_BTN_SEL, state="visible", timeout=8000)
            except PWTimeout:
                # Dump all visible button/link texts to help debug
                all_texts = []
                try:
                    els = page.locator("button:visible, a:visible").all()
                    all_texts = [e.inner_text().strip() for e in els if e.inner_text().strip()]
                except Exception:
                    pass
                msg = f"Selector Not Found — 'Upload Form' button not visible after 8 s. Visible buttons/links: {all_texts}"
                print(f"[bridge] ❌ {msg}")
                return {"ok": False, "error": msg}

            print("[bridge] ✅ 'Upload Form' button found. Opening file chooser…")

            # ── Step 2: Click button + intercept native OS file-chooser ───
            # expect_file_chooser() captures the browser's native file-picker
            # event that Z2U's button triggers. This is the only reliable way
            # to attach a file when the <input type="file"> is hidden/display:none.
            with page.expect_file_chooser(timeout=8000) as fc_info:
                page.click(UPLOAD_BTN_SEL)

            file_chooser = fc_info.value
            file_chooser.set_files(tmp_path)
            print(f"[bridge] ✅ File chooser resolved — set: {tmp_path}")
            time.sleep(1.0)  # let Z2U's React state update after file selection

            # ── Step 3: Fill the required "Note" textarea in the popup ────
            MODAL_SEL = (
                ".ant-modal-content, [role='dialog'], "
                "[class*='modal'], [class*='Modal'], [class*='dialog']"
            )
            try:
                modal = page.locator(MODAL_SEL).first
                modal.wait_for(state="visible", timeout=5000)
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
                print("[bridge] No modal visible after file selection — proceeding to submit.")
            except Exception:
                pass  # non-fatal

            # ── Step 4: Click Submit / Confirm in the popup ───────────────
            submit_btn = None
            for label in ["Submit", "Confirm", "OK", "确定"]:
                try:
                    # Look inside modal first, then globally
                    btn = page.locator(
                        f"{MODAL_SEL} button:has-text('{label}'), "
                        f"button:has-text('{label}')"
                    ).first
                    btn.wait_for(state="visible", timeout=4000)
                    submit_btn = btn
                    print(f"[bridge] Found submit button: '{label}'")
                    break
                except PWTimeout:
                    continue
                except Exception:
                    continue

            if not submit_btn:
                return {
                    "ok": False,
                    "error": "Submit/Confirm button not found in upload popup after file selection.",
                }

            submit_btn.click()
            print("[bridge] ✅ Clicked Submit. Waiting for popup to close…")

            # ── Step 5: Wait for modal to disappear (upload accepted) ─────
            try:
                page.locator(MODAL_SEL).first.wait_for(state="hidden", timeout=12000)
                print("[bridge] ✅ Modal closed — upload accepted by Z2U.")
            except PWTimeout:
                # Check for error toast before giving up
                pass

            # ── Step 6: Check for error toast ─────────────────────────────
            try:
                err_loc = page.locator(
                    ".ant-message-error:visible, .ant-message-warning:visible"
                ).first
                err_loc.wait_for(state="visible", timeout=2000)
                msg = err_loc.inner_text().strip()
                if msg:
                    print(f"[bridge] ❌ Z2U error toast: {msg}")
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
            browser = pw.chromium.connect_over_cdp(CDP_URL)
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

if __name__ == "__main__":
    print("""
╔══════════════════════════════════════════════════════════════════════╗
║         Z2U Local Playwright Bridge  —  listening on :5000          ║
╚══════════════════════════════════════════════════════════════════════╝

Before sending any orders, make sure Chrome is running with:
  --remote-debugging-port=9222

  Windows : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
              --remote-debugging-port=9222 --user-data-dir=C:\\chrome-cdp
  macOS   : /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome
              --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp
  Linux   : google-chrome --remote-debugging-port=9222
              --user-data-dir=/tmp/chrome-cdp

Log in to Z2U in that Chrome window and leave it open.

Waiting for the extension…
""")
    app.run(host="127.0.0.1", port=BRIDGE_PORT, debug=False, threaded=True)
