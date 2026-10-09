import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),

  // Secrets. Each must be long random strings; see .env.example.
  API_KEY_PEPPER: z.string().min(32),
  WEBHOOK_SECRET_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "must be 32 bytes hex"),
  BETTER_AUTH_SECRET: z.string().min(32),

  // S3-compatible storage. S3_ENDPOINT is what the server talks to;
  // S3_PUBLIC_ENDPOINT is the host baked into signed URLs handed to clients.
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  AUDIO_URL_TTL_SEC: z.coerce.number().int().positive().default(3600),

  // Music providers. Live keys use LIVE_PROVIDER; test keys always use the mock.
  LIVE_PROVIDER: z.enum(["fal", "mock"]).default("mock"),
  FAL_KEY: z.string().optional(),
  LIVE_PROVIDER_MAX_CALLS: z.coerce.number().int().nonnegative().default(20),
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(3000),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Worker tuning.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JOB_LEASE_SEC: z.coerce.number().int().positive().default(60),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

  KEY_ROTATION_GRACE_SEC: z.coerce.number().int().nonnegative().default(86400),
  ALLOW_HTTP_WEBHOOKS: z.stringbool().default(false),
  // Comma-separated exact hostnames exempt from the private-address check.
  // Local development only (e.g. "localhost,host.docker.internal").
  WEBHOOK_ALLOW_PRIVATE_HOSTS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

// Parsed lazily so `next build` can import modules without a full runtime env.
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}
