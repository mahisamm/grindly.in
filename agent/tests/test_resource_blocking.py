"""Don't download what a form-filler cannot use.

The production box is 1 vCPU / 3.8 GB shared between Postgres, the web app, a
search engine and a headed Chromium. An ATS careers page ships hero
photography, an icon font, a video loop and a tracker bundle, none of which
affect whether a form can be read, filled or submitted.

The dangerous over-reach is CSS: read_fields leans on Playwright's
`is_visible()` to skip react-select's hidden twin inputs, and visibility is
decided by computed style. Block stylesheets and every control looks visible,
which makes the form unreadable rather than merely slower.
"""
import stealth


class FakeRequest:
    def __init__(self, resource_type):
        self.resource_type = resource_type


class FakeRoute:
    def __init__(self, resource_type):
        self.request = FakeRequest(resource_type)
        self.aborted = False
        self.continued = False

    def abort(self):
        self.aborted = True

    def continue_(self):
        self.continued = True


class FakeContext:
    def __init__(self, fail=False):
        self.handler = None
        self.pattern = None
        self.fail = fail

    def route(self, pattern, handler):
        if self.fail:
            raise RuntimeError("browser is gone")
        self.pattern = pattern
        self.handler = handler


def _decide(resource_type):
    ctx = FakeContext()
    assert stealth.block_heavy_resources(ctx) is True
    route = FakeRoute(resource_type)
    ctx.handler(route)
    return route


def test_images_media_and_fonts_are_refused():
    for kind in ("image", "media", "font"):
        route = _decide(kind)
        assert route.aborted, f"{kind} was downloaded anyway"


def test_stylesheets_are_never_blocked():
    """is_visible() is computed style. Block CSS and every hidden react-select
    twin looks like a real question."""
    route = _decide("stylesheet")
    assert route.continued and not route.aborted


def test_the_document_and_its_scripts_still_load():
    """These forms ARE the script."""
    for kind in ("document", "script", "xhr", "fetch"):
        route = _decide(kind)
        assert route.continued, f"{kind} was blocked"


def test_an_unknown_resource_type_is_allowed_rather_than_guessed():
    route = _decide("websocket")
    assert route.continued


def test_the_route_covers_every_url():
    ctx = FakeContext()
    stealth.block_heavy_resources(ctx)
    assert ctx.pattern == "**/*"


def test_a_failure_to_install_never_costs_the_application():
    """A heavier page beats no application at all."""
    assert stealth.block_heavy_resources(FakeContext(fail=True)) is False
