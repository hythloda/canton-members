import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { mergeMemberSupplements } from "./member-supplements.mjs";

const supplements = JSON.parse(await fs.readFile(new URL("../data/members.supplemental.json", import.meta.url), "utf8"));

test("a legacy refresh retains the verified DLA member and approved local logo", async () => {
  const existing = { name: "Existing member", tier: "General", logoPath: "" };
  const merged = mergeMemberSupplements([existing, null], supplements);
  assert.deepEqual(merged[0], existing);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].name, "DLA Piper");
  assert.equal(merged[1].tier, "Associate");
  assert.equal(merged[1].website, "https://www.dlapiper.com/en");
  const logo = await fs.readFile(new URL("../" + merged[1].logoPath.split("?")[0], import.meta.url), "utf8");
  assert.match(logo, /<svg\s/);
  assert.equal("source" in merged[1], false);
});

test("future legacy entries under DLA's display or legal name do not duplicate it", () => {
  const merged = mergeMemberSupplements([
    { name: "DLA Piper", tier: "General" },
    { name: " dla piper uk llp ", tier: "General" }
  ], supplements);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tier, "Associate");
  assert.deepEqual(mergeMemberSupplements(merged, supplements), merged);
});

test("unverified logo usage fails the build", () => {
  assert.throws(() => mergeMemberSupplements([], [{ ...supplements[0], logoApproved: false }]), /approved logo usage/);
});
