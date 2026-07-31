"""Centralized browser stealth patches — free bot-detection mitigations.

Applied once per context via apply_stealth(ctx). Patches 10+ headless signals
that LinkedIn, Indeed, Naukri, and Internshala probe before showing content.
All platforms call this instead of maintaining their own inline scripts.
"""
from __future__ import annotations
import json
import os
import random


def _lock_owner_alive(lock_path: str) -> bool:
    """Best-effort: is the process named in SingletonLock's target still running?

    Chromium's SingletonLock on Linux is a symlink whose target looks like
    "<hostname>-<pid>". If we can parse a pid and it's still alive, the
    profile really is in use right now (e.g. by a concurrent apply-run
    Chromium on the same profile dir) and removing the lock would let a
    second Chromium instance start against it, corrupting both. Any
    uncertainty (not a symlink, unparseable, cross-platform target format)
    falls back to "not confirmed alive" — preserving this function's original
    job of clearing genuinely stale locks left by a hard crash.
    """
    try:
        target = os.readlink(lock_path)
    except OSError:
        return False  # not a symlink (or doesn't exist) — nothing to protect
    pid_str = target.rsplit("-", 1)[-1]
    if not pid_str.isdigit():
        return False
    try:
        os.kill(int(pid_str), 0)  # signal 0: existence check, doesn't actually signal
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return False  # e.g. PermissionError — treat as "can't confirm", not "alive"


def clear_stale_lock(profile_dir: str) -> None:
    """Remove Chrome's process-singleton markers before launching on a
    persistent profile. Automated runs get killed (redeploy, OOM, crash)
    without a graceful browser shutdown, which leaves these pointing at a
    dead process — Chromium then refuses to start at all, reporting the
    profile "in use by another process" even though nothing is running.

    Skips removal if the lock's owning process is confirmed still alive —
    i.e. the profile genuinely is in use right now, not just left behind by a
    crash — so this doesn't yank the lock out from under a real concurrent
    session on the same profile dir (e.g. connect_service racing an in-flight
    apply run for the same user)."""
    lock_path = os.path.join(profile_dir, "SingletonLock")
    if _lock_owner_alive(lock_path):
        return
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.remove(os.path.join(profile_dir, name))
        except OSError:
            pass

# Comprehensive init script — runs in every page before any site JS executes.
_STEALTH_SCRIPT = """
(function () {
    // 1. Remove the automation flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Realistic Chrome runtime (absent in headless by default)
    window.chrome = {
        app: { isInstalled: false, InstallState: {}, RunningState: {} },
        runtime: {
            OnInstalledReason: {}, OnRestartRequiredReason: {},
            PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {},
            RequestUpdateCheckStatus: {},
            id: undefined,
        },
        loadTimes: function () { return {}; },
        csi: function () { return {}; },
    };

    // 3. Realistic plugins list (headless = 0 plugins — dead giveaway)
    const fakeMT = { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
    const fakePlugin = { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, item: function(i){ return i === 0 ? fakeMT : null; }, namedItem: function(n){ return n === fakeMT.type ? fakeMT : null; } };
    Object.defineProperty(navigator, 'plugins', {
        get: () => { const a = [fakePlugin]; a.item = function(i){ return a[i] ?? null; }; a.namedItem = function(n){ return a.find(p => p.name === n) ?? null; }; a.refresh = function(){}; a.length = a.length; return a; }
    });

    // 4. Realistic languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi-IN'] });

    // 5. Permissions API — mask notification query
    if (window.Permissions && window.Permissions.prototype.query) {
        const orig = window.Permissions.prototype.query.bind(window.Permissions.prototype);
        window.Permissions.prototype.query = function(params) {
            if (params && params.name === 'notifications') {
                return Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default') });
            }
            return orig(params);
        };
    }

    // 6. navigator.hardwareConcurrency + deviceMemory
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); } catch (_) {}

    // 7. Remove playwright-internal globals
    try { delete window.__playwright; } catch (_) {}
    try { delete window.__pw_manual; } catch (_) {}
    try { delete window.__PW_inspect; } catch (_) {}
    try { delete window.__pwInitScripts; } catch (_) {}

    // 8. Subtle canvas noise — each session gets a tiny unique shift
    (function () {
        const shift = (Math.random() * 4 - 2) | 0;
        const origToData = HTMLCanvasElement.prototype.toDataURL;
        const origGetImg  = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.getImageData;
        HTMLCanvasElement.prototype.toDataURL = function (type) {
            const ctx2d = this.getContext('2d');
            if (ctx2d && this.width > 0 && this.height > 0) {
                const pix = ctx2d.getImageData(0, 0, 1, 1);
                pix.data[0] = Math.max(0, Math.min(255, pix.data[0] + shift));
                ctx2d.putImageData(pix, 0, 0);
            }
            return origToData.apply(this, arguments);
        };
    })();

    // 9. Mask outdated outerWidth/Height = 0 (common headless tell)
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth });
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 88 });
    }

    // 10. navigator.vendor — Chrome sets this
    try { Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' }); } catch (_) {}

    // 11. WebGL renderer/vendor — randomise per session to break shared-IP fingerprint clustering
    (function () {
        const combos = [
            ['Intel Inc.', 'Intel Iris OpenGL Engine'],
            ['NVIDIA Corporation', 'ANGLE (NVIDIA GeForce GTX 1060 Direct3D11 vs. OpenGL ES 3.1)'],
            ['AMD', 'ANGLE (AMD Radeon RX 580 Direct3D11 vs. OpenGL ES 3.1)'],
            ['Intel Inc.', 'ANGLE (Intel HD Graphics 620 Direct3D11 vs. OpenGL ES 3.1)'],
        ];
        const pair = combos[Math.floor(Math.random() * combos.length)];
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return pair[0];
            if (param === 37446) return pair[1];
            return getParam.apply(this, arguments);
        };
        const getParam2 = WebGL2RenderingContext && WebGL2RenderingContext.prototype.getParameter;
        if (getParam2) {
            WebGL2RenderingContext.prototype.getParameter = function (param) {
                if (param === 37445) return pair[0];
                if (param === 37446) return pair[1];
                return getParam2.apply(this, arguments);
            };
        }
    })();
})();
"""

