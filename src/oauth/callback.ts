import { randomBytes } from "node:crypto";
import { OAuthCallbackError, type OAuthProviderId } from "./types";

const CALLBACK_TIMEOUT_MS = 300_000;

export interface OAuthCallbackOptions {
  provider: OAuthProviderId;
  port: number;
  path: string;
  state: string;
  timeoutMs?: number;
}

export interface OAuthCallbackServer {
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => void;
}

type BunServer = ReturnType<typeof Bun.serve>;

const SUCCESS_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><meta charset=\"utf-8\"><title>SageRoute OAuth</title></head>",
  "<body style=\"font-family: system-ui, sans-serif; color: #111; padding: 4rem; text-align: center;\">",
  "<h1>Login complete</h1>",
  "<p>You can close this tab and return to SageRoute.</p>",
  "</body>",
  "</html>",
].join("");

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function errorHtml(message: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head><meta charset=\"utf-8\"><title>SageRoute OAuth</title></head>",
    "<body style=\"font-family: system-ui, sans-serif; color: #111; padding: 4rem; text-align: center;\">",
    "<h1>Login failed</h1>",
    `<p>${escapeHtml(message)}</p>`,
    "</body>",
    "</html>",
  ].join("");
}

function isAddrInUse(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("EADDRINUSE")
    || error.message.includes("address already in use")
    || error.message.includes("Failed to start server")
  );
}

function portHolder(port: number): string {
  try {
    const result = Bun.spawnSync({
      cmd: ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout).trim();
    const lines = output.split("\n").filter(Boolean);
    if (lines.length <= 1) return "No listening process was reported by lsof.";
    return `Listening process:\n${lines.slice(0, 3).join("\n")}`;
  } catch {
    return "Run lsof -nP -iTCP:" + port.toString() + " -sTCP:LISTEN to identify it.";
  }
}

function fixedPortMessage(provider: OAuthProviderId, port: number): string {
  return [
    `OAuth callback port ${port} is already in use on 127.0.0.1 for ${provider}.`,
    portHolder(port),
    "These OAuth apps have fixed registered redirect URIs, so SageRoute cannot fall back to another port.",
  ].join(" ");
}

function htmlResponse(ok: boolean, message: string): Response {
  return new Response(ok ? SUCCESS_HTML : errorHtml(message), {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function startOAuthCallbackServer(options: OAuthCallbackOptions): OAuthCallbackServer {
  let server: BunServer | undefined;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let completed: { code: string } | { error: Error } | undefined;

  const close = (): void => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    if (server) server.stop(true);
    server = undefined;
  };

  const settle = (result: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    completed = result;
    queueMicrotask(() => {
      if ("code" in result) resolveCode?.(result.code);
      else rejectCode?.(result.error);
    });
  };

  const waitForCode = async (): Promise<string> => {
    try {
      if (completed) {
        if ("code" in completed) return completed.code;
        throw completed.error;
      }
      return await new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
        if (completed) {
          if ("code" in completed) resolve(completed.code);
          else reject(completed.error);
          return;
        }
        timeout = setTimeout(() => {
          settle({
            error: new OAuthCallbackError(
              `OAuth callback timed out after ${Math.floor((options.timeoutMs ?? CALLBACK_TIMEOUT_MS) / 1000)}s`,
              options.provider,
            ),
          });
        }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS);
      });
    } finally {
      close();
    }
  };

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      reusePort: false,
      fetch(req: Request): Response {
        const url = new URL(req.url);
        if (url.pathname !== options.path) {
          return new Response("Not Found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        const error = url.searchParams.get("error");
        const description = url.searchParams.get("error_description") ?? error ?? "Authorization failed";

        if (state !== options.state) {
          return htmlResponse(false, "State mismatch. Return to SageRoute and try logging in again.");
        }
        if (error) {
          settle({ error: new OAuthCallbackError(`Authorization failed: ${description}`, options.provider) });
          return htmlResponse(false, "Authorization failed. Return to SageRoute and try logging in again.");
        }
        if (!code) {
          settle({ error: new OAuthCallbackError("OAuth callback did not include an authorization code", options.provider) });
          return htmlResponse(false, "Missing authorization code. Return to SageRoute and try logging in again.");
        }

        settle({ code });
        return htmlResponse(true, "");
      },
    });
  } catch (error) {
    if (isAddrInUse(error)) {
      throw new OAuthCallbackError(fixedPortMessage(options.provider, options.port), options.provider);
    }
    throw new OAuthCallbackError(
      `Could not start OAuth callback server on 127.0.0.1:${options.port}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      options.provider,
    );
  }

  return {
    redirectUri: `http://localhost:${options.port}${options.path}`,
    waitForCode,
    close,
  };
}
