// Welke merk-modules kent het systeem. Een nieuw merk toevoegen = hier één regel.
import { makeBrand as taleoftiles } from "./brands/taleoftiles.mjs";
import { makeBrand as unclerank } from "./brands/unclerank.mjs";

export function buildRegistry(ctx) {
  const brands = [taleoftiles(ctx), unclerank(ctx)];
  const byId = {};
  for (const b of brands) byId[b.id] = b;
  return { brands, byId };
}
