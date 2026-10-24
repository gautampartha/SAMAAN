"""Graph validation report (plan 6.1 step 5): components, dangling ends, crossings without ends."""
from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import networkx as nx
from sqlmodel import Session, select

from api.db import init_db
from api.models import FootpathEdge, FootpathNode
from common.paths import PROCESSED_DIR
from pipeline.graph.osm import write_meta


def validate(session: Session) -> dict[str, Any]:
    nodes = {n.id: n for n in session.exec(select(FootpathNode)).all()}
    edges = session.exec(select(FootpathEdge)).all()
    G = nx.MultiGraph()
    G.add_nodes_from(nodes)
    for e in edges:
        G.add_edge(e.u, e.v, id=e.id, kind=e.kind, length_m=e.length_m)
    comps = sorted(nx.connected_components(G), key=len, reverse=True)
    total_len = sum(e.length_m for e in edges) or 1.0
    comp_len = []
    for c in comps:
        comp_len.append(sum(d["length_m"] for a, b, d in G.edges(c, data=True)))
    degree = dict(G.degree())
    dangling_nodes = [n for n, d in degree.items() if d == 1]
    dangling_by_kind: Counter[str] = Counter()
    crossings_no_end = []
    for e in edges:
        if degree.get(e.u, 0) == 1 or degree.get(e.v, 0) == 1:
            dangling_by_kind[e.kind] += 1
            if e.kind == "crossing":
                crossings_no_end.append(e.id)
    tiny = [e.id for e in edges if e.length_m < 0.5]
    kinds = Counter(e.kind for e in edges)
    length_by_kind = Counter()
    for e in edges:
        length_by_kind[e.kind] += e.length_m
    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "nodes": len(nodes), "edges": len(edges), "total_length_km": round(total_len / 1000, 2),
        "components": len(comps),
        "largest_component_nodes": len(comps[0]) if comps else 0,
        "largest_component_length_share": round(comp_len[0] / total_len, 4) if comps else 0.0,
        "other_components": [{"nodes": len(c), "length_m": round(cl, 1)} for c, cl in zip(comps[1:11], comp_len[1:11], strict=False)],
        "dangling_nodes": len(dangling_nodes),
        "dangling_edges_by_kind": dict(dangling_by_kind),
        "crossings_without_end": crossings_no_end[:50],
        "crossings_without_end_count": len(crossings_no_end),
        "edges_under_0_5m": len(tiny),
        "edges_by_kind": dict(kinds),
        "length_km_by_kind": {k: round(v / 1000, 2) for k, v in length_by_kind.items()},
        "unknown_crossing_signal": sum(1 for e in edges if e.kind == "crossing" and e.signal is None),
        "unknown_kerb_ramps": sum(1 for e in edges if e.kind == "crossing" and e.kerb_ramp_start is None),
    }
    report["ok_one_main_component"] = bool(comps) and report["largest_component_length_share"] >= 0.95
    return report


def to_markdown(r: dict[str, Any]) -> str:
    lines = [
        "# Footpath graph validation report", "",
        f"Generated: {r['generated_at']}", "",
        f"- Nodes: {r['nodes']}, edges: {r['edges']}, total length: {r['total_length_km']} km",
        (f"- Connected components: {r['components']} (largest holds {r['largest_component_length_share']:.1%} of length, "
        f"{r['largest_component_nodes']} nodes) -> one main component: **{'yes' if r['ok_one_main_component'] else 'NO'}**"),
        f"- Dangling nodes (degree 1): {r['dangling_nodes']}; dangling edges by kind: {r['dangling_edges_by_kind']}",
        f"- Crossings with a free end: {r['crossings_without_end_count']}",
        f"- Edges shorter than 0.5 m: {r['edges_under_0_5m']}",
        f"- Edges by kind: {r['edges_by_kind']}",
        f"- Length (km) by kind: {r['length_km_by_kind']}",
        f"- Crossings with unknown signal: {r['unknown_crossing_signal']}; unknown kerb ramps: {r['unknown_kerb_ramps']}",
        "",
        "Smaller components (up to 10): " + (", ".join(f"{c['nodes']} nodes / {c['length_m']} m" for c in r["other_components"]) or "none"),
    ]
    return "\n".join(lines) + "\n"


def main(out: Path | None = None) -> dict[str, Any]:
    engine = init_db()
    with Session(engine) as session:
        r = validate(session)
        write_meta(session, validation=json.dumps({k: v for k, v in r.items() if k != "crossings_without_end"}))
    out = out or PROCESSED_DIR / "graph_validation.md"
    out.write_text(to_markdown(r), encoding="utf-8")
    print(to_markdown(r))
    print(f"written {out}")
    return r


if __name__ == "__main__":
    main()
