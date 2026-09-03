"""Robot Framework listener that gives an RF Browser Library suite the same
temporal provocation Playwright users get from flakeproof/inject's
withTemporal wrapper - without the user changing a single .robot file.

Usage: attach the listener on the robot command line,

    robot --listener /path/to/FlakeproofTemporalListener.py suite.robot

and set the SAME three environment variables the Playwright wrapper honors
(src/inject/playwright.js, src/triage/temporal-probe.js):

    FLAKEPROOF_TEMPORAL_SELECTOR   css selector to delay
    FLAKEPROOF_TEMPORAL_MS         delay in milliseconds
    FLAKEPROOF_TEMPORAL_ACK        directory to write ack receipts into

Without all three set and valid, this listener does nothing - the same
"inert unless opted in" contract withTemporal follows, so it is safe to leave
attached to every run permanently.

Why a listener, and not a keyword library the user calls explicitly, and not
a Browser Library plugin: investigated and ruled out, in that order.

  - robotframework-browser (the Browser library) exposes NO init-script hook
    at all. `New Context`'s full keyword signature has no such parameter;
    `Evaluate JavaScript` runs in the CURRENT page, after it has already
    navigated and loaded; `Add Style Tag` behaves the same way. None of them
    are Playwright's `context.addInitScript()`, which fires before the
    page's own scripts run, on every navigation, in every frame. (Checked
    against the installed robotframework-browser source directly - see this
    cycle's report for the exact keywords inspected.)
  - A Browser Library "plugin" (the library's own extension mechanism) only
    adds new Python-side KEYWORDS composed from the same grpc surface the
    keywords above already expose; it cannot add a new primitive to the
    library's own Node/Playwright wrapper process without patching that
    vendored dependency, which is out of scope here.
  - The Chrome DevTools Protocol escape hatch used for the Selenium adapter
    in this same change (`Page.addScriptToEvaluateOnNewDocument`) is not
    available here either: the Browser library owns the actual Playwright
    connection inside its own Node subprocess, and does not expose a raw CDP
    session to the Python side the way selenium-webdriver's
    `createCDPConnection` does.

Given that, a listener reacting right after `New Page`/`Go To` finishes is
the closest available approximation, with two consequences the Playwright
version does not have:

  - It cannot delay the page's INITIAL paint the way a true init script
    would (the page has already fully loaded by the time `New Page`
    returns). What it CAN do - and what actually matters for provoking a
    "missing wait" failure - is install the hiding rule before the very next
    keyword in the test gets a chance to observe the anchor element. Proven
    empirically against this repo's fixture page (see this cycle's report):
    a `Wait For Elements State ... visible` called immediately afterward
    measurably waits for the requested delay, because the browser applies a
    freshly added CSS rule immediately regardless of when it was added.
  - Only the main document of the page open at injection time is covered -
    an iframe, or a page opened without an intervening `New Page`/`Go To`
    call, would need its own injection point this listener does not reach
    for.

Evidence contract: this listener writes to FLAKEPROOF_TEMPORAL_ACK with the
exact JSON shape src/triage/temporal-probe.js already reads
(`{"installed": true, "count": N|null, "ruleLive": true|false|null}`), one
uniquely named file per write - mirrors src/inject/playwright.js's
directory-based, one-writer-per-file scheme, so a later report is never lost
to an earlier one overwriting it, and temporal-probe.js needed no changes at
all to read this listener's receipts.

Two reports are written per injection, matching the two-report pattern
src/probe/temporal.js documents for Playwright: an immediate one (taken
right when the hiding rule is installed) and a later one taken after the
delay window has closed - a single early reading would be blind to an anchor
that renders after injection but the recount at window-close still catches
it. The second report runs on a background timer thread (Robot Framework's
own main thread is busy running the suite's next keywords while the delay is
in effect) and reads back a value the injected script stashed on `window`
itself, via its own `Evaluate JavaScript` call; if the page or browser has
already closed by then, that call fails and is caught - the first report's
receipt still stands, never a fabricated final answer.

A failure anywhere in this listener is caught and swallowed: it must never
break the user's suite.
"""

import json
import os
import threading
import uuid

from robot.api import logger
from robot.libraries.BuiltIn import BuiltIn

ROBOT_LISTENER_API_VERSION = 3

_TRIGGER_KEYWORDS = frozenset({"New Page", "Go To"})

