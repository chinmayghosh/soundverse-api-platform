import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

// Two clients: `internal` talks to the store from inside the network;
// `signer` only signs URLs with the host clients can reach. The signature
// covers the Host header, so URLs must be signed for the public host.
let internal: S3Client | undefined;
let signer: S3Client | undefined;

function client(kind: "internal" | "signer"): S3Client {
  const e = env();
  const make = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: e.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
    });
  if (kind === "internal") return (internal ??= make(e.S3_ENDPOINT));
  return (signer ??= make(e.S3_PUBLIC_ENDPOINT));
}

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  await client("internal").send(
    new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function presignGet(key: string): Promise<{ url: string; expiresAt: Date }> {
  const ttl = env().AUDIO_URL_TTL_SEC;
  const url = await getSignedUrl(
    client("signer"),
    new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
    { expiresIn: ttl },
  );
  return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
}

// Idempotent; retries while the store is still starting up.
export async function ensureBucket(attempts = 30) {
  const Bucket = env().S3_BUCKET;
  for (let i = 1; ; i++) {
    try {
      await client("internal").send(new HeadBucketCommand({ Bucket }));
      return;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        await client("internal").send(new CreateBucketCommand({ Bucket }));
        return;
      }
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
