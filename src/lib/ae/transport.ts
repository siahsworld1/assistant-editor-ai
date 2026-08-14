// Transport abstraction between the UI and the local Assistant Editor engine.
//
// Two implementations exist:
//  - DirectLoopbackTransport: plain fetch to http://127.0.0.1:32145 (desktop/localhost)
//  - DesktopBridgeTransport:  placeholder that proxies through a bridge object the
//    packaged desktop companion injects on window. Hosted HTTPS previews cannot
//    reach loopback (mixed content / private network access), so the bridge is the
//    supported path there.

export const ENGINE_BASE_URL = "http://127.0.0.1:32145";

export type TransportId = "direct-loopback" | "desktop-bridge";

export interface TransportRequest {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

export interface EngineTransport {
  readonly id: TransportId;
  readonly label: string;
  readonly target: string;
  request(req: TransportRequest): Promise<unknown>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** Shape the desktop shell injects (see electron/preload.cjs). */
export interface DesktopBridgeRequest {
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface DesktopBridgeResponse {
  status: number;
  body: unknown;
  /** Normalized, stack-trace-free failure message from the main process. */
  error?: string;
}

export interface DesktopBridgeApi {
  request(req: DesktopBridgeRequest): Promise<DesktopBridgeResponse>;
  version?: string;
  target?: string;
}

export class DirectLoopbackTransport implements EngineTransport {
  readonly id = "direct-loopback" as const;
  readonly label = "Direct loopback";
  readonly target = ENGINE_BASE_URL;

  async request({ path, method = "GET", body, timeoutMs = 5000 }: TransportRequest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${ENGINE_BASE_URL}${path}`, {
        method,
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new TransportError(`Engine responded ${res.status}`, res.status);
      const text = await res.text();
      if (!text) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new TransportError("Engine returned a non-JSON payload");
      }
    } catch (err) {
      if (err instanceof TransportError) throw err;
      const reason = err instanceof Error ? err.message : "unknown error";
      throw new TransportError(`${ENGINE_BASE_URL}${path} unreachable (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Placeholder for the packaged desktop companion. The shell injects
 * window.assistantEditorBridge; until then this transport is never selected.
 */
export class DesktopBridgeTransport implements EngineTransport {
  readonly id = "desktop-bridge" as const;
  readonly label = "Desktop bridge";
  readonly target = "window.assistantEditorBridge";

  constructor(private readonly bridge: DesktopBridgeApi) {}

  static detect(): DesktopBridgeApi | null {
    if (typeof window === "undefined") return null;
    return window.assistantEditorBridge ?? null;
  }

  async request({ path, method = "GET", body, timeoutMs }: TransportRequest) {
    let res: DesktopBridgeResponse;
    try {
      res = await this.bridge.request({
        path,
        method,
        ...(body === undefined ? {} : { body }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch {
      throw new TransportError("Desktop bridge did not respond");
    }
    if (res.error) throw new TransportError(res.error, res.status || undefined);
    if (res.status < 200 || res.status >= 300) {
      throw new TransportError(`Engine responded ${res.status}`, res.status);
    }
    return res.body;
  }
}

export type HostContext = "desktop-bridge" | "localhost" | "remote-https" | "server";

export function detectHostContext(): HostContext {
  if (typeof window === "undefined") return "server";
  if (DesktopBridgeTransport.detect()) return "desktop-bridge";
  const { protocol, hostname } = window.location;
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (isLoopback) return "localhost";
  if (protocol === "https:") return "remote-https";
  return "localhost";
}

export interface ResolvedTransport {
  transport: EngineTransport | null;
  host: HostContext;
  /** Present when no transport can be used from this origin. */
  blockedReason: string | null;
}

export function resolveTransport(): ResolvedTransport {
  const host = detectHostContext();
  const bridge = DesktopBridgeTransport.detect();
  if (bridge) {
    return { transport: new DesktopBridgeTransport(bridge), host, blockedReason: null };
  }
  if (host === "remote-https") {
    return {
      transport: null,
      host,
      blockedReason:
        "This hosted HTTPS preview cannot open a connection to http://127.0.0.1:32145 (mixed content / private network access). Run the UI inside the Assistant Editor desktop companion — or on localhost — to reach the engine.",
    };
  }
  if (host === "server") {
    return { transport: null, host, blockedReason: "No browser context." };
  }
  return { transport: new DirectLoopbackTransport(), host, blockedReason: null };
}
