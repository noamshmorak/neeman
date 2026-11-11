// נאמן: מסך ניהול לבעל המערכת (רשימת חנויות ומשתמשים, איפוס סיסמה, השבתה והפעלה).
// רץ עם הרשאות שרת ולכן בודק קודם שהמבקש רשום ב-platform_admins. אף פעולה כאן לא מוחקת נתונים ולא מציגה סיסמאות.
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
    const { data: isAdmin } = await admin.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!isAdmin) return json({ error: "admin only" }, 403);

    const b = await req.json().catch(() => ({}));
    const log = (action: string, target: string) => admin.from("admin_log").insert({ admin_id: user.id, action, target });
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const info = async (uid: string) => {
      const { data } = await admin.auth.admin.getUserById(uid);
      const u = data?.user;
      return { email: u?.email || "", last_sign_in: u?.last_sign_in_at || null, banned: !!(u as { banned_until?: string } | undefined)?.banned_until && new Date((u as { banned_until: string }).banned_until) > new Date() };
    };

    if (b.action === "overview") {
      const { data: stores, error } = await admin.from("stores").select("id,slug,name,owner,plan,created_at").order("created_at");
      if (error) throw error;
      const out = [];
      for (const s of stores || []) {
        const [docs, workers, usage, owner] = await Promise.all([
          admin.from("sup_docs").select("path", { count: "exact", head: true }).eq("store_id", s.id).eq("deleted", false),
          admin.from("store_members").select("user_id", { count: "exact", head: true }).eq("store_id", s.id),
          admin.from("ai_usage").select("pages").eq("store_id", s.id).eq("day", day).maybeSingle(),
          info(s.owner),
        ]);
        out.push({ ...s, docs: docs.count || 0, workers: workers.count || 0, ai_today: usage.data?.pages || 0, owner_info: owner });
      }
      return json({ stores: out, day });
    }

    if (b.action === "workers") {
      const { data, error } = await admin.from("store_members").select("user_id,username,name,active,created_at").eq("store_id", String(b.store_id)).order("created_at");
      if (error) throw error;
      const list = [];
      for (const w of data || []) list.push({ ...w, ...(await info(w.user_id)) });
      return json({ workers: list });
    }

    if (b.action === "setpass") {
      const uid = String(b.user_id || ""), pw = String(b.password || "");
      if (!uid) return json({ error: "חסר משתמש" }, 400);
      if (pw.length < 8) return json({ error: "הסיסמה חייבת להיות לפחות 8 תווים" }, 400);
      const { error } = await admin.auth.admin.updateUserById(uid, { password: pw });
      if (error) return json({ error: error.message }, 400);
      await log("setpass", uid);
      return json({ ok: true });
    }

    if (b.action === "setactive") {
      const uid = String(b.user_id || ""), on = b.active === true;
      if (!uid) return json({ error: "חסר משתמש" }, 400);
      if (!on) {
        const { data: adm } = await admin.from("platform_admins").select("user_id").eq("user_id", uid).maybeSingle();
        if (adm) return json({ error: "אי אפשר להשבית מנהל מערכת" }, 400);
      }
      const { error } = await admin.auth.admin.updateUserById(uid, { ban_duration: on ? "none" : "876000h" });
      if (error) return json({ error: error.message }, 400);
      await admin.from("store_members").update({ active: on }).eq("user_id", uid);
      await log(on ? "activate" : "deactivate", uid);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: "server", detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
