// SOCIAL-REGISTRY: welke PLATFORMS het systeem kent, en per platform DRIE taal-accounts
// (NL/EN/FR) — elk een eigen account met eigen token. Een "account" = platform + taal.
// Een nieuw platform toevoegen = één bestand (zoals youtube.mjs) + één regel hier.
// Zelfde patroon als de merk-registry (src/registry.mjs).
import { makePlatform as youtube, suggest } from "./youtube.mjs";
import { makeMetaAuth } from "./meta.mjs";
import { makeInstagram } from "./instagram.mjs";
import { makeFacebook } from "./facebook.mjs";
import { makeStub } from "./stub.mjs";

export const LANGS = ["nl", "en", "fr"];
export const LANG_LABEL = { nl: "NL", en: "EN", fr: "FR" };

export function buildSocial(ctx = {}) {
  // Meta-auth wordt gedeeld door Instagram én Facebook (één FB-login per taal).
  const metaAuth = makeMetaAuth(ctx);
  // publicUrlFor: zet een lokale mp4 op een publieke URL (R2) voor Instagram. Levert de engine
  // via ctx.publicUrlFor; ontbreekt die, dan geeft IG een nette "R2 nog niet ingesteld"-fout.
  const publicUrlFor = ctx.publicUrlFor;

  // Platform-definities in UI-volgorde. Elk levert de gedeelde kanaal-vorm (suggest/upload/…).
  // ctx.ROOT geven we door zodat een platform z'n tokens in <root>/secrets/ kan bewaren.
  const platforms = [
    youtube(ctx),
    makeInstagram({ auth: metaAuth, suggest, publicUrlFor }),
    makeFacebook({ auth: metaAuth, suggest }),
    makeStub({ id: "tiktok", label: "TikTok" }),
    makeStub({ id: "whatsapp", label: "WhatsApp" }),
  ];
  const platById = {};
  for (const p of platforms) platById[p.id] = p;

  // Accounts = platform × taal. accountId = "<platform>-<taal>" (bv. youtube-nl).
  const accounts = [];
  for (const p of platforms) for (const lang of LANGS) {
    accounts.push({ id: `${p.id}-${lang}`, platform: p.id, lang, label: p.label, langLabel: LANG_LABEL[lang], enabled: p.enabled, needsAuth: p.needsAuth });
  }
  const accById = {};
  for (const a of accounts) accById[a.id] = a;

  // Lichte vorm voor de UI (geen functies). Platforms + hun 3 talen.
  const listPlatforms = () => platforms.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled, needsAuth: p.needsAuth, langs: LANGS.slice() }));
  const listAccounts = () => accounts.map((a) => ({ ...a }));

  return { platforms, platById, accounts, accById, listPlatforms, listAccounts, LANGS, LANG_LABEL };
}
