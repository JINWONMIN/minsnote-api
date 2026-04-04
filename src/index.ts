export interface Env {
  VIEWS: KVNamespace;
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  API_KEY: string;
}

const RATE_LIMIT_SECONDS = 60;

const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3333"];

function isAllowedOrigin(origin: string, allowed: string): boolean {
  if (origin === allowed) return true;
  return DEV_ORIGINS.includes(origin);
}

function corsHeaders(origin: string, allowed: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin, allowed) ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };
}

function jsonResponse(data: unknown, status: number, origin: string, allowed: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, allowed) },
  });
}

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + "minsnote-salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function todayKey(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── Views ──

async function getViews(slug: string, env: Env): Promise<number> {
  const val = await env.VIEWS.get(`views:${slug}`);
  return val ? parseInt(val, 10) : 0;
}

async function incrementViews(slug: string, ipHash: string, env: Env): Promise<number> {
  const dedupeKey = `viewed:${slug}:${ipHash}:${todayKey()}`;
  const already = await env.VIEWS.get(dedupeKey);
  if (already) {
    return getViews(slug, env);
  }

  const current = await getViews(slug, env);
  const next = current + 1;
  await env.VIEWS.put(`views:${slug}`, next.toString());
  await env.VIEWS.put(dedupeKey, "1", { expirationTtl: 86400 });
  return next;
}

// ── Likes ──

async function getLikes(slug: string, env: Env): Promise<number> {
  const val = await env.VIEWS.get(`likes:${slug}`);
  return val ? parseInt(val, 10) : 0;
}

async function toggleLike(slug: string, ipHash: string, env: Env): Promise<{ likes: number; liked: boolean }> {
  const likedKey = `liked:${slug}:${ipHash}`;
  const already = await env.VIEWS.get(likedKey);
  const current = await getLikes(slug, env);

  if (already) {
    const next = Math.max(0, current - 1);
    await env.VIEWS.put(`likes:${slug}`, next.toString());
    await env.VIEWS.delete(likedKey);
    return { likes: next, liked: false };
  }

  const next = current + 1;
  await env.VIEWS.put(`likes:${slug}`, next.toString());
  await env.VIEWS.put(likedKey, "1");
  return { likes: next, liked: true };
}

async function checkLiked(slug: string, ipHash: string, env: Env): Promise<boolean> {
  const val = await env.VIEWS.get(`liked:${slug}:${ipHash}`);
  return val !== null;
}

// ── Visitors ──

async function trackVisitor(ipHash: string, env: Env): Promise<{ today: number; total: number }> {
  const today = todayKey();
  const totalKey = "visitors:total";
  const todaySetKey = `visitors:set:${today}`;
  const dedupeKey = `visitor:${ipHash}:${today}`;

  const already = await env.VIEWS.get(dedupeKey);
  const totalVal = await env.VIEWS.get(totalKey);
  let total = totalVal ? parseInt(totalVal, 10) : 0;

  const todaySetVal = await env.VIEWS.get(todaySetKey);
  let todayCount = todaySetVal ? parseInt(todaySetVal, 10) : 0;

  if (!already) {
    total += 1;
    todayCount += 1;
    await env.VIEWS.put(totalKey, total.toString());
    await env.VIEWS.put(todaySetKey, todayCount.toString(), { expirationTtl: 86400 });
    await env.VIEWS.put(dedupeKey, "1", { expirationTtl: 86400 });
  }

  return { today: todayCount, total };
}

async function getVisitors(env: Env): Promise<{ today: number; total: number }> {
  const today = todayKey();
  const totalVal = await env.VIEWS.get("visitors:total");
  const todayVal = await env.VIEWS.get(`visitors:set:${today}`);
  return {
    today: todayVal ? parseInt(todayVal, 10) : 0,
    total: totalVal ? parseInt(totalVal, 10) : 0,
  };
}

// ── Comments ──

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password + "minsnote-pw-salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getComments(slug: string, env: Env): Promise<unknown[]> {
  const result = await env.DB.prepare(
    "SELECT id, nickname, content, created_at, parent_id FROM comments WHERE post_slug = ? ORDER BY created_at ASC"
  )
    .bind(slug)
    .all();
  return result.results;
}