_VIEWPORTS = [
    {"width": 1280, "height": 800},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
    {"width": 1920, "height": 1080},
]

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]


def apply_stealth(ctx) -> None:
    """Patch a Playwright context with all stealth mitigations."""
    try:
        ctx.add_init_script(_STEALTH_SCRIPT)
    except Exception as e:
        print(f"[stealth] init script failed: {e}")


def random_viewport() -> dict:
    return random.choice(_VIEWPORTS)


def random_ua() -> str:
    return random.choice(_USER_AGENTS)


# One browser identity per saved login, chosen once and then never changed.
#
# Randomising the user agent per launch is right for an ephemeral context (see
# channel_ats, which holds no account) and wrong — actively destructive — for a
# PERSISTENT profile. Internshala's session is bound to the device that created
# it, so a login saved as "Windows / Chrome 124" and reused an hour later as
# "macOS / Chrome 125" is a session presented from a different machine: the
# server drops it, and the agent reports "not signed in" on a session the user
# completed minutes ago. Four of five launches drew a different UA than the one
# the connect flow logged in with, and the daily public fetch runs on the same
# profile, so the session was being re-rolled several times a day.
#
# It is also the opposite of stealth. A real browser does not change operating
# system between visits while carrying the same cookies; a stable identity is
# the quiet one.
_IDENTITY_FILE = "grindly_identity.json"


def _read_identity(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:  # noqa: BLE001
        return None
    ua = data.get("user_agent")
    vp = data.get("viewport")
    if not isinstance(ua, str) or not ua.startswith("Mozilla/"):
        return None
    if not isinstance(vp, dict) or not vp.get("width") or not vp.get("height"):
        return None
    return {"user_agent": ua, "viewport": {"width": vp["width"], "height": vp["height"]}}


# What a job application never needs to download. Blocking these is the single
# biggest resource win available on a one-core box: an ATS careers page ships
# hero photography, an icon font, a video loop and a tracker bundle, none of
# which affect whether a form can be read, filled or submitted.
#
# Deliberately NOT blocked: stylesheets. Playwright's `is_visible()` — which
# read_fields leans on to skip react-select's hidden twin inputs — is decided
# by computed style, so blocking CSS makes every control look visible and the
# form unreadable. Scripts stay too: these forms ARE the script.
_BLOCKED_RESOURCE_TYPES = frozenset({"image", "media", "font"})


def block_heavy_resources(page_or_context) -> bool:
    """Refuse images, media and fonts for the rest of this page's life.

    Returns whether the route was installed; a failure here is never worth
    losing an application over, so the caller carries on with a heavier page.
    """
    try:
        page_or_context.route(
            "**/*",
            lambda route: (
                route.abort()
                if route.request.resource_type in _BLOCKED_RESOURCE_TYPES
                else route.continue_()
            ),
        )
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[stealth] could not block heavy resources: {type(e).__name__}: {e}")
        return False


def profile_identity(profile_dir: str) -> dict:
    """The user agent and viewport this profile has always presented.

    Written once, on first launch, and read by every process that opens the
    profile afterwards — the connect flow that creates the session and every
    worker replica that reuses it. Returns {"user_agent", "viewport"}.
    """
    path = os.path.join(profile_dir, _IDENTITY_FILE)
    existing = _read_identity(path)
    if existing:
        return existing

    ident = {"user_agent": random_ua(), "viewport": random_viewport()}
    try:
        os.makedirs(profile_dir, exist_ok=True)
        # Exclusive create: two launches racing on a fresh profile must not each
        # write their own identity, or the loser spends the rest of its life
        # presenting a UA the cookies were not issued to.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(ident, fh)
    except FileExistsError:
        return _read_identity(path) or ident
    except OSError as e:
        print(f"[stealth] could not save the profile identity: {e}")
    return ident


def random_delay_ms(min_ms: int = 1500, max_ms: int = 4000) -> int:
    """Human-paced inter-action delay — jitter prevents timing fingerprinting."""
    return random.randint(min_ms, max_ms)


def scroll_to(page, element) -> None:
    """Scroll element into view with slight human-like overshoot before interact."""
    try:
        element.scroll_into_view_if_needed()
        page.evaluate("(o) => window.scrollBy(0, o)", random.randint(-40, 80))
        page.wait_for_timeout(random.randint(200, 600))
    except Exception:  # noqa: BLE001
        pass


def human_click(page, element) -> None:
    """Move mouse along curved path to element then click — mimics human pointer motion."""
    try:
        box = element.bounding_box()
        if box:
            cx = box["x"] + box["width"] / 2 + random.uniform(-4, 4)
            cy = box["y"] + box["height"] / 2 + random.uniform(-4, 4)
            page.mouse.move(cx - random.randint(60, 140), cy - random.randint(20, 60))
            page.mouse.move(cx - random.randint(10, 30), cy - random.randint(5, 20))
            page.mouse.move(cx, cy)
        element.click()
    except Exception:  # noqa: BLE001
        try:
            element.click()
        except Exception:  # noqa: BLE001
            pass
