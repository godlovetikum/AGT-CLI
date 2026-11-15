# Testing and debugging workflow

First reproduce the issue or inspect the failing test and its call path. Identify the expected behavior and a minimal regression test before changing implementation. Prefer deterministic tests with isolated temporary data and mocked network boundaries. Make the smallest fix, run the targeted test, then run the full suite when practical. Report the actual command and outcome; do not claim a test passed if it was not run.
