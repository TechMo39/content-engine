// R2 via de WORKER (niet rechtstreeks). De worker heeft als enige de R2-binding; wij praten met
// 'm over HTTPS met één gedeelde sleutel (UPLOAD_KEY). Geen S3-secrets, niks gevoeligs in code.
//
// .env nodig:
//   UPLOAD_KEY         (zelfde waarde als de worker-secret UPLOAD_KEY)
//   TOT_WORKER_BASE    (optioneel; standaard https://taleoftiles.com)
//
// Worker-routes die dit verwacht (via `wrangler secret put UPLOAD_KEY` + één klein blok):
//   PUT  /api/video-upload?key=<key>   header x-upload-key   body = bytes
//   POST /api/video-delete?key=<key>   header x-upload-key

const BASE = () => (process.env.TOT_WORKER_BASE || "https://taleoftiles.com").replace(/\/$/, "");
function key() {
  const k = process.env.UPLOAD_KEY;
  if (!k) throw new Error("UPLOAD_KEY ontbreekt in .env (zelfde waarde als de worker-secret)");
  return k;
}

export async function r2Put(objKey, body, contentType = "application/octet-stream") {
  const res = await fetch(`${BASE()}/api/video-upload?key=${encodeURIComponent(objKey)}`, {
    method: "PUT", headers: { "x-upload-key": key(), "content-type": contentType }, body,
  });
  if (!res.ok) throw new Error(`worker-upload faalde: ${res.status} ${(await res.text()).slice(0, 160)} (staat /api/video-upload + UPLOAD_KEY op de worker?)`);
  return objKey;
}

export async function r2Delete(objKey) {
  try { await fetch(`${BASE()}/api/video-delete?key=${encodeURIComponent(objKey)}`, { method: "POST", headers: { "x-upload-key": key() } }); } catch {}
}
