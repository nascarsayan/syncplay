import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const APP_NAME = "syncplay";
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "syncplay.db");
const VIDEO_DIR = process.env.VIDEO_DIR ?? path.join(process.cwd(), "videos");
const VIDEO_ROOT = path.resolve(VIDEO_DIR);
const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV ?? "development";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 24 * 7);
const LOG_LEVEL = process.env.LOG_LEVEL ?? "debug";


const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const TEST_USERS = (process.env.TEST_USERS ?? "").split(",").map((v) => v.trim()).filter(Boolean);

const LOG_LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 20;
function logDebug(...args: any[]) {
  if (currentLogLevel > LOG_LEVELS.debug) return;
  console.log("[debug]", ...args);
}
function logInfo(...args: any[]) {
  if (currentLogLevel > LOG_LEVELS.info) return;
  console.log("[info]", ...args);
}
function logWarn(...args: any[]) {
  if (currentLogLevel > LOG_LEVELS.warn) return;
  console.warn("[warn]", ...args);
}
function logError(...args: any[]) {
  if (currentLogLevel > LOG_LEVELS.error) return;
  console.error("[error]", ...args);
}

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(VIDEO_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    email TEXT,
    uses_remaining INTEGER NOT NULL,
    expires_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS room_state (
    room_id TEXT PRIMARY KEY,
    video_path TEXT,
    position REAL NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 1,
    playback_rate REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function hashPath(input: string) {
  return createHash("sha1").update(input).digest("hex");
}

function parseCookies(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function setCookie(name: string, value: string, options: Record<string, string | number | boolean> = {}) {
  const attrs: string[] = [`${name}=${encodeURIComponent(value)}`];
  for (const [key, val] of Object.entries(options)) {
    if (val === false || val === undefined || val === null) continue;
    if (val === true) {
      attrs.push(key);
    } else {
      attrs.push(`${key}=${val}`);
    }
  }
  return attrs.join("; ");
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSession(request: Request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies["sp_session"];
  if (!token) return null;
  const row = db
    .query(
      `SELECT sessions.token, sessions.expires_at, users.id as user_id, users.email, users.is_admin
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`
    )
    .get(token) as
    | { token: string; expires_at: string; user_id: number; email: string; is_admin: number }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.query("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { userId: row.user_id, email: row.email, isAdmin: row.is_admin === 1 };
}

function upsertUser(email: string, isAdmin: boolean) {
  db.query(
    `INSERT INTO users (email, is_admin, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET is_admin = excluded.is_admin`
  ).run(email, isAdmin ? 1 : 0, nowIso());
}

function seedUsers() {
  if (NODE_ENV !== "production" && TEST_USERS.length === 0) {
    TEST_USERS.push("admin@example.com", "user1@example.com", "user2@example.com");
  }
  for (const email of TEST_USERS) {
    upsertUser(email, true);
  }
  for (const email of ADMIN_EMAILS) {
    upsertUser(email, true);
  }
}

seedUsers();

function getRoomState(roomId: string) {
  const row = db
    .query(
      `SELECT room_id, video_path, position, paused, playback_rate, updated_at
       FROM room_state WHERE room_id = ?`
    )
    .get(roomId) as
    | {
        room_id: string;
        video_path: string | null;
        position: number;
        paused: number;
        playback_rate: number;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    const state = {
      room_id: roomId,
      video_path: null,
      position: 0,
      paused: 1,
      playback_rate: 1,
      updated_at: nowIso(),
    };
    db.query(
      `INSERT INTO room_state (room_id, video_path, position, paused, playback_rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(state.room_id, state.video_path, state.position, state.paused, state.playback_rate, state.updated_at);
    return state;
  }
  return row;
}

function updateRoomState(roomId: string, updates: Partial<{ video_path: string | null; position: number; paused: number; playback_rate: number }>) {
  const current = getRoomState(roomId);
  const next = {
    video_path: updates.video_path ?? current.video_path,
    position: updates.position ?? current.position,
    paused: updates.paused ?? current.paused,
    playback_rate: updates.playback_rate ?? current.playback_rate,
    updated_at: nowIso(),
  };
  db.query(
    `UPDATE room_state SET video_path = ?, position = ?, paused = ?, playback_rate = ?, updated_at = ? WHERE room_id = ?`
  ).run(next.video_path, next.position, next.paused, next.playback_rate, next.updated_at, roomId);
  return { room_id: roomId, ...next };
}

async function listVideoFiles(dir: string) {
  const byDir = new Map<string, string[]>();

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if ([".mp4", ".webm", ".mkv", ".mov"].includes(ext)) {
        const parent = path.dirname(fullPath);
        if (!byDir.has(parent)) byDir.set(parent, []);
        byDir.get(parent)!.push(path.relative(dir, fullPath));
      }
    }
  }

  await walk(dir);
  const results: string[] = [];
  for (const files of byDir.values()) {
    files.sort();
    results.push(files[0]);
  }
  results.sort();
  return results;
}

async function listSubtitleTracks(relativeVideoPath: string) {
  const dir = path.dirname(relativeVideoPath);
  const videoDir = path.resolve(VIDEO_ROOT, dir);
  const searchRoots = [videoDir];

  const tracks: Array<{ label: string; file: string; rel: string }> = [];
  const seen = new Set<string>();

  function labelFromFilename(filename: string) {
    const stripped = filename.replace(/\.(vtt|srt)$/i, "");
    const match = /^sub_\d+_([a-z0-9-]+)$/i.exec(stripped);
    if (match?.[1]) return match[1];
    return stripped;
  }

  async function walk(current: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(vtt|srt)$/i.test(entry.name)) continue;

      const rel = path.relative(VIDEO_ROOT, fullPath);
      if (!rel.startsWith(path.relative(VIDEO_ROOT, videoDir) + path.sep)) continue;

      if (seen.has(rel)) continue;
      seen.add(rel);
      tracks.push({ label: labelFromFilename(entry.name), file: entry.name, rel });
    }
  }

  for (const root of searchRoots) {
    await walk(root);
  }

  tracks.sort((a, b) => a.label.localeCompare(b.label));
  return {
    hash: hashPath(relativeVideoPath),
    tracks: tracks.map((t) => ({ label: t.label, file: t.rel })),
  };
}

async function getSubtitleTracks(relativeVideoPath: string) {
  const primary = await listSubtitleTracks(relativeVideoPath);
  if (primary.tracks.length > 0) return primary;

  const ext = path.extname(relativeVideoPath).toLowerCase();
  const base = relativeVideoPath.slice(0, -ext.length);
  const candidates = [".mkv", ".mov", ".webm", ".avi"].filter((e) => e !== ext);
  for (const cand of candidates) {
    const altRel = `${base}${cand}`;
    const altPath = path.resolve(VIDEO_ROOT, altRel);
    try {
      await fs.access(altPath);
    } catch {
      continue;
    }
    const alt = await listSubtitleTracks(altRel);
    if (alt.tracks.length > 0) return alt;
  }

  return { hash: hashPath(relativeVideoPath), tracks: [] as Array<{ label: string; file: string }> };
}

function requireAuth(request: Request) {
  const session = getSession(request);
  if (!session) return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) } as const;
  return { ok: true, session } as const;
}

function requireAdmin(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth;
  if (!auth.session.isAdmin) {
    return { ok: false, response: jsonResponse({ error: "Forbidden" }, 403) } as const;
  }
  return auth;
}

const socketsByRoom = new Map<string, Set<ServerWebSocket<unknown>>>();

function broadcastRoom(roomId: string, message: unknown) {
  const sockets = socketsByRoom.get(roomId);
  if (!sockets) return;
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    socket.send(payload);
  }
}

function ensureRoomSockets(roomId: string) {
  if (!socketsByRoom.has(roomId)) {
    socketsByRoom.set(roomId, new Set());
  }
  return socketsByRoom.get(roomId)!;
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  websocket: {
    open(ws) {
      const { roomId } = ws.data as { roomId: string };
      logInfo("ws:open", roomId);
      const sockets = ensureRoomSockets(roomId);
      sockets.add(ws);
      const state = getRoomState(roomId);
      ws.send(
        JSON.stringify({
          type: "state",
          data: {
            roomId,
            videoPath: state.video_path,
            position: state.position,
            paused: state.paused === 1,
            playbackRate: state.playback_rate,
            updatedAt: state.updated_at,
            serverTime: Date.now(),
          },
        })
      );
    },
    close(ws) {
      const { roomId } = ws.data as { roomId: string };
      logInfo("ws:close", roomId);
      const sockets = socketsByRoom.get(roomId);
      if (sockets) sockets.delete(ws);
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer);
      let payload: any = null;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      const { roomId } = ws.data as { roomId: string };
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "action") {
        logDebug("ws:action", payload);
        const action = payload.action as string;
        const position = Number(payload.position ?? 0);
        const playbackRate = Number(payload.playbackRate ?? 1);

        if (["play", "pause", "seek", "rate", "sync"].includes(action)) {
          const paused = action === "pause" ? 1 : action === "play" ? 0 : undefined;
          const next = updateRoomState(roomId, {
            position: Number.isFinite(position) ? position : undefined,
            paused,
            playback_rate: Number.isFinite(playbackRate) ? playbackRate : undefined,
          });
          broadcastRoom(roomId, {
            type: "state",
            data: {
              roomId,
              videoPath: next.video_path,
              position: next.position,
              paused: next.paused === 1,
              playbackRate: next.playback_rate,
              updatedAt: next.updated_at,
              serverTime: Date.now(),
            },
          });
        }
      }
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room") ?? "main";
      const auth = requireAuth(request);
      if (!auth.ok) return auth.response;
      const success = server.upgrade(request, {
        data: { roomId, userId: auth.session.userId },
      });
      if (!success) return new Response("WebSocket upgrade failed", { status: 400 });
      return new Response(null, { status: 101 });
    }

    if (url.pathname.startsWith("/media/")) {
      const relativePath = decodeURIComponent(url.pathname.replace("/media/", ""));
      const filePath = path.resolve(VIDEO_ROOT, relativePath);
      logDebug("media:request", relativePath, filePath);

      if (!filePath.startsWith(VIDEO_ROOT + path.sep)) {
        logWarn("media:invalid_path", filePath);
        return new Response("Invalid path", { status: 403 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        logWarn("media:not_found", filePath);
        return new Response("Not found", { status: 404 });
      }

      const range = request.headers.get("range");
      if (!range) {
        logDebug("media:full", filePath, file.size);
        return new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Accept-Ranges": "bytes",
          },
        });
      }

      const size = file.size;
      const match = /bytes=(\d+)-(\d+)?/.exec(range);
      if (!match) return new Response("Invalid range", { status: 416 });

      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
        logWarn("media:bad_range", range, filePath);
        return new Response("Invalid range", { status: 416 });
      }

      logDebug("media:range", filePath, start, end);
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    if (url.pathname.startsWith("/subs/")) {
      const relativePath = decodeURIComponent(url.pathname.replace("/subs/", ""));
      const filePath = path.resolve(VIDEO_ROOT, relativePath);
      logDebug("subs:request", relativePath, filePath);

      if (!filePath.startsWith(VIDEO_ROOT + path.sep)) {
        logWarn("subs:invalid_path", filePath);
        return new Response("Invalid path", { status: 403 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        logWarn("subs:not_found", filePath);
        return new Response("Not found", { status: 404 });
      }

      logDebug("subs:serve", filePath);
      return new Response(file, {
        headers: { "Content-Type": "text/vtt" },
      });
    }

    if (url.pathname === "/api/me") {
      const session = getSession(request);
      if (!session) return jsonResponse({ user: null });
      return jsonResponse({ user: session });
    }

    if (url.pathname === "/api/videos") {
      const auth = requireAuth(request);
      if (!auth.ok) return auth.response;
      const files = await listVideoFiles(VIDEO_DIR);
      logInfo("api:videos", files.length);
      return jsonResponse({ files });
    }

    if (url.pathname === "/api/subtitles") {
      const auth = requireAuth(request);
      if (!auth.ok) return auth.response;
      const videoPath = url.searchParams.get("video");
      if (!videoPath) return jsonResponse({ error: "Video required" }, 400);

      try {
        const { hash, tracks } = await getSubtitleTracks(videoPath);
        logInfo("api:subtitles", videoPath, tracks.length, tracks.map((t) => t.label));
        return jsonResponse({
          tracks: tracks.map((t) => ({
            label: t.label,
            url: `/subs/${encodeURIComponent(t.file)}`,
          })),
        });
      } catch (error: any) {
        logError("api:subtitles:error", videoPath, error?.message || error);
        return jsonResponse({ error: error?.message ?? "Subtitle extraction failed" }, 500);
      }
    }

    if (url.pathname === "/api/room/state") {
      const auth = requireAuth(request);
      if (!auth.ok) return auth.response;
      const roomId = url.searchParams.get("room") ?? "main";
      const state = getRoomState(roomId);
      logDebug("api:room:state", roomId, state.video_path, state.position, state.paused);
      return jsonResponse({
        roomId,
        videoPath: state.video_path,
        position: state.position,
        paused: state.paused === 1,
        playbackRate: state.playback_rate,
        updatedAt: state.updated_at,
        serverTime: Date.now(),
      });
    }

    if (url.pathname === "/api/room/set-video" && request.method === "POST") {
      const auth = requireAdmin(request);
      if (!auth.ok) return auth.response;
      const body = (await request.json()) as { roomId?: string; videoPath?: string | null };
      const roomId = body.roomId ?? "main";
      const videoPath = body.videoPath ?? null;
      logInfo("api:room:set-video", roomId, videoPath);
      const next = updateRoomState(roomId, {
        video_path: videoPath,
        position: 0,
        paused: 1,
      });
      broadcastRoom(roomId, {
        type: "state",
        data: {
          roomId,
          videoPath: next.video_path,
          position: next.position,
          paused: next.paused === 1,
          playbackRate: next.playback_rate,
          updatedAt: next.updated_at,
          serverTime: Date.now(),
        },
      });
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = (await request.json()) as { email?: string };
      const email = (body.email ?? "").trim().toLowerCase();
      if (!email) return jsonResponse({ error: "Email required" }, 400);

      const user = db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
      if (!user) return jsonResponse({ error: "Email not invited" }, 403);

      db.query("UPDATE users SET is_admin = 1 WHERE id = ?").run(user.id);

      const sessionToken = randomToken(32);
      const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
      db.query("INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(user.id, sessionToken, expiresAt, nowIso());

      const secure = NODE_ENV === "production";
      const cookie = setCookie("sp_session", sessionToken, {
        Path: "/",
        HttpOnly: true,
        SameSite: "Lax",
        Secure: secure,
        "Max-Age": SESSION_TTL_HOURS * 3600,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Set-Cookie": cookie, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const session = getSession(request);
      if (session) {
        db.query("DELETE FROM sessions WHERE user_id = ?").run(session.userId);
      }
      const cookie = setCookie("sp_session", "", { Path: "/", "Max-Age": 0 });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Set-Cookie": cookie, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/invites/create" && request.method === "POST") {
      const auth = requireAdmin(request);
      if (!auth.ok) return auth.response;
      const body = (await request.json()) as { email?: string };
      const email = body.email?.trim().toLowerCase() || null;
      if (!email) return jsonResponse({ error: "Email required" }, 400);

      const token = randomToken(24);
      db.query(
        `INSERT INTO invites (token, email, uses_remaining, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(token, email, 1, null, auth.session.email, nowIso());

      return jsonResponse({
        token,
        inviteUrl: `${APP_BASE_URL}/invite/${token}`,
      });
    }

    if (url.pathname === "/api/invites/accept" && request.method === "POST") {
      const body = (await request.json()) as { token?: string; email?: string };
      const token = (body.token ?? "").trim();
      const email = (body.email ?? "").trim().toLowerCase();
      if (!token || !email) return jsonResponse({ error: "Token and email required" }, 400);

      const invite = db
        .query("SELECT id, email, uses_remaining, expires_at FROM invites WHERE token = ?")
        .get(token) as
        | { id: number; email: string | null; uses_remaining: number; expires_at: string | null }
        | undefined;

      if (!invite) return jsonResponse({ error: "Invalid invite" }, 404);
      if (invite.email && invite.email !== email) return jsonResponse({ error: "Invite is for a different email" }, 403);
      if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: "Invite expired" }, 403);
      }
      if (invite.uses_remaining <= 0) return jsonResponse({ error: "Invite used up" }, 403);

      upsertUser(email, true);
      db.query("UPDATE invites SET uses_remaining = uses_remaining - 1 WHERE id = ?").run(invite.id);

      const user = db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
      if (!user) return jsonResponse({ error: "Email not invited" }, 403);

      const sessionToken = randomToken(32);
      const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
      db.query("INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(user.id, sessionToken, expiresAt, nowIso());

      const secure = NODE_ENV === "production";
      const cookie = setCookie("sp_session", sessionToken, {
        Path: "/",
        HttpOnly: true,
        SameSite: "Lax",
        Secure: secure,
        "Max-Age": SESSION_TTL_HOURS * 3600,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Set-Cookie": cookie, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/invites" && request.method === "GET") {
      const auth = requireAdmin(request);
      if (!auth.ok) return auth.response;
      const rows = db.query("SELECT token, email, uses_remaining, expires_at, created_by, created_at FROM invites ORDER BY created_at DESC").all();
      return jsonResponse({ invites: rows });
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    // Static assets
    const filePath = url.pathname === "/" || url.pathname.startsWith("/invite/")
      ? path.join(process.cwd(), "public", "index.html")
      : path.join(process.cwd(), "public", url.pathname);

    const staticFile = Bun.file(filePath);
    if (await staticFile.exists()) {
      return new Response(staticFile, {
        headers: {
          "Content-Type": staticFile.type || "text/plain",
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[${APP_NAME}] running at http://${HOST}:${PORT}`);
console.log(`[${APP_NAME}] video directory: ${VIDEO_DIR}`);
