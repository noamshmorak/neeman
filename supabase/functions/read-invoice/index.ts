// נאמן ספקים: קריאת חשבוניות והצעות מחיר בעזרת Claude דרך השרת, כך שגם עובד (בלי מפתח API במכשיר) יכול לקרוא.
// נדרש סוד בסופאבייס (Edge Functions → Secrets): ANTHROPIC_API_KEY. אופציונלי: ANTHROPIC_MODEL, DAILY_PAGES (ברירת מחדל 150 עמודים ליום לחנות).
// הפונקציה רק מעבירה את ההנחיה והתמונות ל-Claude ומחזירה את הטקסט. מי שמורשה: בעל החנות או עובד פעיל שלה.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    // the store: owner, or an active worker of it
    let storeId: string | null = null;
    const { data: owned } = await admin.from("stores").select("id").eq("owner", user.id).maybeSingle();
    if (owned) storeId = owned.id;
    else {
      const { data: m } = await admin.from("store_members").select("store_id,active").eq("user_id", user.id).maybeSingle();
      if (m?.active) storeId = m.store_id;
    }
    if (!storeId) return json({ error: "no store" }, 403);

    const b = await req.json().catch(() => null);
    const prompt = typeof b?.prompt === "string" ? b.prompt : "";
    const images: string[] = Array.isArray(b?.images) ? b.images : [];
    if (!prompt || prompt.length > 60000) return json({ error: "bad prompt" }, 400);
    if (images.length > 10) return json({ error: "too many pages" }, 400);
    let size = 0;
    for (const d of images) { if (typeof d !== "string") return json({ error: "bad page" }, 400); size += d.length; }
    if (size > 12_000_000) return json({ error: "too big" }, 413);

    // daily cap per store
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const cap = Number(Deno.env.get("DAILY_PAGES") || 150);
    const { data: use } = await admin.from("ai_usage").select("pages").eq("store_id", storeId).eq("day", day).maybeSingle();
    const used = use?.pages || 0;
    const web = b?.web === true;
    const cost = Math.max(1, images.length) + (web ? 2 : 0);
    if (used + cost > cap) return json({ error: "daily limit", used, cap }, 429);
    await admin.from("ai_usage").upsert({ store_id: storeId, day, pages: used + cost });

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
        max_tokens: 12000,
        ...(web ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
        messages: [{ role: "user", content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
          { type: "text", text: prompt },
        ] }],
      }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "ai", status: r.status, detail: out?.error?.message || "" }, 502);
    const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    return json({ text, pages_left: cap - used - cost });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
