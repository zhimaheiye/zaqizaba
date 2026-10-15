#!/usr/bin/env python3
"""Send a text message to a ChatGPT conversation via the Kimi WebBridge daemon.

Why this exists: ChatGPT's composer is a Lexical editor that ignores synthetic
input (bridge `fill`, `execCommand('insertText')`) — the DOM shows the text but
the editor state stays empty and the send button never activates. This tool
uses the daemon's `cdp` passthrough (Input.insertText + focus emulation) so the
text lands as trusted browser input.

Usage:
    python send_to_chatgpt.py --url <conversation-url> --message-file <utf8.txt> --dry-run
    python send_to_chatgpt.py --url <conversation-url> --message-file <utf8.txt> --send

Exit codes: 0 = OK, 2 = FAILED, 3 = UNKNOWN (send outcome unconfirmed; never retry automatically)
"""

import argparse
import json
import sys
import time
import urllib.request
from urllib.parse import urlparse

DAEMON = "http://127.0.0.1:10086/command"
DEFAULT_SESSION = "chatgpt-handoff"
COMPOSER_SEL = '#prompt-textarea'

# ChatGPT's send button has no data-testid on current builds; it is
# form button[type=submit] with aria-label 发送/Send. The stop button shares
# the slot while streaming, so exclude it explicitly.
FIND_SEND_BTN_JS = """(() => {
  const bad = /stop|停止|听写|语音|dictate/i;
  return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('#composer-submit-button')
      || [...document.querySelectorAll('form button[type="submit"]')]
           .find(b => !bad.test(b.getAttribute('aria-label') || ''))
      || null;
})()"""


def call(action, args=None, session=DEFAULT_SESSION, timeout=30):
    payload = {"action": action, "session": session}
    if args:
        payload["args"] = args
    req = urllib.request.Request(
        DAEMON,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read().decode("utf-8"))
    if not out.get("ok"):
        err = out.get("error", out)
        raise RuntimeError("%s failed: %s" % (action, json.dumps(err, ensure_ascii=True)))
    return out["data"]


def cdp(method, params, session):
    return call("cdp", {"method": method, "params": params}, session)


def evaluate(js, session):
    data = call("evaluate", {"code": js}, session)
    value = data.get("value")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            pass
    return value


