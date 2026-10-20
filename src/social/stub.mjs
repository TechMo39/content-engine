// SOCIAL-PLATFORM: generieke STUB voor platforms die nog niet gebouwd zijn (TikTok,
// Instagram, Facebook, WhatsApp). Zelfde vorm als een echt platform, maar enabled:false ->
// de UI toont de taal-accounts grijs met "binnenkort". Elk platform heeft straks (net als
// YouTube) drie taal-accounts; de lang komt als argument mee. Zodra een platform echt gebouwd
// wordt, krijgt het een eigen bestand en vervangt dat de stub in index.mjs.
export function makeStub({ id, label }) {
  return {
    id,
    label,
    enabled: false,
    needsAuth: true,
    suggest() { return { title: "", description: "", tags: [] }; },
    async authStatus(lang) { return { connected: false, who: "" }; },
    async upload(video, meta, lang, log) { throw new Error(label + " " + String(lang || "").toUpperCase() + " — binnenkort (nog niet gebouwd)"); },
    async stats(postId, lang) { return null; },
  };
}
