from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf


WORKER_PATH = Path(__file__).with_name("qwen-voice-worker.py")
SPEC = importlib.util.spec_from_file_location("qwen_voice_worker", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {WORKER_PATH}.")
WORKER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WORKER
SPEC.loader.exec_module(WORKER)


class QwenVoiceWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = WORKER.AudioQaPolicy(
            revision="test-qa-v1",
            silent_guard_ms=200,
            maximum_word_error_rate=0.18,
            maximum_edge_silence_ms=2_500,
            maximum_full_scale_ratio=0.005,
        )

    def make_two_cue_render_fixture(
        self, root: Path
    ) -> tuple[dict[str, object], dict[str, object], Path, Path]:
        reference_path = root / "reference.wav"
        reference_path.write_bytes(b"approved Voice 2 reference")
        approval_path = root / "approval.json"
        approval_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "approved",
                    "engine": "qwen3-tts",
                    "syntheticOriginal": True,
                    "approvedAsRendered": True,
                    "reference": {
                        "file": reference_path.name,
                        "sha256": WORKER.sha256_file(reference_path),
                        "transcript": "Welcome to the show.",
                    },
                }
            ),
            encoding="utf-8",
        )
        base_path = root / "base"
        asr_path = root / "asr"
        base_path.mkdir()
        asr_path.mkdir()
        base_pin = {
            "repository": "Qwen/test-base",
            "revision": "a" * 40,
        }
        asr_pin = {
            "repository": "openai/test-asr",
            "revision": "b" * 40,
        }
        for path, pin in ((base_path, base_pin), (asr_path, asr_pin)):
            (path / WORKER.MODEL_MARKER_NAME).write_text(
                json.dumps(pin),
                encoding="utf-8",
            )
        first_output = root / "first.wav"
        second_output = root / "second.wav"
        manifest = {
            "renderPolicyRevision": WORKER.RENDER_POLICY_REVISION,
            "voiceApprovalPath": str(approval_path),
            "baseModelPath": str(base_path),
            "asrModelPath": str(asr_path),
            "qaReportPath": str(root / "qa-report.json"),
            "baseSeed": 7319,
            "generation": {
                "doSample": True,
                "topK": 50,
                "topP": 1.0,
                "temperature": 0.9,
                "repetitionPenalty": 1.05,
                "subtalkerDoSample": True,
                "subtalkerTopK": 50,
                "subtalkerTopP": 1.0,
                "subtalkerTemperature": 0.9,
                "maxNewTokens": 2048,
            },
            "jobs": [
                {
                    "cueId": "first",
                    "cacheKey": "c" * 64,
                    "text": "Welcome one.",
                    "qaTranscript": "Welcome one.",
                    "language": "English",
                    "outputPath": str(first_output),
                },
                {
                    "cueId": "second",
                    "cacheKey": "d" * 64,
                    "text": "Welcome two.",
                    "qaTranscript": "Welcome two.",
                    "language": "English",
                    "outputPath": str(second_output),
                },
            ],
        }
        contract = {
            "models": {
                "base": base_pin,
                "asr": asr_pin,
            }
        }
        return manifest, contract, first_output, second_output

    def test_stable_seed_is_repeatable_and_content_addressed(self) -> None:
        first = WORKER.stable_seed(7319, "voice", "cue-1", "Welcome.")
        second = WORKER.stable_seed(7319, "voice", "cue-1", "Welcome.")
        revised = WORKER.stable_seed(7319, "voice", "cue-1", "Welcome back.")

        self.assertEqual(first, second)
        self.assertNotEqual(first, revised)
        self.assertGreaterEqual(first, 0)
        self.assertLessEqual(first, 2_147_483_647)

    def test_render_batch_seed_is_stable_and_singletons_keep_their_cue_seed(
        self,
    ) -> None:
        first = {"cacheKey": "a" * 64, "seed": 101}
        second = {"cacheKey": "b" * 64, "seed": 202}

        self.assertEqual(
            WORKER.stable_render_batch_seed(7319, "c" * 64, [first]),
            101,
        )
        paired = WORKER.stable_render_batch_seed(
            7319, "c" * 64, [first, second]
        )
        self.assertEqual(
            paired,
            WORKER.stable_render_batch_seed(
                7319, "c" * 64, [first, second]
            ),
        )
        self.assertNotEqual(
            paired,
            WORKER.stable_render_batch_seed(
                7319, "c" * 64, [second, first]
            ),
        )

    def test_retry_seed_is_repeatable_and_changes_by_attempt(self) -> None:
        first = WORKER.stable_retry_seed(
            7319, "a" * 64, "b" * 64, "question-1", 2
        )
        repeated = WORKER.stable_retry_seed(
            7319, "a" * 64, "b" * 64, "question-1", 2
        )
        final_attempt = WORKER.stable_retry_seed(
            7319, "a" * 64, "b" * 64, "question-1", 3
        )

        self.assertEqual(first, repeated)
        self.assertNotEqual(first, final_attempt)
        restarted = WORKER.stable_retry_seed(
            7319,
            "a" * 64,
            "b" * 64,
            "question-1",
            2,
            lifetime_attempt=11,
        )
        self.assertNotEqual(first, restarted)
        with self.assertRaisesRegex(WORKER.QwenVoiceError, "outside"):
            WORKER.stable_retry_seed(
                7319,
                "a" * 64,
                "b" * 64,
                "question-1",
                WORKER.MAXIMUM_RENDER_ATTEMPTS + 1,
            )

    def test_rescue_profiles_are_bounded_deterministic_and_do_not_mutate_default(
        self,
    ) -> None:
        approved = WORKER.generation_kwargs(
            {
                "doSample": True,
                "topK": 50,
                "topP": 1.0,
                "temperature": 0.9,
                "repetitionPenalty": 1.05,
                "subtalkerDoSample": True,
                "subtalkerTopK": 50,
                "subtalkerTopP": 1.0,
                "subtalkerTemperature": 0.9,
                "maxNewTokens": 2048,
            }
        )
        original = dict(approved)
        generated = [
            WORKER.rescue_generation_profile(approved, index)
            for index in range(1, WORKER.MAXIMUM_RESCUE_ATTEMPTS + 1)
        ]

        self.assertEqual(approved, original)
        self.assertEqual(
            [name for name, _settings in generated],
            [spec[0] for spec in WORKER.RESCUE_PROFILE_SPECS],
        )
        self.assertTrue(
            all(settings["max_new_tokens"] == 2048 for _name, settings in generated)
        )
        self.assertTrue(
            all(settings["do_sample"] is True for _name, settings in generated)
        )
        self.assertLessEqual(
            generated[-1][1]["temperature"], generated[0][1]["temperature"]
        )

    def test_short_choice_gets_transcript_sized_generation_cap(self) -> None:
        self.assertEqual(
            WORKER.transcript_sized_max_new_tokens(
                "B. 22 seconds",
                approved_max_new_tokens=2048,
                policy=self.policy,
            ),
            170,
        )

    def test_long_transcript_gets_sufficient_generation_cap(self) -> None:
        long_transcript = " ".join(f"word{index}" for index in range(60))

        self.assertEqual(
            WORKER.transcript_sized_max_new_tokens(
                long_transcript,
                approved_max_new_tokens=2048,
                policy=self.policy,
            ),
            1_215,
        )

    def test_transcript_generation_cap_respects_approved_global_ceiling(
        self,
    ) -> None:
        long_transcript = " ".join(f"word{index}" for index in range(60))

        self.assertEqual(
            WORKER.transcript_sized_max_new_tokens(
                long_transcript,
                approved_max_new_tokens=512,
                policy=self.policy,
            ),
            512,
        )

    def test_render_batch_uses_longest_transcript_cap(self) -> None:
        batch = [
            {"qaTranscript": "Wait."},
            {
                "qaTranscript": " ".join(
                    f"word{index}" for index in range(10)
                )
            },
        ]

        self.assertEqual(
            WORKER.batch_sized_max_new_tokens(
                batch,
                approved_max_new_tokens=2048,
                policy=self.policy,
            ),
            290,
        )

    def test_singleton_rescue_inherits_transcript_sized_cap(self) -> None:
        approved = WORKER.generation_kwargs(
            {
                "doSample": True,
                "topK": 50,
                "topP": 1.0,
                "temperature": 0.9,
                "repetitionPenalty": 1.05,
                "subtalkerDoSample": True,
                "subtalkerTopK": 50,
                "subtalkerTopP": 1.0,
                "subtalkerTemperature": 0.9,
                "maxNewTokens": 2048,
            }
        )
        _profile, rescue = WORKER.rescue_generation_profile(approved, 1)

        bounded = WORKER.transcript_bounded_generation_settings(
            rescue,
            [{"qaTranscript": "B. 22 seconds"}],
            self.policy,
        )

        self.assertEqual(bounded["max_new_tokens"], 170)
        self.assertEqual(rescue["max_new_tokens"], 2048)
        self.assertEqual(
            {
                key: value
                for key, value in bounded.items()
                if key != "max_new_tokens"
            },
            {
                key: value
                for key, value in rescue.items()
                if key != "max_new_tokens"
            },
        )

    def test_guarding_adds_true_silence_without_touching_model_samples(self) -> None:
        sample_rate = 10_000
        raw = np.array([0.001, 0.25, -0.5, 0.125], dtype=np.float32)

        guarded = WORKER.guarded_waveform(
            raw, sample_rate, np, self.policy.silent_guard_ms
        )

        guard_samples = 2_000
        np.testing.assert_array_equal(guarded[:guard_samples], np.zeros(guard_samples))
        np.testing.assert_array_equal(
            guarded[guard_samples : guard_samples + raw.size], raw
        )
        np.testing.assert_array_equal(guarded[-guard_samples:], np.zeros(guard_samples))

    def test_waveform_and_transcript_qa_accept_clean_guarded_speech(self) -> None:
        sample_rate = 10_000
        raw = np.full(12_000, 0.2, dtype=np.float32)
        guarded = WORKER.guarded_waveform(
            raw, sample_rate, np, self.policy.silent_guard_ms
        )

        metrics = WORKER.waveform_qa(
            guarded,
            sample_rate,
            "Welcome to the show.",
            "Welcome to the show.",
            self.policy,
            np,
        )

        self.assertEqual(metrics.onset_ms, 200)
        self.assertGreaterEqual(metrics.trailing_silence_ms, 200)
        self.assertEqual(metrics.transcript_word_error_rate, 0)

    def test_transcript_qa_fails_when_the_first_word_is_missing(self) -> None:
        with self.assertRaisesRegex(
            WORKER.QwenVoiceError, "first word.*to.*welcome"
        ):
            WORKER.transcript_qa(
                "Welcome to the show.",
                "To the show.",
                self.policy.maximum_word_error_rate,
            )

    def test_transcript_qa_fails_closed_without_asr_text(self) -> None:
        with self.assertRaisesRegex(WORKER.QwenVoiceError, "empty transcript"):
            WORKER.transcript_qa(
                "Welcome to the show.",
                "",
                self.policy.maximum_word_error_rate,
            )

    def test_transcript_qa_accepts_spoken_aliases_for_authored_answer_labels(
        self,
    ) -> None:
        examples = (
            ("A. 22 milliseconds", "Ay, 22 milliseconds"),
            ("B. 22 seconds", "Be, 22 seconds"),
            ("C) 22 minutes", "See, 22 minutes"),
            ("D: 22 hours", "Dee, 22 hours"),
        )
        for expected, actual in examples:
            with self.subTest(expected=expected, actual=actual):
                word_error_rate, expected_count, actual_count = (
                    WORKER.transcript_qa(
                        expected,
                        actual,
                        self.policy.maximum_word_error_rate,
                    )
                )
                self.assertLessEqual(
                    word_error_rate, self.policy.maximum_word_error_rate
                )
                self.assertEqual(expected_count, actual_count)

    def test_answer_label_aliases_do_not_weaken_normal_prose_or_missing_labels(
        self,
    ) -> None:
        strict_mismatches = (
            ("A trait survived.", "Ay trait survived."),
            ("Be careful now.", "B careful now."),
            ("B. 22 seconds", "22 seconds"),
            ("B. Be careful now", "Be careful now"),
            ("C. 22 minutes", "Minutes"),
            ("Welcome to the show.", "Be to the show."),
        )
        for expected, actual in strict_mismatches:
            with self.subTest(expected=expected, actual=actual):
                with self.assertRaises(WORKER.VoiceQualityReject):
                    WORKER.transcript_qa(
                        expected,
                        actual,
                        self.policy.maximum_word_error_rate,
                    )

    def test_transcript_qa_accepts_equivalent_numeric_renderings(self) -> None:
        examples = (
            ("Twenty-two minutes, one way.", "22 minutes, one way."),
            (
                "Nineteen point three metric tons.",
                "19.3 metric tons.",
            ),
            (
                "One hundred ninety-three kilograms.",
                "193 kilograms.",
            ),
            (
                "Imagine a forty-four-minute round trip.",
                "Imagine a 44 minute round trip.",
            ),
            ("Player seven.", "Player 7."),
        )
        for expected, actual in examples:
            with self.subTest(expected=expected, actual=actual):
                word_error_rate, expected_count, actual_count = (
                    WORKER.transcript_qa(
                        expected,
                        actual,
                        self.policy.maximum_word_error_rate,
                    )
                )
                self.assertEqual(word_error_rate, 0)
                self.assertEqual(expected_count, actual_count)

    def test_transcript_qa_accepts_authored_vocal_elongation_spelling(self) -> None:
        word_error_rate, expected_count, actual_count = WORKER.transcript_qa(
            "YOU'RE! ALL! WROOOONG!",
            "You're all wrong!",
            self.policy.maximum_word_error_rate,
        )

        self.assertEqual(word_error_rate, 0)
        self.assertEqual(expected_count, actual_count)

    def test_numeric_normalization_does_not_accept_a_different_number(self) -> None:
        with self.assertRaises(WORKER.VoiceQualityReject):
            WORKER.transcript_qa(
                "Twenty-two minutes.",
                "23 minutes.",
                self.policy.maximum_word_error_rate,
            )

    def test_transcript_qa_keeps_proper_noun_pronunciation_strict(self) -> None:
        with self.assertRaisesRegex(
            WORKER.TranscriptQualityReject, "first word"
        ) as caught:
            WORKER.transcript_qa(
                "Minecraft: the heavy update.",
                "Minicraft: the heavy update.",
                self.policy.maximum_word_error_rate,
            )
        self.assertTrue(caught.exception.fallback_eligible)

    def test_render_accepts_best_safe_take_after_seven_transcript_only_failures(
        self,
    ) -> None:
        generation_calls: list[object] = []

        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                generation_calls.append(text)
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, contract, first_output, second_output = (
                self.make_two_cue_render_fixture(root)
            )
            manifest["jobs"][1]["text"] = "Minecraft is a sandbox game."
            manifest["jobs"][1]["qaTranscript"] = "Minecraft is a sandbox game."
            events: list[dict[str, object]] = []

            def transcribe(path: Path) -> str:
                return (
                    "Welcome one."
                    if path.name.startswith(".first.")
                    else "Minicraft is a sandbox game."
                )

            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ),
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(transcribe, "cpu"),
                ),
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
            ):
                WORKER.render_episode(
                    manifest,
                    contract,
                    self.policy,
                    np,
                    sf,
                    object(),
                )

            self.assertTrue(first_output.is_file())
            self.assertTrue(second_output.is_file())
            self.assertEqual(
                len(generation_calls),
                WORKER.FALLBACK_ACCEPTANCE_ATTEMPT,
            )
            report = json.loads(
                (root / "qa-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["status"], "passed-with-warnings")
            second_report = next(
                job for job in report["jobs"] if job["cueId"] == "second"
            )
            self.assertEqual(
                second_report["qualityStatus"], "accepted-with-warning"
            )
            self.assertIn(
                "offline transcript QA remained uncertain",
                second_report["qualityWarning"],
            )
            self.assertEqual(
                report["rescue"]["acceptedWithWarningCount"],
                1,
            )

    def test_waveform_qa_rejects_nonzero_leading_guard(self) -> None:
        sample_rate = 10_000
        raw = np.full(12_000, 0.2, dtype=np.float32)
        guarded = WORKER.guarded_waveform(
            raw, sample_rate, np, self.policy.silent_guard_ms
        )
        guarded[0] = 0.01

        with self.assertRaisesRegex(WORKER.QwenVoiceError, "Leading guard"):
            WORKER.waveform_qa(
                guarded,
                sample_rate,
                "Welcome to the show.",
                "Welcome to the show.",
                self.policy,
                np,
            )

    def test_waveform_qa_rejects_implausibly_short_speech(self) -> None:
        sample_rate = 10_000
        raw = np.full(1_000, 0.2, dtype=np.float32)
        guarded = WORKER.guarded_waveform(
            raw, sample_rate, np, self.policy.silent_guard_ms
        )

        with self.assertRaisesRegex(WORKER.QwenVoiceError, "only 100 ms"):
            WORKER.waveform_qa(
                guarded,
                sample_rate,
                "Welcome to this unusually elaborate and extremely important trivia show.",
                "Welcome to this unusually elaborate and extremely important trivia show.",
                self.policy,
                np,
            )

    def test_local_model_verification_requires_exact_revision_marker(self) -> None:
        expected = {
            "repository": "Qwen/example",
            "revision": "a" * 40,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / WORKER.MODEL_MARKER_NAME).write_text(
                json.dumps(
                    {
                        "repository": expected["repository"],
                        "revision": expected["revision"],
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                WORKER.verify_local_model(str(root), expected, "test"),
                root.resolve(),
            )

            (root / WORKER.MODEL_MARKER_NAME).write_text(
                json.dumps(
                    {
                        "repository": expected["repository"],
                        "revision": "b" * 40,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                WORKER.QwenVoiceError, "pinned model revision"
            ):
                WORKER.verify_local_model(str(root), expected, "test")

    def test_gpu_memory_policy_uses_two_item_batches_only_with_safe_headroom(
        self,
    ) -> None:
        class FakeCuda:
            OutOfMemoryError = RuntimeError

            def __init__(self, available: bool, free: int, total: int) -> None:
                self.available = available
                self.free = free
                self.total = total

            def is_available(self) -> bool:
                return self.available

            def mem_get_info(self, _device: int) -> tuple[int, int]:
                return self.free, self.total

        class FakeTorch:
            def __init__(self, cuda: FakeCuda) -> None:
                self.cuda = cuda

        safe = FakeTorch(
            FakeCuda(
                True,
                4 * WORKER.GIBIBYTE,
                8 * WORKER.GIBIBYTE,
            )
        )
        tight = FakeTorch(
            FakeCuda(
                True,
                2 * WORKER.GIBIBYTE,
                8 * WORKER.GIBIBYTE,
            )
        )
        small_gpu = FakeTorch(
            FakeCuda(
                True,
                4 * WORKER.GIBIBYTE,
                6 * WORKER.GIBIBYTE,
            )
        )
        cpu = FakeTorch(FakeCuda(False, 0, 0))

        self.assertEqual(WORKER.preferred_asr_device(safe), "cuda:0")
        self.assertEqual(WORKER.preferred_render_batch_size(safe), 2)
        self.assertEqual(WORKER.preferred_render_batch_size(tight), 2)
        self.assertEqual(WORKER.preferred_render_batch_size(small_gpu), 1)
        self.assertEqual(WORKER.preferred_asr_device(cpu), "cpu")
        self.assertEqual(WORKER.preferred_render_batch_size(cpu), 1)

    def test_verified_cache_publication_writes_receipt_last(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            temporary = root / "temporary.wav"
            output = root / "finished.wav"
            content = b"verified wave bytes"
            temporary.write_bytes(content)
            wave_hash = hashlib.sha256(content).hexdigest()

            receipt_path = WORKER.publish_verified_cache_entry(
                temporary,
                output,
                "d" * 64,
                wave_hash,
                1375,
            )

            self.assertFalse(temporary.exists())
            self.assertEqual(output.read_bytes(), content)
            self.assertEqual(
                json.loads(receipt_path.read_text(encoding="utf-8")),
                {
                    "schemaVersion": 1,
                    "cacheKey": "d" * 64,
                    "waveSha256": wave_hash,
                    "durationMs": 1375,
                },
            )

    def test_render_publishes_qa_passed_clip_before_a_later_clip_fails(
        self,
    ) -> None:
        generation_calls: list[object] = []

        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                generation_calls.append(text)
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference_path = root / "reference.wav"
            reference_path.write_bytes(b"approved Voice 2 reference")
            approval_path = root / "approval.json"
            approval_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "status": "approved",
                        "engine": "qwen3-tts",
                        "syntheticOriginal": True,
                        "approvedAsRendered": True,
                        "reference": {
                            "file": reference_path.name,
                            "sha256": WORKER.sha256_file(reference_path),
                            "transcript": "Welcome to the show.",
                        },
                    }
                ),
                encoding="utf-8",
            )
            base_path = root / "base"
            asr_path = root / "asr"
            base_path.mkdir()
            asr_path.mkdir()
            base_pin = {
                "repository": "Qwen/test-base",
                "revision": "a" * 40,
            }
            asr_pin = {
                "repository": "openai/test-asr",
                "revision": "b" * 40,
            }
            for path, pin in ((base_path, base_pin), (asr_path, asr_pin)):
                (path / WORKER.MODEL_MARKER_NAME).write_text(
                    json.dumps(pin),
                    encoding="utf-8",
                )

            first_output = root / "first.wav"
            second_output = root / "second.wav"
            manifest = {
                "renderPolicyRevision": WORKER.RENDER_POLICY_REVISION,
                "voiceApprovalPath": str(approval_path),
                "baseModelPath": str(base_path),
                "asrModelPath": str(asr_path),
                "qaReportPath": str(root / "qa-report.json"),
                "baseSeed": 7319,
                "generation": {
                    "doSample": True,
                    "topK": 50,
                    "topP": 1.0,
                    "temperature": 0.9,
                    "repetitionPenalty": 1.05,
                    "subtalkerDoSample": True,
                    "subtalkerTopK": 50,
                    "subtalkerTopP": 1.0,
                    "subtalkerTemperature": 0.9,
                    "maxNewTokens": 2048,
                },
                "jobs": [
                    {
                        "cueId": "first",
                        "cacheKey": "c" * 64,
                        "text": "Welcome one.",
                        "qaTranscript": "Welcome one.",
                        "language": "English",
                        "outputPath": str(first_output),
                    },
                    {
                        "cueId": "second",
                        "cacheKey": "d" * 64,
                        "text": "Welcome two.",
                        "qaTranscript": "Welcome two.",
                        "language": "English",
                        "outputPath": str(second_output),
                    },
                ],
            }
            contract = {
                "models": {
                    "base": base_pin,
                    "asr": asr_pin,
                }
            }
            events: list[dict[str, object]] = []

            def transcribe(path: Path) -> str:
                return (
                    "Welcome one."
                    if path.name.startswith(".first.")
                    else "Broken two."
                )

            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ) as load_model,
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(transcribe, "cpu"),
                ) as load_asr,
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
            ):
                with self.assertRaisesRegex(
                    WORKER.QwenVoiceError, "first word"
                ):
                    WORKER.render_episode(
                        manifest,
                        contract,
                        self.policy,
                        np,
                        sf,
                        object(),
                    )

            load_model.assert_called_once()
            load_asr.assert_called_once()
            self.assertTrue(first_output.is_file())
            self.assertTrue(WORKER.voice_cache_receipt_path(first_output).is_file())
            self.assertFalse(second_output.exists())
            self.assertFalse(
                WORKER.voice_cache_receipt_path(second_output).exists()
            )
            receipt = json.loads(
                WORKER.voice_cache_receipt_path(first_output).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["cacheKey"], "c" * 64)
            self.assertEqual(
                receipt["waveSha256"], WORKER.sha256_file(first_output)
            )
            self.assertEqual(receipt["durationMs"], 1600)
            progress = [
                event
                for event in events
                if event.get("type") == "qwen-progress"
            ]
            self.assertEqual(len(progress), 1)
            self.assertEqual(progress[0]["cueId"], "first")
            retries = [
                event
                for event in events
                if event.get("type") == "qwen-retry"
            ]
            self.assertEqual(
                [event["attempt"] for event in retries],
                list(range(2, WORKER.MAXIMUM_RENDER_ATTEMPTS + 1)),
            )
            self.assertTrue(
                all(event["cueId"] == "second" for event in retries)
            )
            rescue_attempts = [
                event
                for event in events
                if event.get("type") == "qwen-rescue"
                and event.get("stage") == "attempt"
            ]
            self.assertEqual(
                [event["rescueIndex"] for event in rescue_attempts],
                list(range(1, WORKER.MAXIMUM_RESCUE_ATTEMPTS + 1)),
            )
            self.assertEqual(
                [event["profile"] for event in rescue_attempts],
                [
                    profile[0]
                    for profile in WORKER.RESCUE_PROFILE_SPECS
                ],
            )
            self.assertEqual(
                generation_calls,
                [["Welcome one.", "Welcome two."]]
                + ["Welcome two."] * WORKER.MAXIMUM_RESCUE_ATTEMPTS,
            )
            failure_report = root / "qa-report.failures.json"
            self.assertTrue(failure_report.is_file())
            failed = json.loads(failure_report.read_text(encoding="utf-8"))
            self.assertEqual(
                [cue["cueId"] for cue in failed["failedCues"]],
                ["second"],
            )
            ledger = json.loads(
                WORKER.voice_rescue_ledger_path(second_output).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                ledger["attemptCount"], WORKER.MAXIMUM_RENDER_ATTEMPTS
            )

    def test_render_retries_only_the_failed_cue_and_can_recover(self) -> None:
        generation_calls: list[object] = []
        second_transcriptions = 0

        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                generation_calls.append(text)
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, contract, first_output, second_output = (
                self.make_two_cue_render_fixture(root)
            )
            events: list[dict[str, object]] = []

            def transcribe(path: Path) -> str:
                nonlocal second_transcriptions
                if path.name.startswith(".first."):
                    return "Welcome one."
                second_transcriptions += 1
                return (
                    "Broken two."
                    if second_transcriptions == 1
                    else "Welcome two."
                )

            original_publish = WORKER.publish_verified_cache_entry
            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ),
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(transcribe, "cpu"),
                ),
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
                mock.patch.object(
                    WORKER,
                    "publish_verified_cache_entry",
                    wraps=original_publish,
                ) as publish,
            ):
                WORKER.render_episode(
                    manifest,
                    contract,
                    self.policy,
                    np,
                    sf,
                    object(),
                )

            self.assertTrue(first_output.is_file())
            self.assertTrue(second_output.is_file())
            self.assertTrue(
                WORKER.voice_cache_receipt_path(first_output).is_file()
            )
            self.assertTrue(
                WORKER.voice_cache_receipt_path(second_output).is_file()
            )
            self.assertEqual(
                [call.args[1] for call in publish.call_args_list],
                [first_output, second_output],
            )
            self.assertEqual(
                generation_calls,
                [
                    ["Welcome one.", "Welcome two."],
                    "Welcome two.",
                ],
            )
            retries = [
                event
                for event in events
                if event.get("type") == "qwen-retry"
            ]
            self.assertEqual(len(retries), 1)
            self.assertEqual(retries[0]["cueId"], "second")
            self.assertEqual(retries[0]["attempt"], 2)
            expected_retry_seed = WORKER.stable_retry_seed(
                7319,
                WORKER.sha256_file(root / "reference.wav"),
                "d" * 64,
                "second",
                2,
                profile="rescue-reseed",
            )
            self.assertEqual(retries[0]["seed"], expected_retry_seed)

            report = json.loads(
                (root / "qa-report.json").read_text(encoding="utf-8")
            )
            reports_by_cue = {
                job["cueId"]: job for job in report["jobs"]
            }
            self.assertEqual(reports_by_cue["first"]["attempt"], 1)
            self.assertEqual(reports_by_cue["first"]["batchSize"], 2)
            self.assertEqual(reports_by_cue["second"]["attempt"], 2)
            self.assertEqual(reports_by_cue["second"]["batchSize"], 1)
            self.assertEqual(
                reports_by_cue["second"]["generationSeed"],
                expected_retry_seed,
            )
            self.assertEqual(len(reports_by_cue["second"]["priorFailures"]), 1)
            self.assertIn(
                "first word",
                reports_by_cue["second"]["priorFailures"][0]["reason"],
            )
            progress = [
                event
                for event in events
                if event.get("type") == "qwen-progress"
            ]
            self.assertEqual(
                [event["cueId"] for event in progress],
                ["first", "second"],
            )

    def test_render_defers_bad_cue_finishes_primary_scan_then_rescues_once(
        self,
    ) -> None:
        generation_calls: list[object] = []
        second_transcriptions = 0

        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                generation_calls.append(text)
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, contract, first_output, second_output = (
                self.make_two_cue_render_fixture(root)
            )
            third_output = root / "third.wav"
            manifest["jobs"].append(
                {
                    "cueId": "third",
                    "cacheKey": "e" * 64,
                    "text": "Welcome three.",
                    "qaTranscript": "Welcome three.",
                    "language": "English",
                    "outputPath": str(third_output),
                }
            )
            events: list[dict[str, object]] = []

            def transcribe(path: Path) -> str:
                nonlocal second_transcriptions
                if path.name.startswith(".first."):
                    return "Welcome one."
                if path.name.startswith(".third."):
                    return "Welcome three."
                second_transcriptions += 1
                return (
                    "Broken two."
                    if second_transcriptions == 1
                    else "Welcome two."
                )

            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ),
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(transcribe, "cpu"),
                ),
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
            ):
                WORKER.render_episode(
                    manifest,
                    contract,
                    self.policy,
                    np,
                    sf,
                    object(),
                )

            self.assertTrue(first_output.is_file())
            self.assertTrue(second_output.is_file())
            self.assertTrue(third_output.is_file())
            self.assertEqual(
                generation_calls,
                [
                    ["Welcome one.", "Welcome two."],
                    "Welcome three.",
                    "Welcome two.",
                ],
            )
            progress = [
                event
                for event in events
                if event.get("type") == "qwen-progress"
            ]
            self.assertEqual(
                [event["cueId"] for event in progress],
                ["first", "third", "second"],
            )
            self.assertEqual(
                len({event["cueId"] for event in progress}),
                len(progress),
            )
            deferred_index = next(
                index
                for index, event in enumerate(events)
                if event.get("type") == "qwen-deferred"
            )
            third_progress_index = next(
                index
                for index, event in enumerate(events)
                if event.get("type") == "qwen-progress"
                and event.get("cueId") == "third"
            )
            rescue_started_index = next(
                index
                for index, event in enumerate(events)
                if event.get("type") == "qwen-rescue"
                and event.get("stage") == "started"
            )
            self.assertLess(deferred_index, third_progress_index)
            self.assertLess(third_progress_index, rescue_started_index)
            rescue_progress_index = next(
                index
                for index, event in enumerate(events)
                if event.get("type") == "qwen-progress"
                and event.get("cueId") == "second"
            )
            recovered_index = next(
                index
                for index, event in enumerate(events)
                if event.get("type") == "qwen-rescue"
                and event.get("stage") == "recovered"
            )
            self.assertLess(rescue_progress_index, recovered_index)
            self.assertEqual(events[recovered_index]["remainingParked"], 0)

    def test_non_qa_asr_failure_is_infrastructure_and_never_enters_rescue(
        self,
    ) -> None:
        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, contract, _first_output, _second_output = (
                self.make_two_cue_render_fixture(root)
            )
            events: list[dict[str, object]] = []

            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ),
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(
                        mock.Mock(
                            side_effect=OSError("simulated ASR model read failure")
                        ),
                        "cpu",
                    ),
                ),
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
            ):
                with self.assertRaisesRegex(
                    OSError, "ASR model read failure"
                ):
                    WORKER.render_episode(
                        manifest,
                        contract,
                        self.policy,
                        np,
                        sf,
                        object(),
                    )

            self.assertFalse(
                any(
                    event.get("type") in {"qwen-deferred", "qwen-retry", "qwen-rescue"}
                    for event in events
                )
            )

    def test_publication_failure_is_fatal_and_never_retries_or_overwrites(
        self,
    ) -> None:
        generation_calls: list[object] = []

        class FakeModel:
            def create_voice_clone_prompt(self, **_kwargs: object) -> str:
                return "approved-voice-prompt"

            def generate_voice_clone(
                self, *, text: object, **_kwargs: object
            ) -> tuple[list[np.ndarray], int]:
                generation_calls.append(text)
                texts = text if isinstance(text, list) else [text]
                return [
                    np.full(12_000, 0.2, dtype=np.float32)
                    for _ in texts
                ], 10_000

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, contract, first_output, second_output = (
                self.make_two_cue_render_fixture(root)
            )
            events: list[dict[str, object]] = []
            original_publish = WORKER.publish_verified_cache_entry

            def publish(
                temporary: Path,
                destination: Path,
                cache_key: str,
                wave_sha256: str,
                duration_ms: int,
            ) -> Path:
                if destination == second_output:
                    raise OSError("simulated atomic publication failure")
                return original_publish(
                    temporary,
                    destination,
                    cache_key,
                    wave_sha256,
                    duration_ms,
                )

            with (
                mock.patch.object(
                    WORKER, "load_qwen_model", return_value=FakeModel()
                ),
                mock.patch.object(
                    WORKER,
                    "load_render_transcriber",
                    return_value=(
                        lambda path: (
                            "Welcome one."
                            if path.name.startswith(".first.")
                            else "Welcome two."
                        ),
                        "cpu",
                    ),
                ),
                mock.patch.object(
                    WORKER, "preferred_render_batch_size", return_value=2
                ),
                mock.patch.object(WORKER, "seed_everything"),
                mock.patch.object(WORKER, "collect_released_models"),
                mock.patch.object(WORKER, "emit", side_effect=events.append),
                mock.patch.object(
                    WORKER,
                    "publish_verified_cache_entry",
                    side_effect=publish,
                ),
            ):
                with self.assertRaisesRegex(
                    OSError, "atomic publication failure"
                ):
                    WORKER.render_episode(
                        manifest,
                        contract,
                        self.policy,
                        np,
                        sf,
                        object(),
                    )

            self.assertTrue(first_output.is_file())
            self.assertTrue(
                WORKER.voice_cache_receipt_path(first_output).is_file()
            )
            self.assertFalse(second_output.exists())
            self.assertFalse(
                WORKER.voice_cache_receipt_path(second_output).exists()
            )
            self.assertEqual(
                generation_calls,
                [["Welcome one.", "Welcome two."]],
            )
            self.assertFalse(
                any(event.get("type") == "qwen-retry" for event in events)
            )

    def test_render_approval_rejects_audition_or_rejected_voice(self) -> None:
        for status in ("audition-only", "rejected"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                approval_path = root / "approval.json"
                approval_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "status": status,
                            "engine": "qwen3-tts",
                            "syntheticOriginal": True,
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    WORKER.QwenVoiceError, "explicitly approved"
                ):
                    WORKER.approved_reference(str(approval_path))

    def test_repository_runtime_contract_enforces_two_hundred_ms_guard(self) -> None:
        contract, policy = WORKER.runtime_contract(
            Path(__file__).with_name("qwen-runtime-manifest.json")
        )

        self.assertEqual(contract["packages"]["qwenTts"], "0.1.1")
        self.assertEqual(policy.silent_guard_ms, 200)
        self.assertEqual(policy.maximum_word_error_rate, 0.18)
        self.assertRegex(contract["models"]["voiceDesign"]["revision"], r"^[a-f0-9]{40}$")
        self.assertRegex(contract["models"]["base"]["revision"], r"^[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
