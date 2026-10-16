import pandas as pd
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from functools import lru_cache
from io import BytesIO

import datashader as ds
import datashader.transfer_functions as tf
from fastapi.responses import FileResponse
import json


app = FastAPI()

# Allow frontend connection
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

# Project folder
BASE = Path(__file__).resolve().parent.parent

# Load whole brain neurons
whole_nodes = pd.read_parquet(
    BASE / "Data/whole network/nodes_population.parquet"
)

# Load existing JO neurons
jo_nodes = pd.read_parquet(
    BASE / "Data/jo circuit/jo_nodes.parquet"
)

# Match neuron IDs
whole_nodes["root_id"] = whole_nodes["root_id"].astype(str)
jo_nodes["id"] = jo_nodes["id"].astype(str)

# Get JO cell types
jo_types = jo_nodes[["id", "cell_type"]].rename(
    columns={
        "id": "root_id",
        "cell_type": "jo_type"
    }
)

# Attach JO types to the whole brain
whole_nodes = whole_nodes.merge(
    jo_types,
    on="root_id",
    how="left",
    validate="one_to_one"
)

# Prepare only needed information
whole_nodes = whole_nodes.rename(
    columns={"root_id": "id"}
)

whole_nodes = whole_nodes[
    ["id", "x", "y", "super_class", "side", "jo_type"]
]

# Prepare API response once
whole_json = whole_nodes.to_json(orient="records")

# Serve whole brain nodes
@app.get("/network/whole")
def get_whole_network():
    return Response(
        content=whole_json,
        media_type="application/json"
    )

# Generate the bundled-edge image once
@lru_cache(maxsize=1)
def create_bundle_image():

    # Load existing bundled paths
    bundled_edges = pd.read_parquet(
        BASE / "Data/whole network/bundled_edges.parquet"
    )

    # Use the same positions as the whole network
    canvas = ds.Canvas(
        plot_width=4200,
        plot_height=3000,
        x_range=(whole_nodes["x"].min(), whole_nodes["x"].max()),
        y_range=(whole_nodes["y"].min(), whole_nodes["y"].max())
    )

    # Draw bundled connections
    edge_agg = canvas.line(
        bundled_edges,
        "x",
        "y",
        agg=ds.count()
    )

    # Make edges visible
    edge_img = tf.shade(
        edge_agg,
        cmap=["#94A3B8", "#10253F"],
        how="eq_hist",
        alpha=200
    )

    # Convert image to PNG
    buffer = BytesIO()
    edge_img.to_pil().save(buffer, format="PNG")

    return buffer.getvalue()


# Serve bundled edges to the frontend
@app.get("/network/whole/bundles.png")
def get_bundled_edges():

    return Response(
        content=create_bundle_image(),
        media_type="image/png"
    )

# Serve original straight connections
@app.get("/network/whole/straight.bin")
def get_straight_edges():

    return FileResponse(
        BASE / "Data/whole network/straight_edges.bin",
        media_type="application/octet-stream"
    )


# Serve the detailed circuit
@app.get("/network/circuit")
@lru_cache(maxsize=1)
def get_circuit():

    # Use the JO nodes already loaded above
    nodes = jo_nodes[
        [
            "id", "x", "y", "cell_type", "pc2l_subtype",
            "nt_type", "side", "super_class",
            "input_synapses", "output_synapses"
        ]
    ].copy()

    nodes["id"] = nodes["id"].astype(str)

    # Load the small, saved circuit files
    edges = pd.read_parquet(
        BASE / "Data/jo circuit/jo_edges.parquet"
    )

    bundled = pd.read_parquet(
        BASE / "Data/jo circuit/jo_bundled.parquet"
    )

    edges["source"] = edges["source"].astype(str)
    edges["target"] = edges["target"].astype(str)

    # Rebuild the existing bundled paths
    paths = {}

    for edge_id, group in bundled.groupby("edge_id", sort=False):

        points = group[["x", "y"]].dropna()

        paths[str(edge_id)] = points.to_numpy().tolist()

    data = {
        "nodes": json.loads(nodes.to_json(orient="records")),
        "edges": json.loads(edges.to_json(orient="records")),
        "bundled_paths": paths
    }

    return Response(
        content=json.dumps(data),
        media_type="application/json"
    )

