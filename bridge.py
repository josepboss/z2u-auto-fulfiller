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
    Connect to Chrome via CDP, find the Z2U tab, and upload the XLSX file
    using Playwright's native set_input_files().
    """
    with sync_playwright() as pw:
        # ── Connect to the running Chrome instance ────────────────────────
        try:
            browser = pw.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            return {
                "ok": False,
                "error": (
                    f"CDP connection failed. "
                    f"Is Chrome running with --remote-debugging-port=9222? "
                    f"Detail: {e}"
                ),
            }

        # ── Find the right tab ────────────────────────────────────────────
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
            pass  # non-fatal

        print(f"[bridge] Found Z2U page: {page.url}")

        try:
            # ── Click the "Upload Form" button to open the modal ─────────
            upload_btn = None
            for label in ["Upload Form", "Upload Delivery", "Batch Upload"]:
                try:
                    btn = page.get_by_role("button", name=label, exact=False)
                    btn.wait_for(state="visible", timeout=2000)
                    upload_btn = btn
                    print(f"[bridge] Found upload button: '{label}'")
                    break
                except PWTimeout:
                    continue
                except Exception:
                    continue

            # Wider fallback: any visible button whose text contains "upload"
            if not upload_btn:
                try:
                    btns = page.locator("button:visible").all()
                    for b in btns:
                        txt = b.inner_text().strip().lower()
                        if "upload" in txt:
                            upload_btn = b
                            print(f"[bridge] Found upload button via text scan: '{txt}'")
                            break
                except Exception:
                    pass

            if upload_btn:
                upload_btn.click()
                time.sleep(1.5)  # wait for modal animation
            else:
                print("[bridge] No 'Upload Form' button found — file input may already be visible.")

            # ── Locate the file input ─────────────────────────────────────
            # Z2U's upload inputs are sometimes hidden; set_input_files works
            # on hidden inputs too — we only need "attached", not "visible".
            file_input = page.locator(
                "input[type='file']"
                ":not([id*='filepond'])"
                ":not([name*='order_before'])"
                ":not([name*='order_after'])"
            ).first

            try:
                file_input.wait_for(state="attached", timeout=7000)
            except PWTimeout:
                return {
                    "ok": False,
                    "error": "File input not found on the Z2U page after 7 s.",
                }

            print(f"[bridge] Attaching file: {tmp_path}")
            file_input.set_input_files(tmp_path)
            time.sleep(0.8)

            # ── Fill required note / text fields in the modal ─────────────
            try:
                modal = page.locator(
                    ".ant-modal-content, .modal, [role='dialog'], [class*='modal']"
                ).first
                note_inputs = modal.locator(
                    "textarea:visible, input[type='text']:visible"
                ).all()
                for ni in note_inputs:
                    try:
                        if not ni.input_value():
                            ni.fill("Delivered")
                            time.sleep(0.3)
                    except Exception:
                        pass
            except Exception:
                pass  # non-fatal

            # ── Click SUBMIT ──────────────────────────────────────────────
            submit_btn = None
            for label in ["Submit", "SUBMIT", "Confirm", "OK"]:
                try:
                    btn = page.get_by_role("button", name=label, exact=True)
                    btn.wait_for(state="visible", timeout=3000)
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
                    "error": "SUBMIT button not found in upload modal.",
                }

            submit_btn.click()
            print("[bridge] Clicked SUBMIT — waiting for modal to close…")
            time.sleep(3)  # give Z2U time to process the upload

            # ── Check for Z2U error toast ─────────────────────────────────
            try:
                err_loc = page.locator(
                    ".ant-message-error:visible, .ant-message-warning:visible, "
                    "[class*='error']:visible, [class*='Error']:visible"
                ).first
                err_loc.wait_for(state="visible", timeout=1500)
                msg = err_loc.inner_text().strip()
                if msg:
                    return {"ok": False, "error": f"Z2U error after submit: {msg[:300]}"}
            except PWTimeout:
                pass  # no error toast — good

            print("[bridge] ✅ Upload complete.")
            return {"ok": True, "message": "File uploaded via Playwright CDP."}

        except Exception:
            tb = traceback.format_exc()
            print(f"[bridge] ❌ Exception:\n{tb}")
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
