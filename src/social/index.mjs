// SOCIAL-REGISTRY: welke PLATFORMS het systeem kent, en per platform DRIE taal-accounts
// (NL/EN/FR) — elk een eigen account met eigen token. Een "account" = platform + taal.
// Een nieuw platform toevoegen = één bestand (zoals youtube.mjs) + één regel hier.
// Zelfde patroon als de merk-registry (src/registry.mjs).
//
// PER MERK: buildSocial({ ROOT, brand }) geeft één social-instance voor DAT merk. De tokens worden
// per merk apart bewaard: Tale of Tiles houdt <ROOT>/secrets/ (bestaande logins blijven staan),
// elk ander merk krijgt <ROOT>/brands/<merk>/secrets/. Zo kan UncleRank z'n eigen kanalen koppelen
// zonder die van Tale of Tiles te raken.
import path from "node:path";
import { makePlatform as youtube, suggest } from "./youtube.mjs";
import { makeMetaAuth } from "./meta.mjs";
import { makeInstagram } from "./instagram.mjs";
import { makeFacebook } from "./facebook.mjs";
import { makeTikTok } from "./tiktok.mjs";
import { makeWhatsApp } from "./whatsapp.mjs";
import { makeStub } from "./stub.mjs";

export const LANGS = ["nl", "en", "fr"];
export const LANG_LABEL = { nl: "NL", en: "EN", fr: "FR" };

export function buildSocial(ctx = {}) {
  const brand = ctx.brand || "taleoftiles";
  // Secrets-basis per merk. Tale of Tiles = <ROOT> (dus <ROOT>/secrets, ongewijzigd); andere merken
  // = <ROOT>/brands/<merk> (dus <ROOT>/brands/<merk>/secrets). Elk platform zet z'n token in <base>/secrets.
  const brandRoot = (brand === "taleoftiles") ? (ctx.ROOT || ".") : path.join(ctx.ROOT || ".", "brands", brand);
  // Meta-auth wordt gedeeld door Instagram én Facebook (één FB-login per taal), per merk.
  const metaAuth = makeMetaAuth({ ROOT: brandRoot, brand });
  // publicUrlFor: zet een lokale mp4 op een publieke URL (R2) voor Instagram. Levert de engine
  // via ctx.publicUrlFor; ontbreekt die, dan geeft IG een nette "R2 nog niet ingesteld"-fout.
  const publicUrlFor = ctx.publicUrlFor;

  // Platform-definities in UI-volgorde. Elk levert de gedeelde kanaal-vorm (suggest/upload/…).
  // brandRoot bepaalt waar elk platform z'n tokens bewaart (per merk apart).
  const platforms = [
    youtube({ ROOT: brandRoot }),
    makeInstagram({ auth: metaAuth, suggest, publicUrlFor }),
    makeFacebook({ auth: metaAuth, suggest }),
    makeTikTok({ ROOT: brandRoot, suggest, brand }),
    makeWhatsApp({ suggest, r2Put: ctx.r2Put, imgBase: ctx.imgBase }),
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

  return { brand, platforms, platById, accounts, accById, listPlatforms, listAccounts, LANGS, LANG_LABEL };
}
