// Keel WebMCP bridge. Runs in the page's main world and answers the isolated
// content script over window.postMessage.
//
// WebMCP is an emerging standard that lets a page expose structured tools to
// agents (navigator.modelContext and several interim polyfills). When a page
// offers tools, structured calls beat raw DOM actuation for reliability, so
// Keel prefers them. When nothing is exposed, Keel falls back to the DOM.
(() => {
  if (window.__keelWebmcpBridge) return;
  window.__keelWebmcpBridge = true;

  function findSurface() {
    const candidates = [
      { name: "navigator.modelContext", obj: navigator.modelContext },
      { name: "window.modelContext", obj: window.modelContext },
      { name: "navigator.mcp", obj: navigator.mcp },
      { name: "window.mcp", obj: window.mcp },
      { name: "window.webmcp", obj: window.webmcp }
    ];
    for (const candidate of candidates) {
      if (candidate.obj && typeof candidate.obj === "object") return candidate;
    }
    return null;
  }

  function extractTools(surface) {
    const obj = surface.obj;
    let raw = null;
    try {
      if (Array.isArray(obj.tools)) raw = obj.tools;
      else if (typeof obj.listTools === "function") raw = obj.listTools();
      else if (typeof obj.getTools === "function") raw = obj.getTools();
      else if (obj.registeredTools && typeof obj.registeredTools === "object") raw = Object.values(obj.registeredTools);
    } catch (_) {
      raw = null;
    }
    if (raw && typeof raw.then === "function") return raw; // promise resolved by caller
    return Promise.resolve(raw);
  }

  function summarizeTool(tool) {
    if (!tool) return null;
    const name = tool.name || tool.id || null;
    if (!name) return null;
    return {
      name,
      description: String(tool.description || "").slice(0, 300),
      inputSchema: tool.inputSchema || tool.input_schema || tool.parameters || null
    };
  }

  async function detect() {
    const surface = findSurface();
    if (!surface) return { ok: true, available: false };
    let tools = [];
    try {
      const raw = await extractTools(surface);
      if (Array.isArray(raw)) tools = raw.map(summarizeTool).filter(Boolean);
    } catch (_) {
      tools = [];
    }
    return { ok: true, available: true, surface: surface.name, tools };
  }

  async function callTool(payload) {
    const surface = findSurface();
    if (!surface) return { ok: false, error: "No WebMCP surface on this page." };
    const obj = surface.obj;
    const name = payload?.tool;
    const args = payload?.args || {};
    try {
      let result;
      if (typeof obj.callTool === "function") {
        result = await obj.callTool({ name, arguments: args });
      } else if (typeof obj.execute === "function") {
        result = await obj.execute(name, args);
      } else if (obj.registeredTools?.[name]?.execute) {
        result = await obj.registeredTools[name].execute(args);
      } else if (obj.registeredTools?.[name]?.handler) {
        result = await obj.registeredTools[name].handler(args);
      } else {
        return { ok: false, error: "The page's WebMCP surface has no callable tool interface." };
      }
      let text = "";
      if (result && Array.isArray(result.content)) {
        text = result.content.map((c) => c.text || "").join("\n");
      } else if (typeof result === "string") {
        text = result;
      } else {
        try { text = JSON.stringify(result).slice(0, 4000); } catch (_) { text = String(result); }
      }
      return { ok: true, result: text };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.source !== "keel-content" || !data.id || !data.op) return;
    let result;
    if (data.op === "detect") result = await detect();
    else if (data.op === "call") result = await callTool(data.payload);
    else result = { ok: false, error: "unknown op" };
    window.postMessage({ source: "keel-webmcp-bridge", id: data.id, result }, "*");
  });
})();
