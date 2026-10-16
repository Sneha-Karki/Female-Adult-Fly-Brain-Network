import Graph from "graphology";
import Sigma from "sigma";
import { setupSpikePlayback } from "./spikePlayback";

// Original whole-network population colors (same palette used in main.ts).
const wholePopulationColors: Record<string, string> = {
  optic: "#2563eb",
  central: "#e11d48",
  sensory: "#16a34a",
  visual_projection: "#9333ea",
  ascending: "#f97316",
  descending: "#06b6d4",
  sensory_ascending: "#eab308",
  visual_centrifugal: "#db2777",
  motor: "#64748b",
  endocrine: "#14b8a6",
};

// Original JO circuit colors
const colors: Record<string, string> = {
  "JO-A": "#2563EB",
  "JO-B": "#06B6D4",
  pC2la: "#E11D48",
  pC2lb: "#F97316",
  pC2lc: "#16A34A",
  pC2ld: "#9333EA",
  "pC2la / pC2lb": "#EAB308",
  "pC2la / pC2lc": "#DB2777",
  Intermediate: "#94A3B8",
  Other: "#64748B",
};

function getGroup(type: string): string {
  const matches = ["pC2la", "pC2lb", "pC2lc", "pC2ld"]
    .filter((name) => type.includes(name));

  if (matches.length > 1) return matches.join(" / ");
  if (matches.length === 1) return matches[0];
  if (type === "JO-A" || type === "JO-B") return type;
  if (type === "Intermediate") return "Intermediate";
  return "Other";
}

type EdgeLayer = {
  setVisible: (value: boolean) => void;
};

type CircuitEdge = {
  source: string | number;
  target: string | number;
  syn_count?: number;
};

type CircuitNode = {
  id: string | number;
  cell_type?: string;
  pc2l_subtype?: string | null;
  input_synapses?: number;
  output_synapses?: number;
  [key: string]: unknown;
};

