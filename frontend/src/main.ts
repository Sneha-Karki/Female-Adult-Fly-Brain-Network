import "./style.css";

import Graph from "graphology";
import Sigma from "sigma";
import { setupStraightEdges } from "./straightEdges";
// Pastel colors for neuron populations
import { getCameraStateToFitViewportToNodes } from "@sigma/utils";
import { setupCircuitMode } from "./circuitMode";

const populationColors: Record<string, string> = {
      "optic": "#2563eb",
      "central": "#e11d48",
      "sensory": "#16a34a",
      "visual_projection": "#9333ea",
      "ascending": "#f97316",
      "descending": "#06b6d4",
      "sensory_ascending": "#eab308",
      "visual_centrifugal": "#db2777",
      "motor": "#64748b",
      "endocrine": "#14b8a6"
};

// Colors for the JO circuit
const joColors: Record<string, string> = {
  "JO-A": "#2563EB",
  "JO-B": "#06B6D4",
  "pC2l": "#E11D48",
  "Intermediate": "#F59E0B",
};

async function main() {

  // Get whole network from FastAPI
  const response = await fetch(
    "http://127.0.0.1:8003/network/whole"
  );

  if (!response.ok) {
    throw new Error("Failed to load whole network");
  }

  const nodes = await response.json();

  console.log("Total neurons:", nodes.length);

  // Create graph
  // Allow circuit connections between the same neurons
  const graph = new Graph({
    type: "directed",
    multi: true,
  });

  // Add neurons using original FAFB positions
  for (const node of nodes) {

    const x = Number(node.x);
    const y = Number(node.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    graph.addNode(String(node.id), {
      x,
      y,
      size: 3,
      label: "",
      color: populationColors[node.super_class] || "#CBD5E1",
      superClass: node.super_class,
      side: node.side,
      joType: node.jo_type,
    });
  }

  console.log("Graph nodes:", graph.order);

  // Create Sigma renderer
  const container = document.getElementById("sigma-container");

  if (!container) {
    throw new Error("Sigma container missing");
  }

  const renderer = new Sigma(graph, container, {
    renderLabels: false,
    zIndex: true,
  });

  // Get the whole brain's coordinate boundaries
  const bbox = renderer.getBBox();

  const minX = bbox.x[0];
  const maxX = bbox.x[1];
  const minY = bbox.y[0];
  const maxY = bbox.y[1];

  // Load the precomputed bundled-edge image
  const bundleImage = new Image();

  bundleImage.style.position = "absolute";
  bundleImage.style.pointerEvents = "none";
  bundleImage.style.opacity = "0.9";

  // Keep edges behind the neurons
  container.prepend(bundleImage);

  // Align the image with Sigma's coordinates
  function updateBundles() {

    const topLeft = renderer.graphToViewport({
      x: minX,
      y: maxY,
    });

    const bottomRight = renderer.graphToViewport({
      x: maxX,
      y: minY,
    });

    bundleImage.style.left = `${topLeft.x}px`;
    bundleImage.style.top = `${topLeft.y}px`;

    bundleImage.style.width =
      `${bottomRight.x - topLeft.x}px`;

    bundleImage.style.height =
      `${bottomRight.y - topLeft.y}px`;
  }

  // Update when zooming or panning
  renderer.on("afterRender", updateBundles);

  bundleImage.onload = () => {
    updateBundles();
    console.log("Bundled edges loaded");
  };

  bundleImage.onerror = () => {
    console.error("Failed to load bundled edges");
  };

  bundleImage.src =
    "http://127.0.0.1:8003/network/whole/bundles.png?v=2";

  // Load straight connections
  const straightEdges = await setupStraightEdges(renderer, nodes);

  // Show straight connections by default
  bundleImage.style.display = "none";

  // Toggle between straight and bundled edges
  let showBundling = false;

  const edgeButton = document.createElement("button");

  edgeButton.textContent = "Edge Bundling: OFF";

  edgeButton.addEventListener("click", () => {
    showBundling = !showBundling;

    straightEdges.setVisible(!showBundling);

    bundleImage.style.display = showBundling ? "block" : "none";

    edgeButton.textContent = showBundling
      ? "Edge Bundling: ON"
      : "Edge Bundling: OFF";
  });

  document.getElementById("controls")!.appendChild(edgeButton);
  // Find JO-A, JO-B, and pC2l neurons
  const joFocusIds = graph.filterNodes((_id, attrs) => {

    const type = String(attrs.joType ?? "");

    return (
      type === "JO-A" ||
      type === "JO-B" ||
      type.startsWith("pC2l")
    );
  });

  console.log("JO focus neurons:", joFocusIds.length);

  // Save camera position before zooming
  let previousCamera = renderer.getCamera().getState();

  let focusOnlyJO = false;

  // Create focus button
  const focusButton = document.createElement("button");

  focusButton.textContent = "Focus JO Circuit";

  document.getElementById("controls")!.appendChild(focusButton);

  // Smooth transition between whole brain and JO circuit
  focusButton.addEventListener("click", async () => {

    focusButton.disabled = true;

    try {

      if (!focusOnlyJO) {

        // Remember current camera
        previousCamera = { ...renderer.getCamera().getState() };

        // Hide whole-brain connections
        straightEdges.setVisible(false);
        bundleImage.style.display = "none";

        // Highlight JO neurons
        highlightJO = true;
        renderer.refresh();

        // Calculate the camera position for JO neurons
        const target = getCameraStateToFitViewportToNodes(
          renderer,
          joFocusIds
        );

        // Animate toward the JO circuit
        await renderer.getCamera().animate(target, {
          duration: 1000,
          easing: "quadraticInOut",
        });

        focusOnlyJO = true;

        focusButton.textContent = "Back to Whole Brain";

      } else {

        // Return to whole-brain view
        focusOnlyJO = false;
        highlightJO = false;

        await renderer.getCamera().animate(previousCamera, {
          duration: 1000,
          easing: "quadraticInOut",
        });

        // Restore the selected edge mode
        if (showBundling) {
          bundleImage.style.display = "block";
        } else {
          straightEdges.setVisible(true);
        }

        focusButton.textContent = "Focus JO Circuit";

      }

      renderer.refresh();

    } finally {
      focusButton.disabled = false;
    }

  });
  // Highlight JO circuit
  let highlightJO = false;

  const joButton = document.getElementById(
    "jo-button"
  ) as HTMLButtonElement;

  joButton.addEventListener("click", () => {

    highlightJO = !highlightJO;

    joButton.textContent = highlightJO
      ? "Show All Populations"
      : "Highlight JO Circuit";

    renderer.refresh();
  });

  // Change colors without changing positions
  renderer.setSetting("nodeReducer", (node, data) => {

    // Show only selected JO populations in focused view
    if (focusOnlyJO) {

      const type = String(
        graph.getNodeAttribute(node, "joType") ?? ""
      );

      const isJO =
        type === "JO-A" ||
        type === "JO-B" ||
        type.startsWith("pC2l");

      if (!isJO) {
        return { ...data, hidden: true };
      }
    }

    if (!highlightJO) return data;

    const attrs = graph.getNodeAttributes(node);
    const type = attrs.joType as string | null;

    if (!type) {
      return {
        ...data,
        color: "#EDF2F7",
        size: 1,
        zIndex: 0,
      };
    }

    const group = type.startsWith("pC2l")
      ? "pC2l"
      : type;

    return {
      ...data,
      color: joColors[group] || "#F59E0B",
      size: 5,
      zIndex: 2,
    };
  });

  renderer.refresh();

  // Add Whole Network and Circuit modes
  await setupCircuitMode(
    renderer,
    graph,
    straightEdges,
    bundleImage
  );

  console.log("FAFB Sigma visualization ready");
}

main().catch(console.error);