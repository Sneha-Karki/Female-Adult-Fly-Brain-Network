import type Graph from "graphology";
import type Sigma from "sigma";

type Mode = "whole" | "circuit";

type SpikeResponse = {
  dt_ms: number;
  duration_ms: number;
  event_count: number;
  spikes: Record<string, Array<string | number>>;
  index_to_root?: Record<string, string>; // Whole-network events use compact indices.
  mapped_neurons?: number;
  firing_neurons?: number;
  mapped_circuit_neurons?: number;
  firing_circuit_neurons?: number;
};

export function setupSpikePlayback(
  renderer: Sigma,
  controls: HTMLElement,
  isCircuitVisible: (id: string) => boolean
) {
  const datasets: Partial<Record<Mode, SpikeResponse>> = {};
  const pending: Partial<Record<Mode, Promise<void>>> = {};
  const enabled: Record<Mode, boolean> = { whole: false, circuit: true };

  let mode: Mode = "whole";
  let playing = false;
  let timeMs = 0;
  let playbackSpeed = 0.01;
  let glowMs = 1;
  let lastFrame = 0;
  let raf: number | null = null;
  const activeIds = new Set<string>();

  // An independent overlay avoids a full Sigma refresh every spike frame.
  const canvas = renderer.createCanvas("spikePulses", { afterLayer: "nodes" });
  canvas.style.pointerEvents = "none";
  canvas.style.display = "none";
  canvas.style.background = "transparent";
  renderer.getCanvases().nodes.after(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Spike canvas unavailable");

  const panel = document.createElement("div");
  panel.style.cssText = "margin-top:16px;padding-top:12px;border-top:1px solid #d1d5db;";

  const heading = document.createElement("h4");
  heading.textContent = "Spike Playback";
  heading.style.margin = "0 0 8px";

  // This checkbox is remembered separately for Whole Network and Circuit.
  const enableLabel = document.createElement("label");
  enableLabel.style.cssText = "display:flex;gap:7px;align-items:center;font-size:13px;margin:8px 0;";
  const enableCheckbox = document.createElement("input");
  enableCheckbox.type = "checkbox";
  const enableText = document.createElement("span");
  enableLabel.append(enableCheckbox, enableText);

  const status = document.createElement("div");
  status.style.cssText = "font-size:12px;color:#475569;margin:6px 0;overflow-wrap:anywhere;";

  const timeLabel = document.createElement("div");
  timeLabel.style.cssText = "font-size:12px;margin:7px 0;";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1000";
  slider.step = "0.1"; // Johannes: one simulation step = 0.1 ms.
  slider.value = "0";
  slider.style.width = "100%";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
  const playButton = document.createElement("button");
  playButton.textContent = "▶ Play";
  const resetButton = document.createElement("button");
  resetButton.textContent = "Reset";

  const speedSelect = document.createElement("select");
  for (const [value, label] of [
    ["0.01", "0.01×"], ["0.02", "0.02×"],
    ["0.05", "0.05×"], ["0.1", "0.1×"],
    ["0.25", "0.25×"], ["0.5", "0.5×"],
    ["1", "1×"], ["2", "2×"], ["4", "4×"],
  ]) speedSelect.add(new Option(label, value));
  speedSelect.value = "0.01";
  speedSelect.title = "Playback speed";
  row.append(playButton, resetButton, speedSelect);

  const glowRow = document.createElement("label");
  glowRow.textContent = "Spike visibility: ";
  glowRow.style.cssText = "display:block;font-size:12px;margin-top:8px;";
  const glowSelect = document.createElement("select");
  for (const value of ["0.5", "1", "2", "5", "10"])
    glowSelect.add(new Option(`${value} ms`, value));
  glowSelect.value = "1";
  glowRow.append(glowSelect);

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;color:#64748b;margin-top:8px;";

  panel.append(heading, enableLabel, status, timeLabel, slider, row, glowRow, hint);
  controls.appendChild(panel);

  function currentData(): SpikeResponse | undefined {
    return datasets[mode];
  }

  function pause() {
    playing = false;
    playButton.textContent = "▶ Play";
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  // Only the current time window is inspected, not all 2.3 million events.
  function updateActive() {
    activeIds.clear();
    if (!enabled[mode]) return;
    const data = currentData();
    if (!data) return;

    const first = Math.max(0, Math.ceil((timeMs - glowMs - 1e-7) / data.dt_ms));
    const last = Math.min(9999, Math.floor((timeMs + 1e-7) / data.dt_ms));
    for (let step = first; step <= last; step++) {
      const fired = data.spikes[String(step)];
      if (!fired) continue;
      for (const value of fired) {
        const id = mode === "whole"
          ? data.index_to_root?.[String(value)]
          : String(value);
        if (!id) continue;
        if (mode === "circuit" && !isCircuitVisible(id)) continue;
        activeIds.add(id);
      }
    }
  }

  function draw() {
    if (!enabled[mode]) return;
    const container = renderer.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, width, height);

    const visibleGraph: Graph = renderer.getGraph();
    ctx!.fillStyle = "rgba(250, 204, 21, 0.95)";

    for (const id of activeIds) {
      if (!visibleGraph.hasNode(id)) continue;

      // Sigma's display size respects the circuit reducer and camera zoom.
      const displayed = renderer.getNodeDisplayData(id);
      if (!displayed || displayed.hidden) continue;

      const node = visibleGraph.getNodeAttributes(id);
      const x = Number(node.x), y = Number(node.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const p = renderer.graphToViewport({ x, y });
      const radius = Math.max(1.5, renderer.scaleSize(displayed.size));
      if (p.x < -radius || p.x > width + radius ||
          p.y < -radius || p.y > height + radius) continue;

      ctx!.beginPath();
      ctx!.arc(p.x, p.y, radius, 0, 2 * Math.PI);
      ctx!.fill();
    }
  }

  function updateUI() {
    const data = currentData();
    enableCheckbox.checked = enabled[mode];
    enableText.textContent = mode === "whole"
      ? "Show spikes in Whole Network"
      : "Show spikes in Circuit";
    const canPlay = enabled[mode] && !!data;
    playButton.disabled = !canPlay;
    slider.disabled = !canPlay;
    resetButton.disabled = !canPlay;
    timeLabel.textContent = `${timeMs.toFixed(1)} ms / 1000.0 ms`;
    slider.value = String(Math.min(1000, Math.max(0, timeMs)));
    canvas.style.display = canPlay ? "block" : "none";

    if (!enabled[mode]) {
      status.textContent = "Spikes off for this mode. Turn on to load its activity.";
    } else if (!data) {
      status.textContent = "Loading recorded spikes…";
    } else {
      const firing = data.firing_neurons ?? data.firing_circuit_neurons ?? 0;
      status.textContent =
        `Currently glowing: ${activeIds.size} | ` +
        `Neurons that fired: ${firing.toLocaleString()} | ` +
        `Recorded spikes: ${data.event_count.toLocaleString()}`;
    }
  }

  function seek(ms: number) {
    timeMs = Math.max(0, Math.min(1000, ms));
    updateActive();
    updateUI();
    draw();
  }

  // The simulation clock is shared between modes; mode-specific data is lazy-loaded.
  async function load(modeToLoad: Mode) {
    if (datasets[modeToLoad]) return;
    if (pending[modeToLoad]) return pending[modeToLoad];
    const endpoint = modeToLoad === "whole"
      ? "/network/whole/spikes"
      : "/network/circuit/spikes";

    pending[modeToLoad] = (async () => {
      const response = await fetch(`http://127.0.0.1:8003${endpoint}`);
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
      const data = await response.json() as SpikeResponse;
      if (!(data.dt_ms > 0) || !data.spikes)
        throw new Error(`${endpoint}: unexpected data format`);
      if (modeToLoad === "whole" && !data.index_to_root)
        throw new Error("Whole-network spikes need index_to_root mapping");
      datasets[modeToLoad] = data;
      console.log(`${modeToLoad} spikes loaded:`, {
        neuronsFired: data.firing_neurons ?? data.firing_circuit_neurons,
        events: data.event_count,
        timeStepsWithSpikes: Object.keys(data.spikes).length,
      });
    })();

    try {
      await pending[modeToLoad];
      if (mode === modeToLoad) seek(timeMs);
    } catch (error) {
      console.error(error);
      if (mode === modeToLoad) {
        enabled[modeToLoad] = false;
        updateUI();
        status.textContent = "Could not load spikes. Check FastAPI and try again.";
      }
    } finally {
      delete pending[modeToLoad];
    }
  }

  function tick(now: number) {
    raf = null;
    if (!playing || !enabled[mode] || !currentData()) return;
    const elapsed = Math.max(0, Math.min(now - lastFrame, 100));
    lastFrame = now;
    seek(timeMs + elapsed * playbackSpeed);
    if (timeMs >= 1000) { pause(); return; }
    raf = requestAnimationFrame(tick);
  }

  enableCheckbox.addEventListener("change", () => {
    pause();
    enabled[mode] = enableCheckbox.checked;
    updateActive();
    updateUI();
    if (enabled[mode]) void load(mode);
  });
  playButton.addEventListener("click", () => {
    if (!currentData() || !enabled[mode]) return;
    if (playing) { pause(); return; }
    if (timeMs >= 1000) seek(0);
    playing = true;
    playButton.textContent = "❚❚ Pause";
    lastFrame = performance.now();
    raf = requestAnimationFrame(tick);
  });
  slider.addEventListener("input", () => { pause(); seek(Number(slider.value)); });
  resetButton.addEventListener("click", () => { pause(); seek(0); });
  speedSelect.addEventListener("change", () => {
    playbackSpeed = Number(speedSelect.value);
  });
  glowSelect.addEventListener("change", () => {
    glowMs = Number(glowSelect.value);
    seek(timeMs);
  });

  renderer.on("afterRender", draw);
  updateUI();

  return {
    setMode(value: Mode) {
      // Keep the time position, but pause while changing rendering graphs.
      pause();
      mode = value;
      renderer.getCanvases().nodes.after(canvas);
      seek(timeMs);
      if (enabled[mode]) void load(mode);
    },
  };
}
