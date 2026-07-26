from __future__ import annotations

import importlib.util
import math
import unittest
from pathlib import Path

import numpy as np


FOUNDRY_PATH = Path(__file__).with_name("host-voice-foundry.py")
SPEC = importlib.util.spec_from_file_location("host_voice_foundry", FOUNDRY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {FOUNDRY_PATH}.")
FOUNDRY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FOUNDRY)


class NormalizeAndTrimTests(unittest.TestCase):
    def test_edge_signal_gets_guards_without_fading_first_or_last_sample(self) -> None:
        sample_rate = 1_000
        source = np.array([0.5, -0.25, 0.125, -0.5], dtype=np.float32)

        result = FOUNDRY.normalize_and_trim(source, sample_rate, np)

        guard_samples = round(sample_rate * FOUNDRY.AUDIBLE_GUARD_SECONDS)
        expected_gain = math.pow(10.0, -2.0 / 20.0) / 0.5
        expected_signal = source * expected_gain

        self.assertEqual(result.size, source.size + guard_samples * 2)
        np.testing.assert_array_equal(result[:guard_samples], np.zeros(guard_samples))
        np.testing.assert_allclose(
            result[guard_samples : guard_samples + source.size],
            expected_signal,
            rtol=1e-6,
            atol=1e-7,
        )
        np.testing.assert_array_equal(result[-guard_samples:], np.zeros(guard_samples))


if __name__ == "__main__":
    unittest.main()
