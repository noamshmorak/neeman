// נאמן: קריאת תעודת משלוח / חשבונית מתמונה בעזרת Claude.
// Secrets needed (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL, DAILY_PAGES (default 60).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `You read Israeli supplier documents for a pet store: delivery notes (תעודת משלוח), invoices (חשבונית), and order forms (הזמנה).
They are usually printed in Hebrew, and the photos may be skewed or partly blurry.
Return ONLY a JSON object, no other text, in this shape:
{"supplier": string|null, "doc_no": string|null, "doc_date": "YYYY-MM-DD"|null,
 "items": [{"name": string, "code": string|null, "qty": number, "unit_price": number|null}],
 "unreadable": boolean}
Rules:
- One entry per product line. Copy the product name exactly as printed, in Hebrew if it is printed in Hebrew.
- "code" is the barcode or catalog number (ברקוד / מק"ט) if printed on the line, digits only, else null.
- "qty" is the quantity ordered or delivered (units, bags or cartons, as printed). If unclear, give your best reading.
- "unit_price" is the price per unit before VAT if shown, else null.
- Skip totals, VAT (מע"מ), discount lines, deposits and signatures.
- "supplier" is the company that issued the document, not the store.
- If the image is not a supplier document or you cannot read it, return {"unreadable": true, "items": []}.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    // 1. who is asking: only a signed-in store owner
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: store } = await userClient.from("stores").select("id").eq("owner", user.id).maybeSingle();
    if (!store) return json({ error: "no store" }, 403);

    // 2. the pages (JPEG/PNG, already made small by the app)
    const body = await req.json().catch(() => null);
    const pages: { data: string; type: string }[] = Array.isArray(body?.pages) ? body.pages : [];
    if (!pages.length || pages.length > 4) return json({ error: "1-4 pages" }, 400);
    let size = 0;
    for (const p of pages) {
      if (!/^image\/(jpeg|png|webp)$/.test(p?.type) || typeof p?.data !== "string") return json({ error: "bad page" }, 400);
      size += p.data.length;
    }
    if (size > 8_000_000) return json({ error: "too big" }, 413);

    // 3. daily cap per store
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const cap = Number(Deno.env.get("DAILY_PAGES") || 60);
    const { data: use } = await admin.from("ai_usage").select("pages").eq("store_id", store.id).eq("day", day).maybeSingle();
    const used = use?.pages || 0;
    if (used + pages.length > cap) return json({ error: "daily limit", used, cap }, 429);
    await admin.from("ai_usage").upsert({ store_id: store.id, day, pages: used + pages.length });

    // 4. ask Claude
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            ...pages.map((p) => ({ type: "image", source: { type: "base64", media_type: p.type, data: p.data } })),
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "ai", detail: out?.error?.message || r.status }, 502);
    const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "ai answer", detail: text.slice(0, 200) }, 502);
    const doc = JSON.parse(m[0]);
    // 5. clean what came back
    const items = (Array.isArray(doc.items) ? doc.items : []).slice(0, 300).map((x: Record<string, unknown>) => ({
      name: String(x.name ?? "").trim().slice(0, 200),
      code: x.code ? String(x.code).replace(/\D/g, "").slice(0, 32) || null : null,
      qty: Math.max(0, Number(x.qty) || 0),
      unit_price: x.unit_price == null || isNaN(Number(x.unit_price)) ? null : Number(x.unit_price),
    })).filter((x: { name: string }) => x.name);
    return json({
      supplier: doc.supplier ? String(doc.supplier).slice(0, 80) : null,
      doc_no: doc.doc_no ? String(doc.doc_no).slice(0, 40) : null,
      doc_date: /^\d{4}-\d{2}-\d{2}$/.test(doc.doc_date || "") ? doc.doc_date : null,
      items, unreadable: !!doc.unreadable || !items.length, pages_left: cap - used - pages.length,
    });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
