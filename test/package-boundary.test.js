import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shippedFiles = [
  "README.md",
  "package.json",
  "lib/index.js",
  "lib/client.js"
];

test("the usage meter package does not contain remote-access features", async () => {
  for (const path of shippedFiles) {
    const contents = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      contents,
      /tailscale|remote-access|remote access|\/api\/codex-meter\/remote-|RemoteAccess/i,
      `${path} must remain scoped to usage and billing`
    );
  }
});
