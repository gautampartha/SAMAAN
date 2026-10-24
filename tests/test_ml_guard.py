"""Rule 11.2: synthetic datasets can never write into eval/results/."""
from __future__ import annotations

import pytest

from ml import common as mlc
from ml import dataset as ds


def test_results_dir_refuses_synthetic(tmp_path, monkeypatch):
    monkeypatch.setattr(ds, "LABELS_ROOT", tmp_path / "labels")
    d = ds.dataset_dir("syn")
    d.mkdir(parents=True)
    (d / "manifest.csv").write_text("file,image_id,source,lat,lon,street,n_labels,synthetic\nimages/a.jpg,,export,,,x,1,true\n")
    with pytest.raises(RuntimeError):
        mlc.results_dir_for("syn")
    monkeypatch.setattr(mlc, "SMOKE_RESULTS_DIR", tmp_path / "smoke")
    assert mlc.results_dir_for("syn", allow_synthetic=True) == tmp_path / "smoke"
    (d / "manifest.csv").write_text("file,image_id,source,lat,lon,street,n_labels,synthetic\nimages/a.jpg,,export,,,x,1,false\n")
    monkeypatch.setattr(mlc, "RESULTS_DIR", tmp_path / "real")
    assert mlc.results_dir_for("real" if False else "syn") == tmp_path / "real"
