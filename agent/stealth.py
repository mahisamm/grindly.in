"""Centralized browser stealth patches — free bot-detection mitigations.

Applied once per context via apply_stealth(ctx). Patches 10+ headless signals
that LinkedIn, Indeed, Naukri, and Internshala probe before showing content.
All platforms call this instead of maintaining their own inline scripts.
"""
from __future__ import annotations
import os
import random


def clear_stale_lock(profile_dir: str) -> None:
    """Remove Chrome's process-singleton markers before launching on a
    persistent profile. Automated runs get killed (redeploy, OOM, crash)
    without a graceful browser shutdown, which leaves these pointing at a
    dead process — Chromium then refuses to start at all, reporting the
    profile "in use by another process" even though nothing is running."""
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
