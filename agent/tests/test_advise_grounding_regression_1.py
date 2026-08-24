"""Regression coverage for factual grounding in the written review."""
from __future__ import annotations

import resume_ai


SOURCE = """Priya Ramanathan
Senior Backend Engineer
- Rebuilt a Java and Kafka settlement pipeline, cutting runtime from 6 hours to 40 minutes
Skills: Java, Kafka, AWS, Docker, Kubernetes
"""


def test_review_drops_technologies_and_metrics_missing_from_the_resume():
    """Regression: launch QA found invented S3, SQS, Helm and Airflow advice."""
    advice = {
        "strengths": ["Cut settlement runtime from 6 hours to 40 minutes"],
        "issues": ["The AWS work does not name the exact service"],
        "suggestions": [
            "Name S3 and SQS to demonstrate cloud depth",
            "Specify the Helm charts used for Kubernetes deployments",
            "Clarify whether Airflow scheduled the jobs",
            "Move the real 40 minute result to the front of the Java bullet",
            "State that the pipeline served 900 customers",
        ],
    }

    grounded = resume_ai._ground_advice(advice, SOURCE)

    assert grounded["strengths"] == advice["strengths"]
    assert grounded["issues"] == advice["issues"]
    assert grounded["suggestions"] == [
        "Move the real 40 minute result to the front of the Java bullet",
    ]
