import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://shark7763-del.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://shark7763-del.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { ok: false, error: "method_not_allowed" }, 405);
  }

  const startedAt = performance.now();
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, error: "invalid_json" }, 400);
  }

  const action = String(body.action || "ping");
  if (action === "ping") {
    return json(request, {
      ok: true,
      message: "pong",
      runtime: "supabase-edge",
      elapsedMs: Math.round(performance.now() - startedAt),
      time: new Date().toISOString(),
    });
  }

  if (action === "health") {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json(request, { ok: false, error: "server_not_configured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.from("coaches").select("coach_id").limit(1);
    if (error) {
      return json(request, { ok: false, error: "database_unavailable" }, 503);
    }
    return json(request, {
      ok: true,
      database: "ready",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }

  return json(request, { ok: false, error: "action_not_implemented" }, 404);
});
