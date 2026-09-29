import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors runtime-register.test.ts's mocking setup exactly, trimmed to only
// what this event's code path touches, so this file can be reviewed and
// maintained independently of the registration test suite.
const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  cloneMcpConfig: vi.fn((config: unknown) => structuredClone(config)),
  discoverConfiguredClaudePluginSkills: vi.fn(() => []),
  resolveConfiguredClaudePluginMcp: vi.fn((config: unknown) => structuredClone(config)),
  loadMetadataCache: vi.fn(() => null),
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
  writeProjectServerDisabledOverride: vi.fn(() => ({ path: "/tmp/project/.pi/mcp.json", changed: true })),
  executeCall: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  normalizeDirectToolInputSchema: vi.fn((schema: unknown) => schema),
  truncateAtWord: vi.fn((text: string) => text),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
  createOAuthRuntime: mocks.createOAuthRuntime,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: mocks.cloneMcpConfig,
  discoverConfiguredClaudePluginSkills: mocks.discoverConfiguredClaudePluginSkills,
  resolveConfiguredClaudePluginMcp: mocks.resolveConfiguredClaudePluginMcp,
  getLegacyMcpMigrationNotices: vi.fn(() => []),
  writeProjectServerDisabledOverride: mocks.writeProjectServerDisabledOverride,
}));

vi.mock("../metadata-cache.ts", () => ({
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tool-surface.ts", () => ({
  buildProxyDescription: mocks.buildProxyDescription,
  getLargeDirectToolsAdvisory: vi.fn(() => undefined),
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments: vi.fn((_schema: unknown, args: unknown) => args),
  resolveDirectTools: mocks.resolveDirectTools,
}));

vi.mock("../direct-tools.ts", () => ({
  createDirectToolExecutor: mocks.createDirectToolExecutor,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeCall: mocks.executeCall,
}));

vi.mock("../utils.ts", () => ({
  formatTerminalError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createState() {
  return {
    manager: {
      getAllConnections: () => new Map(),
      getConnection: vi.fn(() => undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      ensureConverged: vi.fn().mockResolvedValue(undefined),
      registerServer: vi.fn(),
      markKeepAlive: vi.fn(),
      unregisterServer: vi.fn(),
    },
    toolMetadata: new Map(),
    config: { mcpServers: {} } as { mcpServers: Record<string, unknown> },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel: string, listener: (data: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
  };
}

function createPi(events = createEventBus()) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["bash", "mcp"];
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      unregisterTool: vi.fn(() => true),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events,
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((nextActiveTools: string[]) => {
        activeTools = nextActiveTools;
      }),
    } as any,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("runtime MCP tool-call event", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) value.mockReset();
    }
    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  it("calls executeCall() through the shared event bus, from a distinct extension wrapper, and resolves the awaited promise result", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: { mode: "call" },
    });
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api: adapterApi, handlers } = createPi(events);
    const { api: consumerApi } = createPi(events);
    mcpAdapter(adapterApi);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = {
      version: 1 as const,
      tool: "docs_search",
      args: { query: "hello" },
    } as any;
    consumerApi.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    expect(request.result).toBeInstanceOf(Promise);
    const settled = await request.result;
    expect(settled).toMatchObject({ ok: true, result: { details: { mode: "call" } } });
    expect(mocks.executeCall).toHaveBeenCalledWith(
      state, "docs_search", { query: "hello" }, undefined, expect.any(Function), undefined, "script",
    );
  });

  it("passes an explicit server override through to executeCall()", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [], details: {} });
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api: adapterApi, handlers } = createPi(events);
    const { api: consumerApi } = createPi(events);
    mcpAdapter(adapterApi);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = {
      version: 1 as const,
      tool: "search",
      args: {},
      server: "docs",
    } as any;
    consumerApi.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);
    await request.result;

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state, "search", {}, "docs", expect.any(Function), undefined, "script",
    );
  });

  it("returns ok:false without calling executeCall() when MCP initialization itself fails", async () => {
    mocks.initializeMcp.mockRejectedValue(new Error("no mcp config found"));
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api } = createPi(events);
    mcpAdapter(api);
    // Deliberately do not fire session_start; the event itself starts
    // initialization (Issue 1 fix), and that initialization fails here.

    const request = { version: 1 as const, tool: "search" } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    const settled = await request.result;
    expect(settled.ok).toBe(false);
    expect(mocks.executeCall).not.toHaveBeenCalled();
  });

  it("rejects an empty tool name without calling executeCall()", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = { version: 1 as const, tool: "   " } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    const settled = await request.result;
    expect(settled.ok).toBe(false);
    expect(mocks.executeCall).not.toHaveBeenCalled();
  });

  it("returns ok:false, not a throw, when executeCall() itself rejects (transport-level failure)", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockRejectedValue(new Error("connection closed"));
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = { version: 1 as const, tool: "search" } as any;
    expect(() => api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request)).not.toThrow();

    const settled = await request.result;
    expect(settled).toMatchObject({ ok: false, error: { message: "connection closed" } });
  });

  it("returns ok:false, not ok:true, when executeCall() RESOLVES with details.error (the real failure shape -- denial, tool error, disabled server)", async () => {
    // executeCall() does not reject for a denied approval or a tool-level
    // error; it resolves normally with details.error set (Issue 2 from
    // review). This is the shape a real failed call actually takes.
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({
      content: [{ type: "text", text: "Tool call denied by approval policy" }],
      details: { mode: "call", error: "approval_denied", server: "docs" },
    });
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = { version: 1 as const, tool: "search" } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    const settled = await request.result;
    expect(settled.ok).toBe(false);
    expect((settled as { ok: false; error: Error }).error.message).toMatch(/approval_denied/);
  });

  it("starts MCP initialization when neither state nor initPromise exist yet (deferred-init session, Issue 1 from review)", async () => {
    // A session using valid cached metadata defers real MCP init until
    // something needs it -- both state and initPromise are absent, exactly
    // like the mcp proxy tool's own first call sees. The event must start
    // initialization itself rather than refusing, since it has no
    // ExtensionContext to hand to ensureSessionRuntime() the way a real
    // tool call does.
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [], details: {} });
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api } = createPi(events);
    mcpAdapter(api);
    // Deliberately do not fire session_start -- state and initPromise both
    // start null/absent, simulating a deferred-init session.

    const request = { version: 1 as const, tool: "search" } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    const settled = await request.result;
    expect(settled.ok).toBe(true);
    expect(mocks.initializeMcp).toHaveBeenCalled();
    expect(mocks.executeCall).toHaveBeenCalledWith(
      state, "search", undefined, undefined, expect.any(Function), undefined, "script",
    );
  });

  it("leaves a prefilled event result untouched (first listener wins)", async () => {
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const prefilled = Promise.resolve({ ok: true, result: { content: [], details: {} } } as const);
    const request = { version: 1 as const, tool: "search", result: prefilled } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    expect(request.result).toBe(prefilled);
  });

  it("reports an unsupported version without calling executeCall()", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = { version: 2 as any, tool: "search" } as any;
    api.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);

    const settled = await request.result;
    expect(settled.ok).toBe(false);
    expect(mocks.executeCall).not.toHaveBeenCalled();
  });
});
