import Sigma from "sigma";

const EDGE_LIMIT = 22_285_323; // Start small to test performance

export async function setupStraightEdges(renderer: Sigma, nodes: any[]) {

  // Create a WebGL layer behind Sigma's neurons
  const canvas = renderer.createCanvas("straightEdges", {
    afterLayer: "edges",
  });

  canvas.style.pointerEvents = "none";
  canvas.style.display = "none";

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
  });

  if (!gl) throw new Error("WebGL2 is unavailable");

  // Get the original neuron coordinate boundaries
  const bbox = renderer.getBBox();

  const minX = bbox.x[0];
  const minY = bbox.y[0];
  const rangeX = bbox.x[1] - minX || 1;
  const rangeY = bbox.y[1] - minY || 1;

  // Store neuron positions in a GPU texture
  const textureWidth = 1024;
  const textureHeight = Math.ceil(nodes.length / textureWidth);

  const positions = new Float32Array(
    textureWidth * textureHeight * 4
  );

  nodes.forEach((node, index) => {
    const offset = index * 4;

    positions[offset] = (Number(node.x) - minX) / rangeX;
    positions[offset + 1] = (Number(node.y) - minY) / rangeY;
  });

  const positionTexture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, positionTexture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    textureWidth,
    textureHeight,
    0,
    gl.RGBA,
    gl.FLOAT,
    positions
  );

  // Vertex shader: look up each neuron's position
  const vertexShaderSource = `#version 300 es
    precision highp float;
    precision highp int;

    layout(location = 0) in uint aIndex;

    uniform sampler2D uPositions;
    uniform int uTextureWidth;

    uniform vec2 uOrigin;
    uniform vec2 uAxisX;
    uniform vec2 uAxisY;

    void main() {
      ivec2 pixel = ivec2(
        int(aIndex) % uTextureWidth,
        int(aIndex) / uTextureWidth
      );

      vec2 position = texelFetch(uPositions, pixel, 0).xy;

      vec2 clip = uOrigin
                + position.x * uAxisX
                + position.y * uAxisY;

      gl_Position = vec4(clip, 0.0, 1.0);
    }
  `;

  // Fragment shader: color the connections
  const fragmentShaderSource = `#version 300 es
    precision mediump float;

    out vec4 color;

    void main() {
      color = vec4(0.04, 0.05, 0.07, 0.25);
    }
  `;

  // Compile a WebGL shader
  function compile(type: number, source: string) {
    const shader = gl!.createShader(type)!;

    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);

    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      throw new Error(gl!.getShaderInfoLog(shader) || "Shader error");
    }

    return shader;
  }

  const program = gl.createProgram()!;

  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, vertexShaderSource)
  );

  gl.attachShader(
    program,
    compile(gl.FRAGMENT_SHADER, fragmentShaderSource)
  );

  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Link error");
  }

  // Fetch the compact connections
  // Download only the edges we're testing
    const response = await fetch(
    "http://127.0.0.1:8003/network/whole/straight.bin",
    {
        headers: {
        Range: `bytes=0-${EDGE_LIMIT * 8 - 1}`
        }
    }
    );
  if (!response.ok) {
    throw new Error("Failed to load straight connections");
  }

  const binary = await response.arrayBuffer();

  const edgeCount = Math.min(
    EDGE_LIMIT,
    Math.floor(binary.byteLength / 8)
  );

  console.log("Straight connections to render:", edgeCount);

  // Upload connection indices to the GPU
  const edgeBuffer = gl.createBuffer();

  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);

  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Uint32Array(binary, 0, edgeCount * 2),
    gl.STATIC_DRAW
  );

  gl.useProgram(program);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 0, 0);

  gl.uniform1i(
    gl.getUniformLocation(program, "uPositions"),
    0
  );

  gl.uniform1i(
    gl.getUniformLocation(program, "uTextureWidth"),
    textureWidth
  );

  let visible = true;

  // Draw actual straight connections
  function draw() {
    if (!visible) return;

    const width = canvas.parentElement!.clientWidth;
    const height = canvas.parentElement!.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    if (!width || !height) return;

    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    // Convert the anatomical boundaries to screen coordinates
    const a = renderer.graphToViewport({ x: minX, y: minY });
    const b = renderer.graphToViewport({
      x: minX + rangeX,
      y: minY,
    });
    const c = renderer.graphToViewport({
      x: minX,
      y: minY + rangeY,
    });

    const clip = (point: { x: number; y: number }) => ({
      x: (2 * point.x) / width - 1,
      y: 1 - (2 * point.y) / height,
    });

    const origin = clip(a);
    const axisX = clip(b);
    const axisY = clip(c);

    gl!.useProgram(program);

    gl!.uniform2f(
      gl!.getUniformLocation(program, "uOrigin"),
      origin.x,
      origin.y
    );

    gl!.uniform2f(
      gl!.getUniformLocation(program, "uAxisX"),
      axisX.x - origin.x,
      axisX.y - origin.y
    );

    gl!.uniform2f(
      gl!.getUniformLocation(program, "uAxisY"),
      axisY.x - origin.x,
      axisY.y - origin.y
    );

    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, positionTexture);

    gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeBuffer);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribIPointer(0, 1, gl!.UNSIGNED_INT, 0, 0);

    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);

    // Draw all edges in smaller WebGL batches
    const edgesPerDraw = 2_000_000;

    for (let start = 0; start < edgeCount; start += edgesPerDraw) {

    const count = Math.min(edgesPerDraw, edgeCount - start);

    // Move to the next batch in the GPU buffer
    gl!.vertexAttribIPointer(
        0,
        1,
        gl!.UNSIGNED_INT,
        0,
        start * 2 * 4
    );

    // Draw this batch
    gl!.drawArrays(gl!.LINES, 0, count * 2);
    };
  }

  // Redraw connections when zooming or panning
  renderer.on("afterRender", draw);

  canvas.style.display = "block";
  draw();

  return {
    setVisible(value: boolean) {
      visible = value;
      canvas.style.display = value ? "block" : "none";

      if (visible) draw();
    },
  };
}