export async function setupCircuitMode(
  renderer: Sigma,
  graph: Graph,
  straightEdges: EdgeLayer,
  bundleImage: HTMLImageElement
) {
  // Fetch only the saved 723-neuron circuit
  const response = await fetch("http://127.0.0.1:8003/network/circuit");
  if (!response.ok) throw new Error("Failed to load circuit");

  const data = await response.json();
  const circuitNodes = data.nodes as CircuitNode[];
  const circuitEdges = data.edges as CircuitEdge[];
  const bundledPaths = data.bundled_paths as Record<string, number[][]>;

  console.log("Circuit nodes:", circuitNodes.length);
  console.log("Circuit edges:", circuitEdges.length);
  console.log("Circuit bundled paths:", Object.keys(bundledPaths).length);
  console.log("Sample path keys:", Object.keys(bundledPaths).slice(0, 5));

  // Mark circuit neurons already present in the whole-brain graph
  for (const node of circuitNodes) {
    const id = String(node.id);
    if (!graph.hasNode(id)) continue;

    graph.mergeNodeAttributes(id, {
      circuitGroup: getGroup(String(node.cell_type || node.pc2l_subtype || "")),
      circuitData: node,
    });
  }

  // Add only circuit edges to Graphology for straight-edge mode
  circuitEdges.forEach((edge, index) => {
    const source = String(edge.source);
    const target = String(edge.target);
    if (!graph.hasNode(source) || !graph.hasNode(target)) return;

    const key = `circuit-edge-${index}`;
    if (graph.hasEdge(key)) return;

    graph.addDirectedEdgeWithKey(key, source, target, {
      color: "#64748B",
      size: 0.8,
      synCount: edge.syn_count,
    });
  });

  // A small rendering graph avoids processing all 139,255 neurons on zoom.
  // The original graph stays intact for Whole Network Mode.
  const circuitGraph = new Graph({ type: "directed", multi: true });

  for (const node of circuitNodes) {
    const id = String(node.id);
    if (graph.hasNode(id)) {
      circuitGraph.addNode(id, { ...graph.getNodeAttributes(id) });
    }
  }

  circuitEdges.forEach((edge, index) => {
    const source = String(edge.source);
    const target = String(edge.target);
    const key = `circuit-edge-${index}`;
    if (
      circuitGraph.hasNode(source) &&
      circuitGraph.hasNode(target) &&
      graph.hasEdge(key)
    ) {
      circuitGraph.addDirectedEdgeWithKey(
        key, source, target, { ...graph.getEdgeAttributes(key) }
      );
    }
  });

  // Freeze the whole-brain coordinate system across both graph views.
  // This prevents neurons and curved paths shifting during mode changes.
  const wholeBBox = renderer.getBBox();
  renderer.setCustomBBox(wholeBBox);

  console.log("Circuit rendering graph:", circuitGraph.order, "neurons,", circuitGraph.size, "edges");

  let networkMode: "whole" | "circuit" = "whole";
  let edgeMode: "straight" | "bundled" = "straight";
  const selectedTypes = new Set(Object.keys(colors));

  // Whole-network nodes are already colored by main.ts. Read their *existing*
  // colors to build the legend, rather than changing any node's color or data.
  const presentWholeColors = new Set<string>();
  graph.forEachNode((_id, attrs) => {
    if (typeof attrs.color === "string") {
      presentWholeColors.add(attrs.color.toLowerCase());
    }
  });
  const selectedWholeColors = new Set(presentWholeColors);

  function isCircuitVisible(id: string): boolean {
    if (!graph.hasNode(id)) return false;
    const group = graph.getNodeAttribute(id, "circuitGroup") as string | undefined;
    return !!group && selectedTypes.has(group);
  }

  // The display colors change only in Circuit Mode
  renderer.setSetting("nodeReducer", (id, attrs) => {
    if (networkMode === "whole") {
      const nodeColor = typeof attrs.color === "string" ? attrs.color.toLowerCase() : "";
      return nodeColor && !selectedWholeColors.has(nodeColor)
        ? { ...attrs, hidden: true }
        : attrs;
    }
    if (!isCircuitVisible(id)) return { ...attrs, hidden: true };

    const group = graph.getNodeAttribute(id, "circuitGroup") as string;
    const result = {
      ...attrs,
      hidden: false,
      color: colors[group] || colors.Other,
      size: 4,
      zIndex: 1,
    };

    return result;
  });

  // Graphology's straight edges only appear in Circuit + Straight
  renderer.setSetting("edgeReducer", (key, attrs) => {
    if (networkMode !== "circuit" || edgeMode !== "straight") {
      return { ...attrs, hidden: true };
    }

    const source = graph.source(key);
    const target = graph.target(key);
    if (!isCircuitVisible(source) || !isCircuitVisible(target)) {
      return { ...attrs, hidden: true };
    }
    return {
      ...attrs,
      hidden: false,
      color: "#64748B",
    };
  });

  // Draw curved circuit paths on a real canvas, not a PNG
  const canvas = renderer.createCanvas("circuitBundles", {
    afterLayer: "edges",
  });
  canvas.style.pointerEvents = "none";
  // Keep circuit bundles below the neuron canvas.
  renderer.getCanvases().nodes.before(canvas);
  canvas.style.opacity = "0.55";
  canvas.style.display = "none";
  canvas.style.backgroundColor = "transparent";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create circuit bundle canvas");

  const container = renderer.getContainer();
  let firstDrawLogged = false;

  function findPath(index: number): number[][] | undefined {
    return (
      bundledPaths[`${index}.0`] ??
      bundledPaths[`edge-${index}`] ??
      bundledPaths[String(index)] ??
      bundledPaths[`edge_${index}`] ??
      bundledPaths[`circuit-edge-${index}`]
    );
  }

  // Match all paths once instead of searching JSON during every frame.
  const pathsByEdge = circuitEdges.map((_, index) => findPath(index));
  console.log(
    "Circuit paths matched:",
    pathsByEdge.filter((path) => Array.isArray(path) && path.length >= 2).length,
    "/", circuitEdges.length
  );

  // Use three Sigma conversions per frame, rather than one per path point.
  // Graph-to-screen mapping is affine at a fixed camera position.
  const baseX = wholeBBox.x[0];
  const baseY = wholeBBox.y[0];
  const spanX = wholeBBox.x[1] - baseX || 1;
  const spanY = wholeBBox.y[1] - baseY || 1;

  function drawBundledEdges() {
    if (networkMode !== "circuit" || edgeMode !== "bundled") return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, width, height);
    ctx!.lineJoin = "round";
    ctx!.lineCap = "round";

    // Calculate one affine screen transform per frame.
    const origin = renderer.graphToViewport({ x: baseX, y: baseY });
    const alongX = renderer.graphToViewport({ x: baseX + spanX, y: baseY });
    const alongY = renderer.graphToViewport({ x: baseX, y: baseY + spanY });
    const xx = (alongX.x - origin.x) / spanX;
    const xy = (alongX.y - origin.y) / spanX;
    const yx = (alongY.x - origin.x) / spanY;
    const yy = (alongY.y - origin.y) / spanY;

    let pathsDrawn = 0;

    circuitEdges.forEach((edge, index) => {
      const source = String(edge.source);
      const target = String(edge.target);
      if (!isCircuitVisible(source) || !isCircuitVisible(target)) return;

      const path = pathsByEdge[index];
      if (!Array.isArray(path) || path.length < 2) return;

      let pointsDrawn = 0;
      ctx!.beginPath();

      for (const point of path) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        const dx = x - baseX;
        const dy = y - baseY;
        const screenX = origin.x + dx * xx + dy * yx;
        const screenY = origin.y + dx * xy + dy * yy;
        if (pointsDrawn === 0) ctx!.moveTo(screenX, screenY);
        else ctx!.lineTo(screenX, screenY);
        pointsDrawn++;
      }

      if (pointsDrawn < 2) return;

      ctx!.strokeStyle = "rgba(71,85,105,0.12)";
      ctx!.lineWidth = 0.7;
      ctx!.stroke();
      pathsDrawn++;
    });

    if (!firstDrawLogged) {
      console.log("Circuit bundled paths drawn:", pathsDrawn);
      firstDrawLogged = true;
    }
  }

  // Draw after Sigma finishes rendering so switching graphs cannot erase curves.
  let bundleFrame: number | null = null;
  function scheduleBundleDraw() {
    if (networkMode !== "circuit" || edgeMode !== "bundled") return;
    if (bundleFrame !== null) return;
    bundleFrame = requestAnimationFrame(() => {
      bundleFrame = null;
      drawBundledEdges();
    });
  }

  renderer.on("afterRender", scheduleBundleDraw);

  // Controls
  const controls = document.getElementById("controls")!;
  if (!controls) throw new Error("Missing #controls");
  controls.replaceChildren();
  controls.style.minWidth = "230px";
  controls.style.maxHeight = "85vh";
  controls.style.overflowY = "auto";

  const heading = document.createElement("h3");
  heading.textContent = "FAFB Network";
  controls.appendChild(heading);

  function addSelect(title: string, options: [string, string][]) {
    const label = document.createElement("label");
    label.textContent = title;
    label.style.display = "block";
    label.style.marginTop = "12px";
    label.style.marginBottom = "5px";

    const select = document.createElement("select");
    select.style.width = "100%";
    select.style.padding = "8px";
    options.forEach(([value, name]) => select.add(new Option(name, value)));
    controls.append(label, select);
    return select;
  }

  const modeSelect = addSelect("Network Mode", [
    ["whole", "Whole Network"],
    ["circuit", "Circuit"],
  ]);

  const edgeSelect = addSelect("Connections", [
    ["straight", "Straight Edges"],
    ["bundled", "Edge Bundling"],
  ]);

  // Both original filter legends are independent from the right-hand controls.
  // Their complete contents (colored dots, names AND checkboxes) are top-centered.
  function mountHorizontalLegend(panel: HTMLElement, title: HTMLElement) {
    panel.style.cssText = `
      position: fixed !important;
      top: 12px !important;
      left: 50% !important;
      right: auto !important;
      transform: translateX(-50%) !important;
      width: min(960px, calc(100vw - 340px));
      max-width: calc(100vw - 24px);
      max-height: 30vh;
      overflow-y: auto;
      box-sizing: border-box;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 10px 18px;
      padding: 12px 16px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: white;
      color: #1e293b;
      box-shadow: 0 4px 15px rgba(0,0,0,0.12);
      font-size: 14px;
      z-index: 1200;
    `;
    title.style.cssText = `
      margin: 0;
      font-size: 17px;
      font-weight: 700;
      white-space: nowrap;
    `;
    for (const label of Array.from(panel.querySelectorAll("label"))) {
      label.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin: 0;
        white-space: nowrap;
        cursor: pointer;
      `;
      const dot = label.querySelector("span");
      if (dot) {
        dot.style.width = "15px";
        dot.style.height = "15px";
      }
    }
    document.body.appendChild(panel);
  }

  // Whole Network: population legend + checkboxes using existing node colors.
  const wholeLegend = document.createElement("div");
  wholeLegend.style.marginTop = "18px";
  const wholeLegendTitle = document.createElement("h4");
  wholeLegendTitle.textContent = "Neuron Populations";
  wholeLegend.appendChild(wholeLegendTitle);

  const namedColors = new Set<string>();
  const populationEntries: Array<[string, string]> = [];
  for (const [population, color] of Object.entries(wholePopulationColors)) {
    const normalized = color.toLowerCase();
    if (!presentWholeColors.has(normalized)) continue;
    populationEntries.push([population.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), normalized]);
    namedColors.add(normalized);
  }
  // Include any actual node colors not in the palette without inventing a population name.
  for (const color of presentWholeColors) {
    if (!namedColors.has(color)) populationEntries.push([`Color ${color}`, color]);
  }

  for (const [population, color] of populationEntries) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;margin:9px 0;";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;

    const dot = document.createElement("span");
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;flex-shrink:0;background:${color};`;
    const name = document.createElement("span");
    name.textContent = population;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedWholeColors.add(color);
      else selectedWholeColors.delete(color);
      renderer.refresh();
    });

    label.append(checkbox, dot, name);
    wholeLegend.appendChild(label);
  }
  mountHorizontalLegend(wholeLegend, wholeLegendTitle);

  // Original circuit type filters and colors
  const legend = document.createElement("div");
  legend.style.marginTop = "18px";
  const legendTitle = document.createElement("h4");
  legendTitle.textContent = "Neuron Types";
  legend.appendChild(legendTitle);

  for (const [type, color] of Object.entries(colors)) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;margin:9px 0;";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;

    const dot = document.createElement("span");
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;flex-shrink:0;background:${color};`;

    const name = document.createElement("span");
    name.textContent = type;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedTypes.add(type);
      else selectedTypes.delete(type);
      firstDrawLogged = false;
      renderer.refresh();
    });

    label.append(checkbox, dot, name);
    legend.appendChild(label);
  }
  mountHorizontalLegend(legend, legendTitle);

  // ======================================================
    // SEPARATE SPIKE PLAYBACK PANEL — BOTTOM LEFT
    // ======================================================

    // Create floating spike panel
    const spikePanel = document.createElement("div");

    spikePanel.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 20px;
    width: 290px;
    max-width: calc(100vw - 40px);
    max-height: 70vh;
    overflow-y: auto;
    background: white;
    padding: 12px;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.15);
    z-index: 1000;
    box-sizing: border-box;
    `;

    // Collapsible header
    const spikeHeader = document.createElement("button");

    spikeHeader.textContent = "Spike Playback  ⌄";

    spikeHeader.style.cssText = `
    display: block;
    width: 100%;
    padding: 8px;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    color: #334155;
    font-weight: bold;
    cursor: pointer;
    text-align: left;
    `;
    spikeHeader.style.touchAction = "none";
    spikeHeader.style.userSelect = "none";
    spikeHeader.style.cursor = "grab";

    // Container for all spike controls
    const spikeContent = document.createElement("div");

    // Add to the page, NOT to main controls
    spikePanel.append(spikeHeader, spikeContent);
    document.body.appendChild(spikePanel);

    // Initialize existing spike playback inside new panel
    const spikePlayback = setupSpikePlayback(
    renderer,
    spikeContent,
    isCircuitVisible
    );

    // Remove duplicate heading and unnecessary spacing
    const innerPanel = spikeContent.firstElementChild as HTMLElement | null;

    if (innerPanel) {
    innerPanel.style.marginTop = "0";
    innerPanel.style.paddingTop = "8px";
    innerPanel.style.borderTop = "none";

    const oldHeading = innerPanel.querySelector("h4") as HTMLElement | null;
    if (oldHeading) oldHeading.style.display = "none";
    }

    // Drag only the Spike Playback header; leave playback controls untouched.
    let draggedSpikePanel = false;
    let spikePointerId: number | null = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let panelStartLeft = 0;
    let panelStartTop = 0;

    spikeHeader.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0 || spikePointerId !== null) return;
      const bounds = spikePanel.getBoundingClientRect();
      spikePointerId = event.pointerId;
      draggedSpikePanel = false;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      panelStartLeft = bounds.left;
      panelStartTop = bounds.top;
      spikeHeader.setPointerCapture(event.pointerId);
    });

    spikeHeader.addEventListener("pointermove", (event: PointerEvent) => {
      if (spikePointerId !== event.pointerId) return;
      const dx = event.clientX - dragStartX;
      const dy = event.clientY - dragStartY;
      if (!draggedSpikePanel && Math.hypot(dx, dy) < 5) return;
      draggedSpikePanel = true;
      spikeHeader.style.cursor = "grabbing";

      const maxLeft = Math.max(0, window.innerWidth - spikePanel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - spikePanel.offsetHeight);
      spikePanel.style.left = `${Math.min(maxLeft, Math.max(0, panelStartLeft + dx))}px`;
      spikePanel.style.top = `${Math.min(maxTop, Math.max(0, panelStartTop + dy))}px`;
      spikePanel.style.bottom = "auto";
    });

    function stopSpikeDrag() {
      spikePointerId = null;
      spikeHeader.style.cursor = "grab";
    }
    spikeHeader.addEventListener("pointerup", stopSpikeDrag);
    spikeHeader.addEventListener("pointercancel", () => {
      stopSpikeDrag();
      draggedSpikePanel = false;
    });

    // Minimize / expand spike panel independently
    let spikeMinimized = false;

    spikeHeader.addEventListener("click", () => {
    // Releasing after a drag should not minimize/expand the panel.
    if (draggedSpikePanel) {
      draggedSpikePanel = false;
      return;
    }
    spikeMinimized = !spikeMinimized;

    spikeContent.style.display = spikeMinimized
        ? "none"
        : "block";

    spikeHeader.textContent = spikeMinimized
        ? "Spike Playback  ⌃"
        : "Spike Playback  ⌄";
    });

  // Neuron properties — independent top-right panel.
  const propertyPanel = document.createElement("div");
  propertyPanel.style.cssText = `
    position: fixed;
    top: 16px;
    right: 275px;
    width: 280px;
    max-width: calc(100vw - 32px);
    max-height: 65vh;
    overflow-y: auto;
    background: white;
    color: #1e293b;
    padding: 14px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.12);
    z-index: 2147483647;
    display: none;
    font-size: 12px;
    box-sizing: border-box;
    pointer-events: auto;
  `;
  document.body.appendChild(propertyPanel);

  // Show only values actually present in the loaded dataset.
  // source_properties holds original CSV columns when available.
  const originalKeys = [
    "population", "x", "y", "z", "side", "cell_type",
    "pc2l_subtype", "nt_type", "super_class", "sub_class",
  ];

  function showNeuronProperties(node: string) {
    if (networkMode === "circuit" && !isCircuitVisible(node)) return;

    // Build the panel first, so even missing metadata cannot hide the click.
    propertyPanel.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = "Neuron Properties";
    title.style.margin = "0 0 12px";
    propertyPanel.appendChild(title);

    const visibleGraph = renderer.getGraph();
    const attrs = visibleGraph.getNodeAttributes(node);
    const source = networkMode === "circuit"
      ? (attrs.circuitData as Record<string, unknown> | undefined)
      : (attrs as Record<string, unknown>);

    const sourceProperties = source?.source_properties;
    const original = sourceProperties && typeof sourceProperties === "object" && !Array.isArray(sourceProperties)
      ? sourceProperties as Record<string, unknown>
      : null;

    const properties: Record<string, unknown> = { root_id: node };
    if (original) {
      // These keys came from the original source columns, not the graph renderer.
      for (const [key, value] of Object.entries(original)) {
        if (key !== "root_id" && !["input_synapses", "output_synapses", "syn_count"].includes(key)) {
          properties[key] = value;
        }
      }
    } else if (source) {
      // Fallback only for original data fields actually returned by the API.
      // Never include edge/synapse calculations or Sigma drawing attributes.
      for (const key of originalKeys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          properties[key] = source[key];
        }
      }
    }

    for (const [key, value] of Object.entries(properties)) {
      if (value === null || value === undefined || value === "") continue;
      const row = document.createElement("div");
      row.style.cssText = "padding:6px 0;border-bottom:1px solid #e2e8f0;overflow-wrap:anywhere;";
      const label = document.createElement("strong");
      label.textContent = `${key}: `;
      const text = document.createElement("span");
      text.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
      row.append(label, text);
      propertyPanel.appendChild(row);
    }

    propertyPanel.style.display = "block";
    console.debug("LANCE neuron clicked:", node);
  }

  renderer.on("clickNode", ({ node }) => {
    showNeuronProperties(node);
  });

  // Catch clicks on other Sigma canvases if a custom drawing layer sits above
  // its normal mouse layer. This only affects neuron inspection.
  const nodePicker = renderer as unknown as {
    getNodeAtPosition?: (point: { x: number; y: number }) => string | null;
  };
  renderer.getContainer().addEventListener("click", (event) => {
    if (typeof nodePicker.getNodeAtPosition !== "function") return;
    const bounds = renderer.getContainer().getBoundingClientRect();
    const node = nodePicker.getNodeAtPosition({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    if (node) queueMicrotask(() => showNeuronProperties(node));
  }, true);

  renderer.on("clickStage", () => {
    propertyPanel.style.display = "none";
  });

  // One selector controls both straight and bundled layers
  function updateView() {
    networkMode = modeSelect.value as "whole" | "circuit";
    edgeMode = edgeSelect.value as "straight" | "bundled";

    const whole = networkMode === "whole";
    const bundled = edgeMode === "bundled";

    // Sigma now works on only 723 neurons when Circuit Mode is active.
    // Keep the same Sigma instance, camera and whole-brain bounding box.
    if (renderer.getGraph() !== (whole ? graph : circuitGraph)) {
      renderer.setGraph(whole ? graph : circuitGraph);
    }

    // Keep the custom canvas mounted behind Sigma's neuron canvas.
    renderer.getCanvases().nodes.before(canvas);
    canvas.style.zIndex = "";

    straightEdges.setVisible(whole && !bundled);
    bundleImage.style.display = whole && bundled ? "block" : "none";
    canvas.style.display = !whole && bundled ? "block" : "none";
    wholeLegend.style.display = whole ? "flex" : "none";
    legend.style.display = whole ? "none" : "flex";
    spikePlayback.setMode(networkMode);

    firstDrawLogged = false;
    renderer.refresh();

    // Explicit redraw after the display mode and graph have both changed.
    scheduleBundleDraw();
  }

  modeSelect.addEventListener("change", updateView);
  edgeSelect.addEventListener("change", updateView);
  updateView();

  // Collapsible controls panel
    const controlsPanel = document.getElementById("controls")!;

    // Keep existing controls together
    const panelContent = document.createElement("div");

    while (controlsPanel.firstChild) {
    panelContent.appendChild(controlsPanel.firstChild);
    }

    // Minimize button
    const minimizeButton = document.createElement("button");
    minimizeButton.textContent = "⌄";

    minimizeButton.style.cssText = `
    width: 100%;
    padding: 8px;
    cursor: pointer;
    font-weight: bold;
    border-radius: 6px;
    background: #f1f5f9;
    color: #334155;
    border: 1px solid #cbd5e1;
    `;

    controlsPanel.append(minimizeButton, panelContent);

    let minimized = false;
    const originalWidth = controlsPanel.style.width;
    const originalMinWidth = controlsPanel.style.minWidth;

    // Toggle panel visibility
    minimizeButton.addEventListener("click", () => {
    minimized = !minimized;

    panelContent.style.display = minimized ? "none" : "block";

    minimizeButton.textContent = minimized
        ? "Tab"
        : "⌄";

    controlsPanel.style.minWidth = minimized
        ? "0"
        : originalMinWidth;

    controlsPanel.style.width = minimized
        ? "110px"
        : originalWidth;
    });
}