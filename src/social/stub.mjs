// SOCIAL-KANAAL: generieke STUB voor kanalen die nog niet gebouwd zijn (TikTok, Instagram,
// Facebook, WhatsApp). Zelfde vorm als een echt kanaal, maar enabled:false -> de UI toont 'm
// grijs met "binnenkort". Zodra een kanaal echt gebouwd wordt, krijgt het een eigen bestand
// (zoals youtube.mjs) en vervangt dat de stub in index.mjs. Herhaalt de auto-teksten niet:
// die lenen we van YouTube's suggest zodra het kanaal leeft; nu niet nodig.
export function makeStub({ id, label }) {
  return {
    id,
    label,
    enabled: false,
    needsAuth: true,
    suggest() { return { title: "", description: "", tags: [] }; },
    async authStatus() { return { connected: false, who: "" }; },
    async upload() { throw new Error(label + " — binnenkort (nog niet gebouwd)"); },
    async stats() { return null; },
  };
}
