import threading

import worker


class LoopSensitiveAdapter:
    def __init__(self):
        self.calls: list[int] = []
        self.closed_on: int | None = None

    def scrape_jd(self, url: str, uid: str) -> str:
        self.calls.append(threading.get_ident())
        if len(self.calls) == 1:
            raise RuntimeError(
                "It looks like you are using Playwright Sync API inside the asyncio loop."
            )
        return "Legitimate internship. No fee. Python and React."

    def close(self, uid: str) -> None:
        self.closed_on = threading.get_ident()


def test_jd_scrape_retries_off_the_loop_thread_and_closes_there():
    adapter = LoopSensitiveAdapter()
    main_thread = threading.get_ident()

    text = worker._scrape_jd_if_available(
        "naukri",
        adapter,
        "https://example.test/internship",
        "beta-user",
    )

    assert text.startswith("Legitimate internship")
    assert adapter.calls[0] == main_thread
    assert adapter.calls[1] != main_thread
    assert adapter.closed_on == adapter.calls[1]
