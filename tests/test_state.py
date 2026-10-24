from datetime import timedelta

from common import config
from common.state import BLOCKED, CLEAR, UNKNOWN, compute_edge_state, impassable_for_any_profile
from tests.conftest import NOW

P = config.profiles()


def test_steps_block_wheelchair():
    assert impassable_for_any_profile(P, "steps_or_high_kerb", 4)
    assert not impassable_for_any_profile(P, "steps_or_high_kerb", 1)


def test_curb_ramp_never_blocks():
    assert not impassable_for_any_profile(P, "curb_ramp", 5)


def test_blocked_overrides_observed():
    state, _ = compute_edge_state([{"class": "steps_or_high_kerb", "severity": 5, "status": "active"}],
                                  True, NOW, P, 180, NOW)
    assert state == BLOCKED


def test_fixed_barrier_ignored():
    state, _ = compute_edge_state([{"class": "steps_or_high_kerb", "severity": 5, "status": "fixed"}],
                                  True, NOW, P, 180, NOW)
    assert state == CLEAR


def test_unobserved_is_unknown():
    assert compute_edge_state([], False, None, P, 180, NOW)[0] == UNKNOWN


def test_stale_observation_is_unknown():
    assert compute_edge_state([], True, NOW - timedelta(days=200), P, 180, NOW)[0] == UNKNOWN
    assert compute_edge_state([], True, NOW - timedelta(days=10), P, 180, NOW)[0] == CLEAR


def test_penalty_only_barrier_keeps_clear():
    # parked two-wheeler, severity 3: a penalty for wheelchairs, not impassable (threshold 4)
    state, _ = compute_edge_state([{"class": "parked_vehicle", "severity": 3, "status": "active"}],
                                  True, NOW, P, 180, NOW)
    assert state == CLEAR
