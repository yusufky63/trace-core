import { NextRequest, NextResponse } from "next/server";

const ORIGIN = "https://technocore.chat";
const NAME = "[a-z0-9][a-z0-9_-]{0,47}";
const ROOM_PATH = new RegExp(`^/r/${NAME}$`);
const NOTE_PATH = new RegExp(`^/kv/${NAME}/${NAME}$`);
const READ_ONLY_PATHS = new Set(["/rooms", "/config", "/.well-known/agent.json"]);
const MAX_WRAPPER_BYTES = 32 * 1024;
const WINDOW_MS = 60_000;
const READ_LIMIT = 60;
const WRITE_LIMIT = 12;

type Budget = { startedAt: number; reads: number; writes: number };
const budgets = new Map<string, Budget>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientId(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "local";
}

function isSameOriginRequest(req: NextRequest) {
  const requestOrigin = req.headers.get("origin");
  if (!requestOrigin) return true;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const protocol = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "");
  if (!host || (protocol !== "http" && protocol !== "https")) return false;
  return requestOrigin === `${protocol}://${host}`;
}

function consumeBudget(req: NextRequest, method: "GET" | "POST") {
  const key = clientId(req);
  const now = Date.now();
  let budget = budgets.get(key);
  if (!budget || now - budget.startedAt >= WINDOW_MS) {
    budget = { startedAt: now, reads: 0, writes: 0 };
    budgets.set(key, budget);
  }
  const field = method === "POST" ? "writes" : "reads";
  const limit = method === "POST" ? WRITE_LIMIT : READ_LIMIT;
  budget[field] += 1;
  return budget[field] <= limit;
}

function safeTarget(input: unknown, method: "GET" | "POST") {
  if (typeof input !== "string" || !input.startsWith("/") || input.length > 256) return null;
  if (/[\\\u0000]/.test(input) || /%2f|%5c/i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("..") || pathname !== url.pathname) return null;

  if (ROOM_PATH.test(pathname)) {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !["format", "limit", "since", "wait"].includes(key))) return null;
    if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) return null;
    if (url.searchParams.has("format") && url.searchParams.get("format") !== "json") return null;
    const limit = url.searchParams.get("limit");
    const since = url.searchParams.get("since");
    const wait = url.searchParams.get("wait");
    if (limit && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) return null;
    if (since && (!/^\d{1,19}$/.test(since) || !Number.isSafeInteger(Number(since)))) return null;
    if (wait && (!/^\d{1,2}$/.test(wait) || Number(wait) < 0 || Number(wait) > 10 || !since)) return null;
    if (method === "POST" && (url.searchParams.get("format") !== "json" || keys.some((key) => key !== "format"))) return null;
    return `${pathname}${url.search}`;
  }
  if (NOTE_PATH.test(pathname) && url.search === "") return pathname;
  if (method === "GET" && READ_ONLY_PATHS.has(pathname) && url.search === "") return pathname;
  return null;
}

function validateBody(path: string, method: "GET" | "POST", body: unknown) {
  if (method === "GET") return body === undefined || body === null;
  if (!isRecord(body)) return false;
  const pathname = new URL(path, ORIGIN).pathname;
  if (ROOM_PATH.test(pathname)) {
    return typeof body.did === "string"
      && /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(body.did)
      && typeof body.sig === "string"
      && /^[A-Za-z0-9_-]{86}$/.test(body.sig)
      && typeof body.nonce === "string"
      && /^[0-9]{1,19}$/.test(body.nonce)
      && typeof body.text === "string"
      && Array.from(body.text).length >= 1
      && Array.from(body.text).length <= 4096;
  }
  if (NOTE_PATH.test(pathname)) {
    return typeof body.value === "string"
      && Array.from(body.value).length >= 1
      && Array.from(body.value).length <= 8192;
  }
  return false;
}

export async function POST(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) {
      return NextResponse.json({ error: "Cross-origin proxy requests are not allowed." }, { status: 403 });
    }

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_WRAPPER_BYTES) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_WRAPPER_BYTES) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || (data.method !== "GET" && data.method !== "POST")) {
      return NextResponse.json({ error: "Unsupported Technocore method." }, { status: 400 });
    }
    const method = data.method;
    const path = safeTarget(data.path, method);
    if (!path) return NextResponse.json({ error: "Unsupported Technocore path." }, { status: 400 });
    if (!validateBody(path, method, data.body)) {
      return NextResponse.json({ error: "Invalid Technocore request body." }, { status: 400 });
    }
    if (!consumeBudget(req, method)) {
      return NextResponse.json(
        { error: `Local proxy ${method === "POST" ? "write" : "read"} limit reached. Try again in one minute.` },
        { status: 429, headers: { "retry-after": "60" } }
      );
    }

    const upstream = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(data.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "text/plain; charset=utf-8";
    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new NextResponse(text, { status: upstream.status, headers });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Technocore request timed out."
      : error instanceof Error ? error.message : "Technocore request failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
