// Welke merk-modules kent het systeem. Een nieuw merk toevoegen = hier één regel.
import { makeBrand as taleoftiles } from "./brands/taleoftiles.mjs";
import { makeBrand as channel1 } from "./brands/channel1.mjs";

export function buildRegistry(ctx) {
  const brands = [taleoftiles(ctx), channel1(ctx)];
  const byId = {};
  for (const b of brands) byId[b.id] = b;
  return { brands, byId };
}
