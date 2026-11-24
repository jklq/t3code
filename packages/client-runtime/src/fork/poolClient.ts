import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient, type ProviderIcon } from "@t3tools/provider-core/client";
import * as Schema from "effect/Schema";

// Stacked layers emblem: distinct from individual provider glyphs and readable at 14-20px.
const poolIcon: ProviderIcon = {
  viewBox: "0 0 24 24",
  fill: { light: "#171717", dark: "#e5e5e5" },
  paths: [
    {
      d: "M12 2.75L2.5 7.75L12 12.75L21.5 7.75L12 2.75Z",
    },
    {
      d: "M3.75 11.75L2.5 12.42L12 17.42L21.5 12.42L20.25 11.75L12 16.08L3.75 11.75Z",
    },
    {
      d: "M3.75 16.17L2.5 16.83L12 21.83L21.5 16.83L20.25 16.17L12 20.5L3.75 16.17Z",
    },
  ],
};

// Pool members are edited with PoolMembersSection rather than generic schema fields.
const PoolClientSettingsSchema = Schema.Struct({});

export const poolClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("pool"),
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Provider proper name
  label: "Pool",
  icon: poolIcon,
  modelFamilies: ["Gemini "],
  hasDefaultInstance: false,
  featured: true,
  settingsSchema: PoolClientSettingsSchema,
});