async function createComment(
  slug: string,
  nickname: string,
  content: string,
  password: string,
  parentId: number | null,
  ipHash: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const rateLimitKey = `ratelimit:comment:${ipHash}`;
  const limited = await env.VIEWS.get(rateLimitKey);
  if (limited) {
    return { success: false, error: "잠시 후 다시 시도해주세요." };
  }

  if (!nickname.trim() || nickname.length > 30) {
    return { success: false, error: "닉네임은 1~30자여야 합니다." };
  }
  if (!content.trim() || content.length > 2000) {
    return { success: false, error: "댓글은 1~2000자여야 합니다." };
  }
  if (!/^\d{4}$/.test(password)) {
    return { success: false, error: "비밀번호는 숫자 4자리여야 합니다." };
  }

  if (parentId !== null) {
    const parent = await env.DB.prepare("SELECT id, parent_id FROM comments WHERE id = ?").bind(parentId).first();
    if (!parent) return { success: false, error: "원본 댓글을 찾을 수 없습니다." };
    if (parent.parent_id !== null) return { success: false, error: "대댓글에는 답글을 달 수 없습니다." };
  }

  const pwHash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO comments (post_slug, nickname, content, ip_hash, password_hash, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(slug, nickname.trim(), content.trim(), ipHash, pwHash, parentId)
    .run();

  await env.VIEWS.put(rateLimitKey, "1", { expirationTtl: RATE_LIMIT_SECONDS });
  return { success: true };
}

async function deleteComment(
  id: number,
  password: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const row = await env.DB.prepare("SELECT password_hash FROM comments WHERE id = ?").bind(id).first();
  if (!row) return { success: false, error: "댓글을 찾을 수 없습니다." };

  const pwHash = await hashPassword(password);
  if (row.password_hash !== pwHash) {
    return { success: false, error: "비밀번호가 일치하지 않습니다." };
  }

  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  return { success: true };
}

async function updateComment(
  id: number,
  content: string,
  password: string,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const row = await env.DB.prepare("SELECT password_hash FROM comments WHERE id = ?").bind(id).first();
  if (!row) return { success: false, error: "댓글을 찾을 수 없습니다." };

  const pwHash = await hashPassword(password);
  if (row.password_hash !== pwHash) {
    return { success: false, error: "비밀번호가 일치하지 않습니다." };
  }

  if (!content.trim() || content.length > 2000) {
    return { success: false, error: "댓글은 1~2000자여야 합니다." };
  }

  await env.DB.prepare("UPDATE comments SET content = ? WHERE id = ?")
    .bind(content.trim(), id)
    .run();
  return { success: true };
}

// ── Router ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }

    const apiKey = request.headers.get("X-API-Key") || "";
    if (!env.API_KEY || apiKey !== env.API_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401, origin, allowed);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipHash = await hashIP(ip);

    try {
      // POST /api/post-stats (views + likes in one call)
      if (url.pathname === "/api/post-stats" && request.method === "POST") {
        const body = (await request.json()) as { slug?: string };
        if (!body.slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const [views, likes, liked] = await Promise.all([
          incrementViews(body.slug, ipHash, env),
          getLikes(body.slug, env),
          checkLiked(body.slug, ipHash, env),
        ]);
        return jsonResponse({ views, likes, liked }, 200, origin, allowed);
      }

      // POST /api/views
      if (url.pathname === "/api/views" && request.method === "POST") {
        const body = (await request.json()) as { slug?: string };
        if (!body.slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const views = await incrementViews(body.slug, ipHash, env);
        return jsonResponse({ views }, 200, origin, allowed);
      }

      // GET /api/views?slug=xxx
      if (url.pathname === "/api/views" && request.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const views = await getViews(slug, env);
        return jsonResponse({ views }, 200, origin, allowed);
      }

      // GET /api/likes?slug=xxx
      if (url.pathname === "/api/likes" && request.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const likes = await getLikes(slug, env);
        const liked = await checkLiked(slug, ipHash, env);
        return jsonResponse({ likes, liked }, 200, origin, allowed);
      }

      // POST /api/likes (toggle)
      if (url.pathname === "/api/likes" && request.method === "POST") {
        const body = (await request.json()) as { slug?: string };
        if (!body.slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const result = await toggleLike(body.slug, ipHash, env);
        return jsonResponse(result, 200, origin, allowed);
      }

      // POST /api/visitors
      if (url.pathname === "/api/visitors" && request.method === "POST") {
        const data = await trackVisitor(ipHash, env);
        return jsonResponse(data, 200, origin, allowed);
      }

      // GET /api/visitors
      if (url.pathname === "/api/visitors" && request.method === "GET") {
        const data = await getVisitors(env);
        return jsonResponse(data, 200, origin, allowed);
      }

      // GET /api/comments?slug=xxx
      if (url.pathname === "/api/comments" && request.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return jsonResponse({ error: "slug required" }, 400, origin, allowed);
        const comments = await getComments(slug, env);
        return jsonResponse({ comments }, 200, origin, allowed);
      }

      // POST /api/comments
      if (url.pathname === "/api/comments" && request.method === "POST") {
        const body = (await request.json()) as { slug?: string; nickname?: string; content?: string; password?: string; parent_id?: number | null };
        if (!body.slug || !body.nickname || !body.content || !body.password) {
          return jsonResponse({ error: "slug, nickname, content, password required" }, 400, origin, allowed);
        }
        const result = await createComment(body.slug, body.nickname, body.content, body.password, body.parent_id ?? null, ipHash, env);
        if (!result.success) {
          return jsonResponse({ error: result.error }, 429, origin, allowed);
        }
        return jsonResponse({ success: true }, 201, origin, allowed);
      }

      // PUT /api/comments (edit)
      if (url.pathname === "/api/comments" && request.method === "PUT") {
        const body = (await request.json()) as { id?: number; content?: string; password?: string };
        if (!body.id || !body.content || !body.password) {
          return jsonResponse({ error: "id, content, password required" }, 400, origin, allowed);
        }
        const result = await updateComment(body.id, body.content, body.password, env);
        if (!result.success) {
          return jsonResponse({ error: result.error }, result.error === "비밀번호가 일치하지 않습니다." ? 403 : 400, origin, allowed);
        }
        return jsonResponse({ success: true }, 200, origin, allowed);
      }

      // DELETE /api/comments
      if (url.pathname === "/api/comments" && request.method === "DELETE") {
        const body = (await request.json()) as { id?: number; password?: string };
        if (!body.id || !body.password) {
          return jsonResponse({ error: "id, password required" }, 400, origin, allowed);
        }
        const result = await deleteComment(body.id, body.password, env);
        if (!result.success) {
          return jsonResponse({ error: result.error }, result.error === "비밀번호가 일치하지 않습니다." ? 403 : 400, origin, allowed);
        }
        return jsonResponse({ success: true }, 200, origin, allowed);
      }

      return jsonResponse({ error: "Not found" }, 404, origin, allowed);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return jsonResponse({ error: message }, 500, origin, allowed);
    }
  },
};