# Installs the hiding rule and returns immediately (does NOT await the
# delay) so the calling keyword returns fast and the suite's next keyword
# runs while the delay is still in effect - see module docstring. The first
# report is taken at install time; `window.__flakeproofTemporalResult` is
# updated again when the delay window closes, for the listener's later,
# separate read-back call.
_INSTALL_SCRIPT = """(arg) => {
  const { selector, ms } = arg;
  const style = document.createElement('style');
  style.textContent = selector + ' { visibility: hidden !important; }';
  const attach = () => {
    if (document.documentElement) { document.documentElement.appendChild(style); return true; }
    return false;
  };
  if (!attach()) {
    new MutationObserver((records, observer) => {
      if (attach()) observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  }
  let count = null;
  try { count = document.querySelectorAll(selector).length; } catch (e) { count = null; }
  let ruleLive = null;
  try { ruleLive = !!style.sheet && style.sheet.cssRules.length === 1; } catch (e) { ruleLive = null; }
  window.__flakeproofTemporalResult = { count, ruleLive };
  window.setTimeout(() => {
    let c2 = null;
    try { c2 = document.querySelectorAll(selector).length; } catch (e) { c2 = null; }
    let r2 = null;
    try { r2 = !!style.sheet && style.sheet.cssRules.length === 1; } catch (e) { r2 = null; }
    window.__flakeproofTemporalResult = { count: c2, ruleLive: r2 };
    style.remove();
  }, ms);
  return { count, ruleLive };
}"""

_READBACK_SCRIPT = "() => window.__flakeproofTemporalResult || null"


def _write_ack(ack_dir, payload):
    if not ack_dir:
        return
    try:
        os.makedirs(ack_dir, exist_ok=True)
        file_name = "%d-%s.json" % (os.getpid(), uuid.uuid4().hex)
        with open(os.path.join(ack_dir, file_name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except OSError:
        # Failing to write a receipt must never break the user's suite.
        pass


class FlakeproofTemporalListener:
    """Requires Robot Framework >= 7.0, where the listener v3 `end_keyword`
    signature became `(data, result)` with `result` a real
    `robot.result.model.Keyword` object (`.name`, `.owner`, `.status`) -
    the pre-7.0 `(name, attrs)` dict-based signature is not supported here.
    Verified against Robot Framework 7.4.2 (see this cycle's report).
    """

    ROBOT_LISTENER_API_VERSION = 3

    def end_keyword(self, data, result):
        if result.status != "PASS":
            return
        if result.owner != "Browser":
            return
        if result.name not in _TRIGGER_KEYWORDS:
            return

        selector = os.environ.get("FLAKEPROOF_TEMPORAL_SELECTOR")
        ms_raw = os.environ.get("FLAKEPROOF_TEMPORAL_MS")
        if not selector or not ms_raw:
            return
        try:
            ms = float(ms_raw)
        except ValueError:
            return
        if ms <= 0:
            return

        ack_dir = os.environ.get("FLAKEPROOF_TEMPORAL_ACK")
        # Proves installation was attempted before anything else can go
        # wrong below - the same honesty guarantee src/inject/playwright.js
        # gives with its own initial ack.
        _write_ack(ack_dir, {"installed": True, "count": None, "ruleLive": None})

        try:
            browser = BuiltIn().get_library_instance("Browser")
        except RuntimeError:
            _write_ack(
                ack_dir,
                {"installed": True, "count": None, "ruleLive": None, "error": "no-browser-library-instance"},
            )
            return

        try:
            first = browser.evaluate_javascript(None, _INSTALL_SCRIPT, arg={"selector": selector, "ms": ms})
        except Exception as err:  # noqa: BLE001 - must never propagate into the suite
            logger.debug("flakeproof temporal injection failed: %s" % err)
            return

        if isinstance(first, dict):
            _write_ack(ack_dir, {"installed": True, "count": first.get("count"), "ruleLive": first.get("ruleLive")})

        def read_back():
            try:
                final = browser.evaluate_javascript(None, _READBACK_SCRIPT)
            except Exception as err:  # noqa: BLE001 - the page/browser may already be gone
                logger.debug("flakeproof temporal read-back failed: %s" % err)
                return
            if isinstance(final, dict):
                _write_ack(ack_dir, {"installed": True, "count": final.get("count"), "ruleLive": final.get("ruleLive")})

        # The delay is still running in the page; read the final state back
        # once it has had time to close, from a background thread so the
        # suite's own next keyword is never blocked by this listener.
        timer = threading.Timer((ms / 1000.0) + 0.2, read_back)
        timer.daemon = True
        timer.start()
