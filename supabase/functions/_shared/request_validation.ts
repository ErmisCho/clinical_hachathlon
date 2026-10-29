/** Limits apply before database connection or pipeline execution. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TEXT_LENGTH = 8000;
export const MAX_DEFINITIONS = 50;
export const MAX_DEFINITION_LENGTH = 2000;
export const REQUESTED_AS = [
  "health data request",
  "health data access application",
] as const;

export class RequestInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Count actual streamed bytes, including when Content-Length is absent or false. */
export async function readRequestJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
    void req.body?.cancel().catch(() => {});
    throw new RequestInputError(413, "body exceeds 64 KB limit");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new RequestInputError(400, "invalid JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestInputError(413, "body exceeds 64 KB limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof RequestInputError) throw error;
    throw new RequestInputError(400, "invalid JSON body");
  } finally {
    reader.releaseLock();
  }
}

/** Return all field problems without echoing untrusted input. Empty definitions
 * are valid: the pipeline returns a review result for unsupported definitions. */
export function validateRequest(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["body must be a JSON object"];
  }
  const body = value as Record<string, unknown>;
  const problems: string[] = [];
  // spe_ plus the id must fit PostgreSQL's 63-byte identifier limit.
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_]{1,59}$/.test(body.id)) {
    problems.push("id must contain 1–59 ASCII letters, digits or underscores");
  }
  for (const field of ["purpose", "question"]) {
    const text = body[field];
    if (
      typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH
    ) {
      problems.push(
        `${field} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
      );
    }
  }
  if (!REQUESTED_AS.some((allowed) => body.requested_as === allowed)) {
    problems.push(`requested_as must be one of: ${REQUESTED_AS.join(", ")}`);
  }
  if (!Array.isArray(body.definitions)) {
    problems.push("definitions must be an array of strings");
  } else {
    if (body.definitions.length > MAX_DEFINITIONS) {
      problems.push(
        `definitions must contain at most ${MAX_DEFINITIONS} entries`,
      );
    }
    body.definitions.slice(0, MAX_DEFINITIONS).forEach((definition, index) => {
      if (
        typeof definition !== "string" || !definition.trim() ||
        definition.length > MAX_DEFINITION_LENGTH
      ) {
        problems.push(
          `definitions[${index}] must be a non-empty string of at most ${MAX_DEFINITION_LENGTH} characters`,
        );
      }
    });
  }
  return problems;
}
