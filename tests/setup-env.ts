// Defaults so `npm test` works on the host against `docker compose up -d postgres storage`.
// Anything already set (e.g. by the compose `test` service) wins.
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://soundverse:soundverse@localhost:5432/soundverse_test",
  API_KEY_PEPPER: "test-pepper-0123456789abcdef0123456789",
  WEBHOOK_SECRET_ENC_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "s3admin",
  S3_SECRET_KEY: "s3admin-secret",
  S3_BUCKET: "soundverse-audio",
  LIVE_PROVIDER: "mock",
  MOCK_LATENCY_MS: "50",
  MOCK_FAILURE_RATE: "0",
};

for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
// Never let a developer's real provider key leak into a test run.
process.env.LIVE_PROVIDER = "mock";
delete process.env.FAL_KEY;
