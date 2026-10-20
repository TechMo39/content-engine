// SOCIAL-REGISTRY: welke kanalen het systeem kent, in de volgorde waarin ze in de UI staan.
// Een nieuw kanaal toevoegen = één bestand (zoals youtube.mjs) + één regel hier (de stub
// vervangen door de echte module). Zelfde patroon als de merk-registry (src/registry.mjs).
import { makeChannel as youtube } from "./youtube.mjs";
import { makeStub } from "./stub.mjs";

export function buildSocial() {
  const channels = [
    youtube(),
    makeStub({ id: "instagram", label: "Instagram" }),
    makeStub({ id: "facebook", label: "Facebook" }),
    makeStub({ id: "tiktok", label: "TikTok" }),
    makeStub({ id: "whatsapp", label: "WhatsApp" }),
  ];
  const byId = {};
  for (const c of channels) byId[c.id] = c;
  // Lichte vorm voor de UI (geen functies meesturen).
  const list = () => channels.map((c) => ({ id: c.id, label: c.label, enabled: c.enabled, needsAuth: c.needsAuth }));
  return { channels, byId, list };
}
