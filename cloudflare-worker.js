// TeamPro Cloudflare Worker — 美化路由 + 靜態快取策略。
// 1) 把乾淨路由（/coach、/school…）改寫到對應的靜態 .html。
// 2) HTML 走 revalidate；指紋化/靜態資源快取一年。
// 部署：把站台路由掛到本 Worker（Workers Sites / 靜態 assets 皆可）。

const STATIC_RE = /\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|json|webmanifest)$/i;

// 乾淨路由 → 實際檔案。角色導向由 login.html 依角色 replace 到這些路徑。
const ROUTES = {
  "/": "/index.html",
  "/login": "/login.html",
  "/coach": "/app.html",
  "/app": "/app.html",          // 舊網址相容
  "/school": "/school.html",
  "/export": "/export.html",
  "/admin": "/admin.html",
  "/pricing": "/pricing.html",
  "/security": "/security.html",
  "/principal": "/principal.html",
  "/evaluation": "/evaluation.html",
  "/join": "/join.html",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 去掉結尾斜線（/coach/ → /coach），但保留根路徑
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    // 命中乾淨路由 → 改寫到實際檔案（維持原網址不變，內部取檔）
    const mapped = ROUTES[path];
    if (mapped) url.pathname = mapped;

    const originReq = mapped ? new Request(url.toString(), request) : request;
    const response = await fetch(originReq);
    const headers = new Headers(response.headers);

    if (request.method === "GET") {
      if (STATIC_RE.test(url.pathname)) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (url.pathname.endsWith(".html") || request.headers.get("accept")?.includes("text/html")) {
        headers.set("Cache-Control", "no-cache");
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
