# Human-corrected footpath graph

1. `make graph-export` writes `data/processed/footpath_graph.geojson` (+ `_nodes`).
2. Open it in QGIS or JOSM (CRS84 / WGS84). Fix geometry, delete wrong sidewalks, draw missing
   footpaths, set `kind` (sidewalk / crossing / footway / steps / road_shared / connector) and
   `side` (L / R / none). Keep `id` on edges you only edited.
3. Save as `data/corrected/footpath_graph_corrected.geojson` and commit it.
4. `make graph-import FILE=data/corrected/footpath_graph_corrected.geojson && make seed`.
