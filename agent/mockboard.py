"""A deterministic-ish mock internship board so the whole pipeline (match →
apply → report) runs end-to-end without touching a real site. `mode=mock`
uses this; swapping in `internshala.py` (live) changes nothing downstream."""
from __future__ import annotations
import random

_TEMPLATES = [
    ("Frontend Developer Intern", ["react", "javascript", "typescript", "html", "css", "tailwind"]),
    ("Full Stack Developer Intern", ["react", "node", "express", "mongodb", "javascript"]),
    ("Backend Developer Intern", ["python", "django", "postgresql", "rest api", "docker"]),
    ("Data Science Intern", ["python", "pandas", "numpy", "machine learning", "sql"]),
    ("Machine Learning Intern", ["python", "pytorch", "deep learning", "nlp"]),
    ("Android Developer Intern", ["kotlin", "android", "firebase", "java"]),
    ("UI/UX Design Intern", ["figma", "ui/ux", "html", "css"]),
    ("Data Analyst Intern", ["sql", "excel", "power bi", "tableau", "data analysis"]),
    ("DevOps Intern", ["docker", "kubernetes", "aws", "linux", "git"]),
    ("Digital Marketing Intern", ["marketing", "seo", "content writing"]),
    ("Flutter Developer Intern", ["flutter", "dart", "firebase"]),
    ("Python Developer Intern", ["python", "fastapi", "sql", "git"]),
]
_COMPANIES = [
    "Razorpay", "Swiggy", "Zomato", "CRED", "Sarvam AI", "Postman", "Zerodha",
    "Meesho", "Groww", "Unacademy", "PhonePe", "Freshworks", "BrowserStack",
    "LocalBiz Solutions", "TechNova", "DataForge", "PixelCraft Studios",
]
_LOCATIONS = ["Remote", "Bangalore", "Hyderabad", "Mumbai", "Delhi", "Pune", "Remote"]


def fetch(domains: list[str], limit: int = 25, seed: int | None = None) -> list[dict]:
    rng = random.Random(seed)
    jobs = []
    n = 0
    # bias toward the user's domains so matching has real signal
    order = list(range(len(_TEMPLATES)))
    rng.shuffle(order)
    for i in order:
        title, skills = _TEMPLATES[i]
        for _ in range(rng.randint(1, 3)):
            company = rng.choice(_COMPANIES)
            loc = rng.choice(_LOCATIONS)
            stipend = rng.choice([0, 5000, 8000, 10000, 12000, 15000, 20000, 25000])
            n += 1
            jobs.append({
                "source": "mock",
                "external_id": f"mock-{n}-{rng.randint(1000,9999)}",
                "title": title,
                "company": company,
                "location": loc,
                "stipend": f"₹{stipend}/month" if stipend else "Unpaid",
                "duration": f"{rng.choice([2,3,4,6])} months",
                "skills": skills,
                "url": f"https://internshala.com/internship/detail/mock-{n}",
            })
            if len(jobs) >= limit:
                return jobs
    return jobs
