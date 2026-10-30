/**
 * Supabase Auth token verification for edge functions.
 *
 * Calls GET {SUPABASE_URL}/auth/v1/user with the caller's Bearer token and the
 * service-role key.  Returns the user's id and email when the token belongs to
 * a user whose app_metadata.role === "staff".
 *
 * No new npm dependencies – uses only the platform-provided fetch.
 */

export interface StaffIdentity {
  id: string;
  email: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Exposed for tests: override with a fake fetch. */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function verifyStaffToken(
  authHeader: string | null,
  fetchFn: FetchFn = fetch,
): Promise<StaffIdentity> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "Missing or malformed Authorization header");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthError(401, "Missing or malformed Authorization header");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");

  // In production (no custom fetchFn) env vars must be present.
  // A custom fetchFn (e.g. from tests) may be used without env vars; in that case
  // use placeholder values so the call reaches the provided function.
  const isDefaultFetch = fetchFn === fetch;
  if (isDefaultFetch && (!supabaseUrl || !serviceKey)) {
    throw new AuthError(500, "Auth service not configured");
  }
  const effectiveUrl = supabaseUrl ?? "https://localhost.supabase.test";
  const effectiveKey = serviceKey ?? "test-service-key";

  const res = await fetchFn(
    `${effectiveUrl.replace(/\/+$/, "")}/auth/v1/user`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: effectiveKey,
      },
    },
  );

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(401, "Invalid or expired session");
  }
  if (!res.ok) {
    throw new AuthError(401, "Invalid or expired session");
  }

  const user = await res.json() as {
    id?: string;
    email?: string;
    app_metadata?: { role?: string };
  };

  if (!user?.id || !user?.email) {
    throw new AuthError(401, "Invalid or expired session");
  }

  if (user.app_metadata?.role !== "staff") {
    throw new AuthError(403, "Forbidden: staff role required");
  }

  return { id: user.id, email: user.email };
}
