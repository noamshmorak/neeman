// נאמן ספקים: ניהול עובדים לבעל החנות (יצירה, רשימה, איפוס סיסמה, השבתה, מחיקה).
// רץ עם הרשאות שרת, ולכן בודק קודם שהמבקש הוא בעל החנות. SUPABASE_URL, SUPABASE_ANON_KEY ו-SUPABASE_SERVICE_ROLE_KEY ניתנים אוטומטית.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MAX_WORKERS = 20;
const DOMAIN = "workers.neeman-app.com";
const workerEmail = (slug: string, username: string) => `${slug}.${username}@${DOMAIN}`;

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
    // only the store owner may manage workers (a worker is never an owner)
    const { data: store } = await admin.from("stores").select("id,slug").eq("owner", user.id).maybeSingle();
    if (!store) return json({ error: "owner only" }, 403);

    const b = await req.json().catch(() => ({}));
    const own = async (uid: string) => {
      const { data } = await admin.from("store_members").select("user_id").eq("store_id", store.id).eq("user_id", uid).maybeSingle();
      return !!data;
    };

    if (b.action === "list") {
      const { data, error } = await admin.from("store_members").select("user_id,username,name,active,created_at").eq("store_id", store.id).order("created_at");
      if (error) throw error;
      return json({ slug: store.slug, workers: data });
    }
    if (b.action === "create") {
      const username = String(b.username || "").trim().toLowerCase();
      const name = String(b.name || "").trim();
      const password = String(b.password || "");
      if (!/^[a-z0-9]{2,20}$/.test(username)) return json({ error: "שם משתמש: 2 עד 20 אותיות באנגלית או ספרות" }, 400);
      if (name.length < 1 || name.length > 60) return json({ error: "חסר שם לעובד" }, 400);
      if (password.length < 6 || password.length > 72) return json({ error: "הסיסמה צריכה להיות באורך 6 תווים לפחות" }, 400);
      const { count } = await admin.from("store_members").select("user_id", { count: "exact", head: true }).eq("store_id", store.id);
      if ((count || 0) >= MAX_WORKERS) return json({ error: "הגעת למספר העובדים המרבי" }, 400);
      const { data: dup } = await admin.from("store_members").select("user_id").eq("store_id", store.id).eq("username", username).maybeSingle();
      if (dup) return json({ error: "שם המשתמש כבר קיים" }, 400);
      const { data: created, error: e1 } = await admin.auth.admin.createUser({
        email: workerEmail(store.slug, username), password, email_confirm: true, user_metadata: { worker: true, name },
      });
      if (e1 || !created?.user) return json({ error: "יצירת המשתמש נכשלה: " + (e1?.message || "") }, 400);
      const { error: e2 } = await admin.from("store_members").insert({ user_id: created.user.id, store_id: store.id, username, name });
      if (e2) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: "השמירה נכשלה" }, 500); }
      return json({ ok: true });
    }
    if (b.action === "setpass") {
      const password = String(b.password || "");
      if (password.length < 6 || password.length > 72) return json({ error: "הסיסמה צריכה להיות באורך 6 תווים לפחות" }, 400);
      if (!(await own(String(b.user_id)))) return json({ error: "not found" }, 404);
      const { error } = await admin.auth.admin.updateUserById(String(b.user_id), { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (b.action === "setactive") {
      if (!(await own(String(b.user_id)))) return json({ error: "not found" }, 404);
      const { error } = await admin.from("store_members").update({ active: !!b.active }).eq("user_id", String(b.user_id));
      if (error) throw error;
      return json({ ok: true });
    }
    if (b.action === "remove") {
      if (!(await own(String(b.user_id)))) return json({ error: "not found" }, 404);
      const { error } = await admin.auth.admin.deleteUser(String(b.user_id));
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
