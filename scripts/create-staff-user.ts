/**
 * Create or update a staff user in Supabase Auth.
 *
 * Reads credentials ONLY from environment variables — never from command-line
 * arguments or files — so they are never recorded in shell history or the repo.
 *
 * Required environment variables:
 *   SUPABASE_URL          — your project's REST URL (e.g. https://xyz.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — the service-role key (privileged; keep secret)
 *   STAFF_EMAIL           — the email address for the staff account
 *   STAFF_PASSWORD        — the password for the staff account (min 8 chars)
 *
 * Usage (POSIX):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STAFF_EMAIL=... STAFF_PASSWORD=... \
 *     deno run --allow-net --allow-env scripts/create-staff-user.ts
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL='...'
 *   $env:SUPABASE_SERVICE_ROLE_KEY='...'
 *   $env:STAFF_EMAIL='...'
 *   $env:STAFF_PASSWORD='...'
 *   deno run --allow-net --allow-env scripts/create-staff-user.ts
 *
 * The script calls POST /auth/v1/admin/users with email_confirm=true and
 * app_metadata.role="staff".  Supabase upserts by email, so re-running is safe.
 */

const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const email = Deno.env.get("STAFF_EMAIL");
const password = Deno.env.get("STAFF_PASSWORD");

const missing: string[] = [];
if (!url) missing.push("SUPABASE_URL");
if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (!email) missing.push("STAFF_EMAIL");
if (!password) missing.push("STAFF_PASSWORD");

if (missing.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missing.join(", ")}`,
  );
  console.error(
    "Set them in the environment — do not pass credentials via command-line arguments.",
  );
  Deno.exit(1);
}

console.log(`Creating/updating staff user: ${email}`);

const res = await fetch(`${url}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": key!,
    "Authorization": `Bearer ${key}`,
  },
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "staff" },
  }),
});

if (!res.ok) {
  const text = await res.text();
  let detail = text;
  try {
    const json = JSON.parse(text) as { msg?: string; message?: string };
    detail = json.msg ?? json.message ?? text;
  } catch {
    /* keep raw text */
  }
  console.error(`Failed (HTTP ${res.status}): ${detail}`);
  Deno.exit(1);
}

const user = await res.json() as { id?: string; email?: string };
console.log(`Done. Staff user id: ${user.id ?? "(unknown)"}, email: ${user.email ?? email}`);
console.log(
  "The account has app_metadata.role='staff' and is confirmed. Do not commit any credentials.",
);