def key_event(session, key, code, vk, mods=0, down=True):
    event = {"type": "keyDown" if down else "keyUp", "key": key, "code": code,
             "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
    if mods:
        event["modifiers"] = mods
    cdp("Input.dispatchKeyEvent", event, session)


def press(session, key, code, vk, mods=0):
    key_event(session, key, code, vk, mods, down=True)
    key_event(session, key, code, vk, mods, down=False)


def same_target(actual, wanted):
    a, w = urlparse(actual), urlparse(wanted)
    if a.hostname and a.hostname.split(":")[0] not in ("chatgpt.com", "www.chatgpt.com"):
        return False
    if w.hostname and w.hostname.split(":")[0] not in ("chatgpt.com", "www.chatgpt.com"):
        raise SystemExit("--url must be a chatgpt.com address")
    wa, ww = a.path.rstrip("/"), w.path.rstrip("/")
    if ww.startswith("/c/"):
        return wa == ww
    return wa == ww  # new chat: match exact path (e.g. "/" or "/?model=..." ignored)


def open_tab(url, session):
    """Open or re-select the session's own tab. Never borrows the user's tab."""
    try:
        tabs = call("list_tabs", session=session).get("tabs", [])
    except RuntimeError:
        tabs = []
    for t in tabs:
        if same_target(t.get("url", ""), url):
            call("find_tab", {"url": url}, session)
            return "reused"
    call("navigate", {"url": url, "group_title": "agent:%s" % session}, session)
    return "opened"


COMPOSER_STATE_JS = """(() => {
  const c = document.querySelector('%s') || document.querySelector('form [contenteditable="true"]');
  const b = (%s);
  return JSON.stringify({
    found: !!c,
    editable: c ? c.isContentEditable : false,
    len: c ? c.innerText.replace(/\\u200b/g, "").trim().length : -1,
    sendFound: !!b,
    sendEnabled: !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true',
    href: location.href
  });
})()""" % (COMPOSER_SEL, FIND_SEND_BTN_JS)


def composer_state(session):
    return evaluate(COMPOSER_STATE_JS, session)


def wait_composer(session, timeout=25):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = composer_state(session)
        if last and last.get("found") and last.get("editable"):
            return last
        time.sleep(1)
    raise RuntimeError("composer not ready: %s" % json.dumps(last, ensure_ascii=True))


def check_page(url, session):
    state = composer_state(session)
    href = (state or {}).get("href", "")
    if not same_target(href, url):
        raise RuntimeError("tab is not on the target URL: %s" % href)


def focus_composer(session):
    evaluate("""(() => {
      const c = document.querySelector('%s') || document.querySelector('form [contenteditable="true"]');
      if (!c) return 'no composer';
      c.focus();
      const sel = document.getSelection();
      if (sel && c.contains(sel.anchorNode)) { sel.selectAllChildren(c); sel.collapseToEnd(); }
      return 'focused';
    })()""" % COMPOSER_SEL, session)


def insert_text_trusted(text, session):
    cdp("Emulation.setFocusEmulationEnabled", {"enabled": True}, session)
    focus_composer(session)
    cdp("Input.insertText", {"text": text}, session)


def wait_send_button(session, timeout=6):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = composer_state(session)
        if last and last.get("sendEnabled"):
            return True, last
        time.sleep(0.5)
    return False, last


def clear_composer_trusted(session):
    """Ctrl+A + Delete via trusted key events; verify empty afterwards."""
    focus_composer(session)
    press(session, "a", "KeyA", 65, mods=2)
    press(session, "Backspace", "Backspace", 8)
    time.sleep(0.5)
    state = composer_state(session)
    return (state or {}).get("len", -1)


def send_click(session):
    result = evaluate("""(() => {
      const b = (%s);
      if (!b) return {clicked: false, reason: 'no button'};
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return {clicked: false, reason: 'disabled'};
      b.click();
      return {clicked: true};
    })()""" % FIND_SEND_BTN_JS, session)
    return result or {}


def turn_stats(session, marker):
    # Current ChatGPT builds render messages without article tags,
    # data-message-id or conversation-turn-* testids, so confirm from
    # DOM-agnostic signals: composer emptied + the message text showing up
    # in the transcript (main.innerText), or streaming indicators.
    return evaluate("""(() => {
      const m = document.querySelector('main');
      const c = document.querySelector('%s') || document.querySelector('form [contenteditable="true"]');
      const streaming = !!document.querySelector('.result-streaming')
                     || !!document.querySelector('[data-testid="stop-button"]');
      const mainText = m ? m.innerText : '';
      const composerText = c ? c.innerText : '';
      return JSON.stringify({
        streaming: streaming,
        composerLen: composerText.trim().length,
        markerInMain: mainText.indexOf(%s) >= 0,
        mainLen: mainText.length
      });
    })()""" % (COMPOSER_SEL, json.dumps(marker)), session)


def main():
    ap = argparse.ArgumentParser(description="Send text to a ChatGPT conversation via Kimi WebBridge (trusted CDP input).")
    ap.add_argument("--url", required=True, help="ChatGPT conversation URL (chatgpt.com)")
    ap.add_argument("--message-file", required=True, help="UTF-8 text file with the message")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="verify text entry + send button only; clears the draft afterwards")
    mode.add_argument("--send", action="store_true", help="actually send after verification")
    ap.add_argument("--session", default=DEFAULT_SESSION, help="WebBridge session name (default: %s)" % DEFAULT_SESSION)
    args = ap.parse_args()

    with open(args.message_file, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        print(json.dumps({"status": "FAILED", "error": "message file is empty"}, ensure_ascii=True))
        sys.exit(2)

    result = {"status": "FAILED", "session": args.session, "url": args.url, "steps": {}}
    emulation_on = False
    try:
        result["steps"]["tab"] = open_tab(args.url, args.session)
        state = wait_composer(args.session)
        result["steps"]["page"] = {"href": state.get("href", "")}
        check_page(args.url, args.session)

        state = composer_state(args.session)
        if state["len"] > 2:
            raise RuntimeError("composer has an existing draft (len=%d); refusing to overwrite" % state["len"])
        result["steps"]["composer_clean"] = True

        insert_text_trusted(text, args.session)
        emulation_on = True
        activated, after = wait_send_button(args.session)
        result["steps"]["insert"] = {
            "text_len": len(text),
            "composer_len": after.get("len") if after else None,
            "send_button_active": activated,
        }
        if not activated:
            result["status"] = "FAILED"
            result["error"] = "send button did not activate after trusted input; Lexical did not accept the text"
            sys.exit(2)

        if args.dry_run:
            leftover = clear_composer_trusted(args.session)
            result["steps"]["cleanup"] = {"composer_len_after_clear": leftover}
            result["status"] = "OK"
            result["note"] = "dry-run: text accepted by Lexical, send button active; draft cleared; nothing sent"
            print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
            sys.exit(0)

        marker = max(text.splitlines(), key=len).strip()[:40] if text.strip() else ""
        before = turn_stats(args.session, marker) or {}
        clicked = send_click(args.session)
        result["steps"]["click"] = clicked
        if not clicked.get("clicked"):
            result["status"] = "UNKNOWN"
            result["error"] = "send button click did not go through: %s" % clicked.get("reason")
            print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
            sys.exit(3)

        deadline = time.time() + 20
        confirmed = False
        now = before
        while time.time() < deadline:
            time.sleep(2)
            now = turn_stats(args.session, marker) or {}
            if now.get("streaming") or (now.get("composerLen", 99) <= 2 and now.get("markerInMain")):
                confirmed = True
                break
        result["steps"]["confirm"] = {
            "marker": marker,
            "mainLen_before": before.get("mainLen"),
            "mainLen_after": now.get("mainLen"),
            "streaming": now.get("streaming"),
            "markerInMain": now.get("markerInMain"),
            "composerLen": now.get("composerLen"),
        }
        result["status"] = "SENT" if confirmed else "UNKNOWN"
        if not confirmed:
            result["error"] = "no new conversation turn appeared within 20s; do NOT retry automatically"
        print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
        sys.exit(0 if confirmed else 3)

    except SystemExit as e:
        raise
    except Exception as e:
        result["error"] = str(e)
        print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
        sys.exit(2)
    finally:
        if emulation_on:
            try:
                cdp("Emulation.setFocusEmulationEnabled", {"enabled": False}, args.session)
            except Exception:
                pass


if __name__ == "__main__":
    main()
