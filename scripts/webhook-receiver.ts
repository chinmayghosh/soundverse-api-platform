// A minimal customer-side webhook receiver, for demos and as a reference.
//   npm run webhook:receiver -- whsec_xxx            (listens on :4000)
//   PORT=4001 npm run webhook:receiver -- whsec_xxx
//   FAIL=1 npm run webhook:receiver -- whsec_xxx     (answers 503: simulate an outage)
//
// It does what a real integration should:
//   1. verify the signature over the *raw* body, within a 5-minute window
//   2. drop duplicate event ids (deliveries are at-least-once)
//   3. answer 2xx fast; do slow work afterwards
import { createServer } from "node:http";
import { WebhookVerificationError, verifyWebhook } from "../src/server/webhooks/crypto";

const secret = process.argv[2] ?? process.env.WEBHOOK_SECRET;
if (!secret?.startsWith("whsec_")) {
  console.error("usage: npm run webhook:receiver -- <whsec_... signing secret>");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 4000);
const seen = new Set<string>();

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const attempt = req.headers["soundverse-delivery-attempt"];
    if (process.env.FAIL) {
      console.log(`✗ simulated outage, answering 503 (attempt ${attempt})`);
      res.writeHead(503).end();
      return;
    }
    try {
      verifyWebhook(secret, req.headers["soundverse-signature"] as string, raw);
    } catch (e) {
      const reason = e instanceof WebhookVerificationError ? e.message : "error";
      console.log(`✗ rejected: ${reason}`);
      res.writeHead(400).end(reason);
      return;
    }
    const event = JSON.parse(raw);
    if (seen.has(event.id)) {
      console.log(`↺ duplicate ${event.id}, ignored`);
      res.writeHead(200).end();
      return;
    }
    seen.add(event.id);
    res.writeHead(200).end();
    console.log(`✓ verified ${event.type} ${event.id} (attempt ${attempt})`);
    console.log(`  generation ${event.data.id}: ${event.data.status}`);
    if (event.data.output?.audio_url) console.log(`  audio: ${event.data.output.audio_url}`);
  });
}).listen(port, () => console.log(`webhook receiver listening on http://localhost:${port}/webhooks`));