@app.get('/network/circuit/spikes')
@lru_cache(maxsize=1)
def get_circuit_spikes():
    folder = BASE / 'Data' / 'spike_data' / 'spike_data'
    spikes_file = folder / 'spike_data.json'
    mapping_file = next(
        (folder / name for name in ('Id_to_idx.csv', 'id_to_idx.csv', 'ID_to_idx.csv')
         if (folder / name).is_file()),
        None,
    )

    if not spikes_file.is_file() or mapping_file is None:
        return Response(
            content=json.dumps({'error': 'Expected spike_data.json and Id_to_idx.csv in Data/spike_data/spike_data/'}),
            status_code=404,
            media_type='application/json',
        )

    # FlyWire IDs are 18-digit values, so keep them as strings.
    mapping = pd.read_csv(mapping_file, dtype=str, keep_default_na=False)
    if mapping.shape[1] < 2:
        return Response(
            content=json.dumps({'error': 'ID mapping CSV needs root ID and index columns'}),
            status_code=422,
            media_type='application/json',
        )

    circuit_ids = set(jo_nodes['id'].astype(str))
    index_to_root = {
        int(index): root_id
        for root_id, index in mapping.iloc[:, :2].itertuples(index=False, name=None)
        if root_id in circuit_ids
    }

    with spikes_file.open('r') as file:
        recorded = json.load(file)

    # Keep only spikes from the 723-neuron circuit.
    spikes = {}
    event_count = 0
    fired_neurons = set()
    for step, indices in recorded.items():
        ids = [index_to_root[idx] for idx in indices if idx in index_to_root]
        if ids:
            spikes[step] = ids
            event_count += len(ids)
            fired_neurons.update(ids)

    print(
        f'Circuit spike playback: {len(index_to_root)} mapped neurons, '
        f'{len(fired_neurons)} neurons fired, {event_count} spike events'
    )

    return Response(
        content=json.dumps({
            'dt_ms': 0.1,        # Johannes: one step = 0.1 ms
            'duration_ms': 1000,  # 10,000 steps = 1 second
            'mapped_circuit_neurons': len(index_to_root),
            'firing_circuit_neurons': len(fired_neurons),
            'event_count': event_count,
            'spikes': spikes,
        }),
        media_type='application/json',
    )


@app.get("/network/whole/spikes")
@lru_cache(maxsize=1)
def get_whole_network_spikes():
    folder = BASE / "Data" / "spike_data" / "spike_data"
    spikes_file = folder / "spike_data.json"
    mapping_file = next(
        (folder / name for name in ("id_to_idx.csv", "Id_to_idx.csv", "ID_to_idx.csv")
         if (folder / name).is_file()),
        None,
    )
    if mapping_file is None or not spikes_file.is_file():
        return Response(
            content=json.dumps({"error": "Spike files not found in Data/spike_data/spike_data/"}),
            status_code=404,
            media_type="application/json",
        )

    # Keep the 18-digit FlyWire IDs as strings (never JavaScript numbers).
    mapping = pd.read_csv(mapping_file, dtype=str, keep_default_na=False)
    if len(mapping.columns) < 2:
        return Response(
            content=json.dumps({"error": "Expected root_id, simulation_index columns"}),
            status_code=422,
            media_type="application/json",
        )

    visible_ids = set(whole_nodes["id"].astype(str))
    index_to_root = {
        int(index): root
        for root, index in mapping.iloc[:, :2].itertuples(index=False, name=None)
        if root in visible_ids and index.isdigit()
    }

    with spikes_file.open("r") as f:
        recorded = json.load(f)

    # Return compact integer indices, not repeated 18-digit IDs per event.
    filtered = {}
    fired_indices = set()
    event_count = 0
    for step, indices in recorded.items():
        events = [idx for idx in indices if idx in index_to_root]
        if not events:
            continue
        filtered[step] = events
        event_count += len(events)
        fired_indices.update(events)

    # Only the indices that actually fired need an index-to-root mapping.
    used_mapping = {str(idx): index_to_root[idx] for idx in fired_indices}
    print(
        f"Whole-network spikes: {len(index_to_root)} mapped neurons, "
        f"{len(fired_indices)} firing neurons, {event_count} events"
    )
    return Response(
        content=json.dumps({
            "dt_ms": 0.1,
            "duration_ms": 1000,
            "mapped_neurons": len(index_to_root),
            "firing_neurons": len(fired_indices),
            "event_count": event_count,
            "index_to_root": used_mapping,
            "spikes": filtered,
        }, separators=(",", ":")),
        media_type="application/json",
    )
