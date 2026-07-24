"""Scam scanner (agent/scam.py) — Layer 1.

Two things matter here, and the second matters more: it must catch the money-ask
scams, and it must NEVER flag a legitimate paid internship. The negative cases
below are the real test — a false block silently costs a student a real job.
"""
import scam


def _job(title="Software Intern", skills=None):
    return {"title": title, "company": "Acme", "skills": skills or ["python"]}


# ── must flag: the applicant is billed money ────────────────────────────────

def test_registration_fee_blocked():
    jd = "Great opportunity! A one-time registration fee of ₹500 is required to confirm your seat."
    assert scam.scam_block(_job(), jd) is not None


def test_security_deposit_blocked():
    jd = "Selected candidates must pay a refundable security deposit before joining."
    assert scam.scam_block(_job(), jd) is not None


def test_training_charge_blocked():
    jd = "You will get a real-time project after paying the training fee."
    assert scam.scam_block(_job(), jd) is not None


def test_pay_to_apply_blocked():
    jd = "Pay to apply and get instant access to premium internships."
    assert scam.scam_block(_job(), jd) is not None


def test_have_to_pay_blocked():
    jd = "To receive the offer letter, candidates have to pay a small amount."
    assert scam.scam_block(_job(), jd) is not None


def test_amount_fee_of_blocked():
    jd = "Nominal charges of Rs. 1,200 apply for the certificate and kit."
    assert scam.scam_block(_job(), jd) is not None


def test_joining_fee_amount_first_blocked():
    jd = "Just ₹299 joining charges and you can start immediately from home."
    assert scam.scam_block(_job(), jd) is not None


def test_upfront_investment_blocked():
    jd = "A small upfront investment is needed to activate your dashboard."
    assert scam.scam_block(_job(), jd) is not None


def test_pay_via_wallet_with_fee_blocked():
    jd = "Pay the registration amount via UPI to the number below to get shortlisted."
    assert scam.scam_block(_job(), jd) is not None


def test_unrealistic_daily_earnings_blocked():
    jd = "Work from home and earn ₹5000 per day. No experience needed!"
    assert scam.scam_block(_job(), jd) is not None


def test_mlm_recruit_blocked():
    jd = "Refer members to our program and earn a commission on every signup."
    assert scam.scam_block(_job(), jd) is not None


def test_build_your_team_blocked():
    jd = "Build your own team and grow your network to maximise income."
    assert scam.scam_block(_job(), jd) is not None


# ── must NOT flag: legitimate paid roles (the ones that matter) ─────────────

def test_paid_internship_is_clean():
    jd = "This is a paid internship. Stipend of ₹10,000 per month plus a completion certificate."
    assert scam.scam_block(_job(), jd) is None


def test_salary_to_bank_account_is_clean():
    jd = "Your salary will be credited to your bank account on the 1st of every month."
    assert scam.scam_block(_job(), jd) is None


def test_we_pay_you_is_clean():
    jd = "We pay ₹15000 per month and provide a laptop. Great learning environment."
    assert scam.scam_block(_job(), jd) is None


def test_register_on_portal_is_clean():
    jd = "Register on our careers portal and complete the coding assignment to apply."
    assert scam.scam_block(_job(), jd) is None


def test_payment_processing_skill_is_clean():
    jd = "You will work on our payment processing systems and settlement pipelines."
    assert scam.scam_block(_job(_job()["title"], ["payment gateway", "processing"]), jd) is None


def test_monthly_stipend_is_clean():
    jd = "Interns earn a stipend of ₹8000 per month for the 3-month duration."
    assert scam.scam_block(_job(), jd) is None


def test_security_engineer_role_is_clean():
    jd = "Application security intern. You will audit code and improve our security posture."
    assert scam.scam_block(_job("Security Intern", ["security", "appsec"]), jd) is None


def test_empty_jd_is_clean():
    assert scam.scam_block(_job(), "") is None


def test_no_jd_uses_title_and_skills_without_false_positive():
    assert scam.scam_block(_job("React Developer Intern", ["react", "javascript"])) is None


# ── negated reassurances must stay clean (the tricky false-positive class) ───

def test_no_registration_fee_reassurance_is_clean():
    jd = "Immediate joining. There is absolutely no registration fee — this is 100% free."
    assert scam.scam_block(_job(), jd) is None


def test_fee_waived_is_clean():
    jd = "The joining fee is waived for all selected interns this month."
    assert scam.scam_block(_job(), jd) is None


def test_we_dont_charge_is_clean():
    jd = "We never ask for any security deposit or training charges — you only earn."
    assert scam.scam_block(_job(), jd) is None


def test_real_fee_after_reassurance_still_blocks():
    # Negation is local: a genuine demand elsewhere in the JD must still fire.
    jd = "No application fee. However, a refundable security deposit of ₹2000 is required."
    assert scam.scam_block(_job(), jd) is not None


def test_unrelated_no_does_not_suppress_real_fee():
    # An unrelated "no" ("no experience needed") must not shield a real demand.
    jd = "No experience needed! A registration fee of ₹999 confirms your enrollment."
    assert scam.scam_block(_job(), jd) is not None


def test_a_negator_in_the_previous_sentence_does_not_suppress_a_fee():
    """The case above passed only because "!" happened to fall inside the 48-char
    lookback as a non-word character. With a full stop the negator "No prior
    experience required" sat plainly in the window and cancelled the demand — and
    that is the commonest phrasing of this exact scam."""
    jd = "No prior experience required. Registration fee of Rs 500 to confirm your seat."
    assert scam.scam_block(_job(), jd) is not None


def test_a_real_reassurance_in_its_own_sentence_still_passes():
    """The other half must keep working: a legitimate listing saying it charges
    nothing has the scam word present but negated, in the same sentence."""
    for jd in (
        "There is no registration fee for this internship.",
        "We never ask for any deposit from candidates.",
        "Joining fee waived for all selected interns.",
    ):
        assert scam.scam_block(_job(), jd) is None, jd
