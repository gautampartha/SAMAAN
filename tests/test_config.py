"""Config sanity: every standard value is cited or marked TODO: cite; ids are consistent."""
from common import config


def test_all_configs_load():
    for name in config.CONFIG_NAMES:
        assert isinstance(config.load(name), dict)


def test_standards_are_cited_or_todo():
    for key, entry in config.profiles()["standards"].items():
        assert "source" in entry, key
        if entry["value"] is None:
            assert "TODO: cite" in entry["source"], f"{key}: null value must carry 'TODO: cite'"
        else:
            assert "TODO" not in entry["source"], f"{key}: a filled value must cite its source"


def test_speeds_have_source():
    for pid, p in config.profiles()["profiles"].items():
        assert p["speed_m_s"]["value"] > 0, pid
        assert p["speed_m_s"]["source"], pid


def test_four_profiles_present():
    assert set(config.profiles()["profiles"]) == {"walker", "wheelchair_manual", "elderly_walking_aid", "pram"}


def test_taxonomy_detector_classes():
    classes = config.taxonomy()["detector_classes"]
    assert len(classes) == 8
    assert sorted(c["yolo_index"] for c in classes) == list(range(8))
    ids = [c["id"] for c in classes]
    assert len(set(ids)) == 8
    for c in classes:
        assert c["name"]["en"] and c["name"]["hi"], c["id"]


def test_rules_reference_known_classes():
    known = set(config.all_class_ids())
    for pid, p in config.profiles()["profiles"].items():
        for cls, rule in p.get("rules", {}).items():
            assert cls in known, f"{pid}: unknown class {cls}"
            thr = rule["impassable_at_or_above"]
            assert thr is None or 1 <= thr <= 5
            for sev in rule["penalty_seconds_by_severity"]:
                assert 1 <= int(sev) <= 5


def test_fix_costs_keys_and_estimate_label():
    fc = config.fix_costs()
    known = set(config.all_class_ids())
    assert set(fc["costs"]) <= known
    assert fc["label"]["en"] == "estimate"
    for cls, c in fc["costs"].items():
        if c["min"] is None:
            assert "TODO" in c["source"], cls


def test_unknown_multipliers_ordered():
    m = config.profiles()["unknown_multiplier"]
    assert m["strict"] > m["balanced"] >= m["relaxed"] == 1.0


def test_zone_bbox_sane():
    b = config.zone()["bbox"]
    assert b["south"] < b["north"] and b["west"] < b["east"]
    assert (b["north"] - b["south"]) * (b["east"] - b["west"]) < 0.25  # OSM API limit
    assert config.zone()["crs"]["metric"] == "EPSG:32643"
