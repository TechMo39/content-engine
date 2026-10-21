// Minimale R2-client (Cloudflare S3-compatibel), kaal met node:crypto — geen SDK, geen deps.
// Zet/verwijdert objecten rechtstreeks in de bucket via AWS SigV4. Raakt de worker niet aan;
// de worker serveert bestaande objecten al publiek op /img/<key>.
//
// .env nodig:
//   R2_ACCOUNT_ID         (Cloudflare account-id)
//   R2_ACCESS_KEY_ID      (R2 API-token: Access Key ID)
//   R2_SECRET_ACCESS_KEY  (R2 API-token: Secret Access Key)
//   R2_BUCKET             (de bucketnaam achter de worker, bv. yalsou-configurator-images)
import crypto from "node:crypto";

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function creds() {
  const account = process.env.R2_ACCOUNT_ID, akid = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET;
  if (!account || !akid || !secret || !bucket) throw new Error("R2-gegevens ontbreken in .env (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)");
  return { account, akid, secret, bucket };
}

// Onderteken en voer één S3-request uit (PUT of DELETE) op <bucket>/<key>.
async function s3(method, key, body, contentType) {
  const { account, akid, secret, bucket } = creds();
  const host = `${account}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const region = "auto", service = "s3";
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const payload = body ? Buffer.from(body) : Buffer.alloc(0);
  const payloadHash = sha256hex(payload);

  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzdate };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzdate, scope, sha256hex(Buffer.from(canonicalRequest))].join("\n");
  const kDate = hmac("AWS4" + secret, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${akid}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, { method, headers: { ...headers, authorization }, body: payload.length ? payload : undefined });
  if (!res.ok) throw new Error(`R2 ${method} faalde: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function r2Put(key, body, contentType = "application/octet-stream") { await s3("PUT", key, body, contentType); return key; }
export async function r2Delete(key) { await s3("DELETE", key, null, null); }
