"""Dataset import (class aliases, severity suffixes, manifest) and the street-based split."""
from __future__ import annotations

import json

import pytest
import yaml

from common import config
from ml import dataset as ds


def _export(tmp_path, streets, per_street=3, names=None):
    names = names or ["CurbRamp", "parked_vehicle_3", "steps", "unknownthing"]
    exp = tmp_path / "exp"
    (exp / "train" / "images").mkdir(parents=True)
    (exp / "train" / "labels").mkdir(parents=True)
    (exp / "data.yaml").write_text(yaml.safe_dump({"names": names, "nc": len(names)}))
    from PIL import Image

    i = 0
    for street in streets:
        for j in range(per_street):
            stem = f"{street}-L-{i:03d}"
            Image.new("RGB", (32, 32), (200, 200, 200)).save(exp / "train" / "images" / f"{stem}.jpg")
            # one box per class index 0..2 plus an unknown class 3 that must be dropped
            (exp / "train" / "labels" / f"{stem}.txt").write_text(
                "0 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1\n2 0.7 0.7 0.1 0.1\n3 0.5 0.5 0.1 0.1\n")
            i += 1
    return exp


def test_class_lookup_covers_sidewalk_names_and_aliases():
    lut = ds.class_lookup()
    assert lut["curbramp"] == "curb_ramp" and lut["nocurbramp"] == "steps_or_high_kerb"
    assert lut["surfaceproblem"] == "broken_surface" and lut["obstacle"] == "fixed_obstacle"
    assert lut["kerb ramp"] == "curb_ramp" and lut["two_wheeler"] == "parked_vehicle"


def test_import_maps_classes_and_builds_manifest(tmp_path, monkeypatch):
    monkeypatch.setattr(ds, "LABELS_ROOT", tmp_path / "labels")
    exp = _export(tmp_path, ["alpha-marg", "beta-road"], per_street=2)
    summary = ds.import_export(exp, "t1", synthetic=True)
    assert summary["images"] == 4 and summary["boxes"] == 12 and summary["boxes_dropped_unknown_class"] == 4
    assert summary["streets"] == {"alpha-marg": 6, "beta-road": 6}
    out = ds.dataset_dir("t1")
    lbl = (out / "labels" / "alpha-marg-L-000.txt").read_text().splitlines()
    idx = {c["id"]: c["yolo_index"] for c in config.taxonomy()["detector_classes"]}
    assert [int(line.split()[0]) for line in lbl] == [idx["curb_ramp"], idx["parked_vehicle"], idx["steps_or_high_kerb"]]
    sev = json.loads((out / "severity_counts.json").read_text())
    assert sev == {"parked_vehicle:3": 4}
    rows = ds.read_manifest("t1")
    assert all(r["synthetic"] == "true" for r in rows) and ds.is_synthetic("t1")


def test_split_by_street_keeps_streets_whole(tmp_path, monkeypatch):
    monkeypatch.setattr(ds, "LABELS_ROOT", tmp_path / "labels")
    exp = _export(tmp_path, ["alpha-marg", "beta-road", "gamma-lane", "delta-path", "eps-street"], per_street=3)
    ds.import_export(exp, "t2", synthetic=True)
    rows = ds.read_manifest("t2")
    split = ds.split_by_street(rows, seed=1)
    all_streets = set(split["train"]) | set(split["val"]) | set(split["test"])
    assert len(split["test"]) == 1
    assert not (set(split["train"]) & set(split["val"])) and not (set(split["train"]) & set(split["test"]))
    assert not (set(split["val"]) & set(split["test"]))
    assert all_streets == {"alpha-marg", "beta-road", "gamma-lane", "delta-path", "eps-street"}
    explicit = ds.split_by_street(rows, test_street="gamma-lane")
    assert explicit["test"] == ["gamma-lane"] and "gamma-lane" not in explicit["train"] + explicit["val"]
    with pytest.raises(ValueError):
        ds.split_by_street(rows, test_street="nowhere")
    data_yaml = ds.write_split("t2", explicit)
    d = yaml.safe_load(data_yaml.read_text())
    assert d["names"][0] == "curb_ramp" and len(d["names"]) == 8
    test_files = (ds.dataset_dir("t2") / "test.txt").read_text().split()
    assert len(test_files) == 3 and all("gamma-lane" in f for f in test_files)
    splits = json.loads((ds.dataset_dir("t2") / "splits.json").read_text())
    assert splits["counts"]["test"] == 3 and sum(splits["counts"].values()) == 15


def test_split_needs_two_streets():
    rows = [{"street": "only", "n_labels": "5"}]
    with pytest.raises(ValueError):
        ds.split_by_street(rows)


def test_street_from_filename_and_session():
    assert ds.street_for("bhartendu-marg-L-012", None) == "bhartendu-marg"
    assert ds.street_for("12345", {"session_id": "Vikas-Marg-R", "lat": 1, "lon": 1}) == "vikas-marg"
    assert ds.street_for("99", {"session_id": None, "sequence_id": "abc", "lat": 1, "lon": 1}) == "seq:abc"
    assert ds.street_for("IMG_0001", None) == "unknown"
