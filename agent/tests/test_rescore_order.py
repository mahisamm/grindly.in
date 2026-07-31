"""Which listings earn a deep JD read.

The bug this guards against was measured live: a real "Data Science Intern"
scored 0 against an ML candidate because its board published no description,
and a rescue list ranked by score can never reach the listing whose score is
the thing that needs correcting.
"""
import worker


def _row(score: int, jd: str = "", title: str = "Intern"):
    return (score, "reason", {"title": title, "jd_text": jd, "url": "u"})


def test_a_jd_less_listing_is_read_even_though_it_scored_zero():
    """The whole point. Twelve well-described listings outrank it on paper;
    it is the one whose score means nothing."""
    scored = [_row(90, "full description") for _ in range(12)]
    scored.append(_row(0, "", "Data Science Intern"))
    order = worker._rescore_order(scored, 6)
    assert 12 in order


def test_the_budget_is_split_between_both_kinds():
    scored = [_row(90, "desc") for _ in range(10)] + [_row(0) for _ in range(10)]
    order = worker._rescore_order(scored, 6)
    described = [i for i in order if i < 10]
    bare = [i for i in order if i >= 10]
    assert described and bare, "one side got the entire budget"
    assert len(order) == 6


def test_no_budget_is_wasted_when_one_side_is_empty():
    """Everything has a description — the whole budget still gets used."""
    scored = [_row(90 - i, "desc") for i in range(10)]
    order = worker._rescore_order(scored, 6)
    assert len(order) == 6
    assert len(set(order)) == 6


def test_no_budget_is_wasted_when_nothing_has_a_description():
    scored = [_row(0) for _ in range(10)]
    order = worker._rescore_order(scored, 6)
    assert len(order) == 6
    assert len(set(order)) == 6


def test_each_side_stays_in_score_order():
    scored = [_row(90, "d"), _row(80, "d"), _row(70, "d"),
              _row(30), _row(20), _row(10)]
    order = worker._rescore_order(scored, 4)
    described = [i for i in order if i < 3]
    bare = [i for i in order if i >= 3]
    assert described == sorted(described)
    assert bare == sorted(bare)


def test_never_returns_more_than_the_budget_or_a_duplicate():
    scored = [_row(50, "d" if i % 2 else "") for i in range(40)]
    for budget in (1, 2, 3, 7, 15, 40, 100):
        order = worker._rescore_order(scored, budget)
        assert len(order) <= budget
        assert len(order) == len(set(order))
        assert all(0 <= i < len(scored) for i in order)


def test_an_empty_or_zero_budget_reads_nothing():
    assert worker._rescore_order([], 10) == []
    assert worker._rescore_order([_row(90)], 0) == []
    assert worker._rescore_order([_row(90)], -5) == []


def test_a_budget_larger_than_the_list_returns_every_listing_once():
    scored = [_row(50, "d" if i % 3 else "") for i in range(7)]
    order = worker._rescore_order(scored, 50)
    assert sorted(order) == list(range(7))
