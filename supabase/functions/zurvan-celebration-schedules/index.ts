import { createClient } from "npm:@supabase/supabase-js@2";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const THEMES = new Set([
  "windows-light", "liquid-glass", "azure-glass", "graphite-night",
  "warm-sand", "zara-pastel", "season-vibe", "elena-mode"
]);
const TYPES = new Set(["birthday", "meeting_anniversary", "wedding_anniversary"]);

Deno.serve(async (req) => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) return json(405, { error: "method_not_allowed" });
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(503, { error: "not_configured" });
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return json(401, { error: "unauthorized" });

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: auth, error: authError } = await db.auth.getUser(token);
  const user = auth?.user;
  if (authError || !user || !user.email_confirmed_at) return json(401, { error: "unauthorized" });

  const { data: profile, error: profileError } = await db.from("zurvan_accounts")
    .select("id,status,super_type").eq("id", user.id).maybeSingle();
  if (profileError) return json(503, { error: "database_unavailable" });
  if (!profile || profile.status !== "active") return json(403, { error: "account_inactive" });
  const isCreator = String(profile.super_type ?? "").toLowerCase() === "creator";

  if (req.method === "GET") {
    const target = new URL(req.url).searchParams.get("account_id");
    if (target && target !== user.id && !isCreator) return json(403, { error: "forbidden" });
    let query = db.from("zurvan_celebration_schedules").select(
      "id,account_id,occasion_type,persian_month,persian_day,theme_id,enabled,display_title"
    );
    if (target) query = query.eq("account_id", target);
    else if (!isCreator) query = query.eq("account_id", user.id);
    const { data, error } = await query.order("occasion_type");
    if (error) return json(503, { error: "database_unavailable" });
    // A verified Creator may select a recipient from the account directory.
    // Ordinary users receive neither the directory nor other users' schedules.
    if (!isCreator) return json(200, { is_creator: false, account_id: user.id, schedules: data ?? [] });
    const { data: accounts, error: directoryError } = await db.from("zurvan_accounts")
      .select("id,username,status").eq("status", "active").order("username").limit(200);
    if (directoryError) return json(503, { error: "database_unavailable" });
    return json(200, { is_creator: true, account_id: user.id, accounts: accounts ?? [], schedules: data ?? [] });
  }

  if (!isCreator) return json(403, { error: "creator_only" });

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json(400, { error: "id_required" });
    const { error } = await db.from("zurvan_celebration_schedules").delete().eq("id", id);
    if (error) return json(503, { error: "database_unavailable" });
    return json(200, { deleted: true });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  const accountId = String(body.account_id ?? "");
  const type = String(body.occasion_type ?? "");
  const month = Number(body.persian_month), day = Number(body.persian_day);
  const theme = String(body.theme_id ?? "");
  if (!accountId || !TYPES.has(type) || !THEMES.has(theme) ||
      !Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 ||
      day > (month <= 6 ? 31 : month === 12 ? 30 : 30)) {
    return json(400, { error: "invalid_schedule" });
  }
  const { data: target, error: targetError } = await db.from("zurvan_accounts")
    .select("id").eq("id", accountId).maybeSingle();
  if (targetError || !target) return json(404, { error: "target_account_not_found" });

  const row = {
    account_id: accountId, occasion_type: type, persian_month: month, persian_day: day,
    theme_id: theme, enabled: body.enabled !== false,
    display_title: body.display_title == null ? null : String(body.display_title).slice(0, 80),
    created_by: user.id
  };
  const { data, error } = await db.from("zurvan_celebration_schedules")
    .upsert(row, { onConflict: "account_id,occasion_type" })
    .select("id,account_id,occasion_type,persian_month,persian_day,theme_id,enabled,display_title")
    .single();
  if (error) return json(503, { error: "database_unavailable" });
  return json(200, { schedule: data });
});
