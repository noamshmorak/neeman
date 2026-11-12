// נאמן תזכורות: שליחת הודעות וואטסאפ דרך ה-API של כל חנות ושמירת פרטי ה-API בשרת בלבד.
// הטוקן לא חוזר לדפדפן אף פעם. שליחה חסומה למנוי מושהה, ללקוח שהסיר את עצמו ולמי שכבר קיבל היום.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MAX_BATCH = 200;
const GRAPH = "https://graph.facebook.com/v21.0";
const intl = (p: string) => { const n = p.replace(/\D/g, ""); return n.startsWith("0") ? "972" + n.slice(1) : n; };
// Meta לא מקבלת שורות חדשות וריווחים ארוכים בתוך פרמטר של תבנית
const clean = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 300) || "-";

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

    // מי המבקש: בעל חנות, או עובד פעיל עם הרשאת תזכורות
    let role = "", store: Record<string, any> | null = null;
    const { data: own } = await admin.from("stores").select("*").eq("owner", user.id).maybeSingle();
    if (own) { role = "owner"; store = own; }
    else {
      const { data: m } = await admin.from("store_members").select("store_id,active,can_reminders").eq("user_id", user.id).maybeSingle();
      if (m?.active && m.can_reminders) {
        const { data: s } = await admin.from("stores").select("*").eq("id", m.store_id).maybeSingle();
        if (s) { role = "worker"; store = s; }
      }
    }
    if (!store) return json({ error: "אין הרשאה" }, 403);

    const b = await req.json().catch(() => ({}));

    // ---- הגדרות: בעל החנות בלבד ----
    if (b.action === "save") {
      if (role !== "owner") return json({ error: "רק בעל החנות" }, 403);
      const pid = String(b.phone_number_id || "").trim(), tok = String(b.access_token || "").trim();
      const tpl = String(b.template_name || "").trim(), lang = String(b.template_lang || "he").trim();
      if (!/^\d{8,20}$/.test(pid)) return json({ error: "מזהה מספר הטלפון (Phone number ID) צריך להיות ספרות בלבד" }, 400);
      if (!/^[a-z0-9_]{1,512}$/.test(tpl)) return json({ error: "שם התבנית: אותיות קטנות באנגלית, ספרות וקו תחתון" }, 400);
      if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) return json({ error: "קוד שפה לא תקין, למשל he" }, 400);
      const { data: ex } = await admin.from("store_wa_secrets").select("access_token").eq("store_id", store.id).maybeSingle();
      const token = tok || ex?.access_token || "";   // טוקן ריק = להשאיר את הקיים
      if (token.length < 20) return json({ error: "חסר טוקן גישה" }, 400);
      const { error } = await admin.from("store_wa_secrets").upsert({ store_id: store.id, phone_number_id: pid, access_token: token, template_name: tpl, template_lang: lang, updated_at: new Date().toISOString() });
      if (error) throw error;
      await admin.from("stores").update({ wa_connected: true }).eq("id", store.id);
      return json({ ok: true });
    }
    if (b.action === "clear") {
      if (role !== "owner") return json({ error: "רק בעל החנות" }, 403);
      await admin.from("store_wa_secrets").delete().eq("store_id", store.id);
      await admin.from("stores").update({ wa_connected: false, wa_mode: "off" }).eq("id", store.id);
      return json({ ok: true });
    }
    if (b.action === "setmode") {
      if (role !== "owner") return json({ error: "רק בעל החנות" }, 403);
      const mode = String(b.mode || "");
      if (!["off", "dry", "test", "live"].includes(mode)) return json({ error: "מצב לא תקין" }, 400);
      const tp = String(b.test_phone || "").replace(/\D/g, "");
      if (mode === "test" && !/^05\d{8}$/.test(tp || String(store.wa_test_phone || ""))) return json({ error: "במצב בדיקה צריך מספר טלפון לבדיקה (05XXXXXXXX)" }, 400);
      if ((mode === "test" || mode === "live") && !store.wa_connected) return json({ error: "קודם צריך לשמור את פרטי ה-API" }, 400);
      if (mode === "live" && store.plan === "paused") return json({ error: "המנוי מושהה" }, 403);
      const patch: Record<string, unknown> = { wa_mode: mode };
      if (/^05\d{8}$/.test(tp)) patch.wa_test_phone = tp;
      await admin.from("stores").update(patch).eq("id", store.id);
      return json({ ok: true });
    }

    // ---- שליחה: בעל חנות או עובד עם הרשאה ----
    if (b.action === "send") {
      if (store.plan === "paused") return json({ error: "המנוי מושהה, אי אפשר לשלוח. פנה אל נאמן." }, 403);
      const mode = String(store.wa_mode || "off");
      if (mode === "off") return json({ error: "שליחה אוטומטית כבויה. אפשר להפעיל בהגדרות." }, 400);
      const items = Array.isArray(b.items) ? b.items.slice(0, MAX_BATCH + 1) : [];
      if (!items.length) return json({ error: "אין למי לשלוח" }, 400);
      if (items.length > MAX_BATCH) return json({ error: "אפשר לשלוח עד " + MAX_BATCH + " בכל פעם" }, 400);

      let sec: Record<string, any> | null = null;
      if (mode === "test" || mode === "live") {
        const { data } = await admin.from("store_wa_secrets").select("*").eq("store_id", store.id).maybeSingle();
        if (!data) return json({ error: "פרטי ה-API לא הוגדרו" }, 400);
        sec = data;
      }
      const ids = items.map((i: any) => String(i.id));
      const { data: custs } = await admin.from("customers").select("id,name,phone,opted_out").eq("store_id", store.id).in("id", ids);
      const byId = new Map((custs || []).map((c: any) => [c.id, c]));
      const dayStart = new Date(); dayStart.setHours(dayStart.getHours() - 20);
      const { data: sentToday } = await admin.from("wa_log").select("customer_id").eq("store_id", store.id).eq("status", mode === "live" ? "sent" : "__none__").in("customer_id", ids).gte("at", dayStart.toISOString());
      const already = new Set((sentToday || []).map((x: any) => x.customer_id));

      const out = { sent: 0, dry: 0, test: 0, failed: 0, skipped: 0, details: [] as string[] };
      const logRow = (c: any, status: string, detail: string, wa_id?: string) =>
        admin.from("wa_log").insert({ store_id: store!.id, customer_id: c?.id ?? null, name: c?.name ?? null, phone: c?.phone ?? null, status, detail, wa_id: wa_id ?? null, by_user: user.id });

      for (const it of items) {
        const c: any = byId.get(String(it.id));
        if (!c) { out.skipped++; continue; }
        if (c.opted_out) { out.skipped++; await logRow(c, "skipped", "הלקוח ביקש להסיר את עצמו"); continue; }
        if (!/^05\d{8}$/.test(c.phone)) { out.skipped++; await logRow(c, "skipped", "מספר טלפון לא תקין"); continue; }
        if (mode === "live" && already.has(c.id)) { out.skipped++; await logRow(c, "skipped", "כבר נשלחה הודעה היום"); continue; }
        const params: unknown[] = Array.isArray(it.params) ? it.params.slice(0, 10) : [];
        if (mode === "dry") { out.dry++; await logRow(c, "dry", "ניסוי: לא נשלחה הודעה"); continue; }
        const toPhone = mode === "test" ? String(store.wa_test_phone) : c.phone;
        try {
          const r = await fetch(`${GRAPH}/${sec!.phone_number_id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${sec!.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              messaging_product: "whatsapp", to: intl(toPhone), type: "template",
              template: { name: sec!.template_name, language: { code: sec!.template_lang },
                components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: clean(p) })) }] },
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            out.failed++;
            const msg = String(j?.error?.message || r.status).slice(0, 200);
            out.details.push(c.name + ": " + msg);
            await logRow(c, "failed", msg);
            continue;
          }
          const wid = j?.messages?.[0]?.id || "";
          if (mode === "test") { out.test++; await logRow(c, "test", "נשלח למספר הבדיקה " + toPhone, wid); }
          else {
            out.sent++; await logRow(c, "sent", "נשלח", wid);
            await admin.from("reminders").insert({ store_id: store.id, customer_id: c.id });   // כך המסך "היום" יודע שנשלחה תזכורת
          }
        } catch (e) {
          out.failed++; await logRow(c, "failed", "שגיאת רשת"); out.details.push(c.name + ": שגיאת רשת");
        }
      }
      return json({ ok: true, mode, ...out });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
