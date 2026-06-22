import os
import sys

# Make the agent modules importable as top-level (matcher, safety, ...) in tests.
sys.path.insert(0, os.path.dirname(__file__))
