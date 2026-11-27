import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_IOS_PERSONAL_TEAM: process.env.T3CODE_IOS_PERSONAL_TEAM,
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: process.env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID,
    T3CODE_IOS_PERSONAL_TEAM_ID: process.env.T3CODE_IOS_PERSONAL_TEAM_ID,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(
  variant: string | undefined,
  extraEnv: Record<string, string | undefined> = {},
) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  for (const [key, value] of Object.entries(extraEnv)) {
    vi.stubEnv(key, value);
  }
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("strips paid-team signing settings and OTA updates for Personal Team iOS builds", async () => {
  const config = await loadConfig("production", {
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.t3code",
    T3CODE_IOS_PERSONAL_TEAM_ID: "G84T2A9GPN",
  });
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code");
  expect(config.ios?.appleTeamId).toBe("G84T2A9GPN");
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.ios?.entitlements).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
});
