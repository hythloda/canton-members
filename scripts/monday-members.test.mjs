import assert from "node:assert/strict";
import test from "node:test";
import { getMondayConfig, loadMondayMembers, normalizeWebsite } from "./monday-members.mjs";

const config = getMondayConfig({ MONDAY_API_TOKEN: "test-token" });
const columnIds = [config.tierColumnId, config.approvalColumnId, config.logoColumnId, config.websiteColumnId];
const logo = { id: "3298408052", name: "DLA_Piper_White.svg", file_extension: ".svg", file_size: 3660, public_url: "https://example.com/approved.svg" };

function item({ id = "1", name = "DLA Piper UK LLP", group = config.groupId, approval = "Yes", tier = "Associate", website = "https://www.dlapiper.com/en", assets = [logo] } = {}) {
  return {
    id, name, group: { id: group },
    column_values: [
      { id: config.approvalColumnId, text: approval },
      { id: config.tierColumnId, text: tier },
      { id: config.websiteColumnId, text: website },
      { id: config.logoColumnId, files: assets.map((asset) => ({ asset })) },
      { id: "private_contact", text: "private@example.com" }
    ]
  };
}

function board(items, cursor = null, overrides = {}) {
  return { id: config.boardId, groups: [{ id: config.groupId }], columns: columnIds.map((id) => ({ id })), items_page: { items, cursor }, ...overrides };
}

function response(data) {
  return { ok: true, json: async () => ({ data: { boards: [data] } }) };
}

test("DLA comes directly from Monday; only current approved members reach the public data", async () => {
  const downloads = [];
  const members = await loadMondayMembers(config, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.monday.com/v2");
      assert.equal(options.headers.Authorization, "test-token");
      assert.equal(options.headers["API-Version"], "2026-04");
      assert.deepEqual(JSON.parse(options.body).variables.boardIds, [config.boardId]);
      return response(board([
        item(),
        item({ id: "2", name: "Applicant", group: "new-applicants" }),
        item({ id: "3", name: "No logo consent", approval: "No" }),
        item({ id: "4", name: "Approval pending", approval: "Need Approval" }),
        item({ id: "5", name: "Missing approval", approval: "" })
      ]));
    },
    storeLogo: async (attachment, name, id) => {
      downloads.push({ attachment, name, id });
      return "members-assets/dla.svg?v=3298408052";
    }
  });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].attachment.url, logo.public_url);
  assert.deepEqual(members, [{ name: "DLA Piper UK LLP", tier: "Associate", website: "https://www.dlapiper.com/en", description: "", logoPath: "members-assets/dla.svg?v=3298408052" }]);
  assert.equal(JSON.stringify(members).includes("private@example.com"), false);
  assert.equal(JSON.stringify(members).includes("public_url"), false);
});

test("Visa and Lloyds retain their existing name-only exceptions without downloading logos", async () => {
  const members = await loadMondayMembers(config, {
    fetchImpl: async () => response(board([
      item({ name: "Visa Inc.", approval: "No", tier: "General" }),
      item({ id: "2", name: "Lloyds Bank Plc", approval: "No", tier: "General" }),
      item({ id: "3", name: "Unapproved member", approval: "No" })
    ])),
    storeLogo: async () => assert.fail("Unapproved logos must not be downloaded")
  });
  assert.equal(members.length, 2);
  assert.ok(members.every((member) => member.logoPath === ""));
});

test("all pages are read and duplicate items do not duplicate directory entries", async () => {
  const pages = [board([item({ assets: [] })], "next-page"), board([item({ assets: [] }), item({ id: "2", name: "Second member", assets: [] })])];
  const cursors = [];
  const members = await loadMondayMembers(config, {
    fetchImpl: async (_url, options) => {
      cursors.push(JSON.parse(options.body).variables.cursor);
      return response(pages.shift());
    }, storeLogo: async () => assert.fail("No logos in this fixture")
  });
  assert.deepEqual(cursors, [null, "next-page"]);
  assert.equal(members.length, 2);
});

test("approved missing or unsupported logos remain as names; a supported image is selected", async () => {
  const downloaded = [];
  const members = await loadMondayMembers(config, {
    fetchImpl: async () => response(board([
      item({ assets: [{ ...logo, name: "logo.ai", file_extension: ".ai" }, logo] }),
      item({ id: "2", name: "No image", assets: [] }),
      item({ id: "3", name: "Unsupported image", assets: [{ ...logo, file_extension: ".ai" }] })
    ])),
    storeLogo: async (asset) => { downloaded.push(asset); return "members-assets/logo.svg"; }
  });
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].id, logo.id);
  assert.deepEqual(members.map((member) => member.logoPath), ["members-assets/logo.svg", "", ""]);
});

test("API failures and missing credentials cannot silently produce an empty directory", async () => {
  const storeLogo = async () => "logo.svg";
  await assert.rejects(loadMondayMembers(getMondayConfig({}), { fetchImpl: async () => assert.fail("Missing token should fail before HTTP"), storeLogo }), /MONDAY_API_TOKEN/);
  await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => ({ ok: false, status: 401 }), storeLogo }), /401/);
  await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ errors: [{ message: "Access denied" }] }) }), storeLogo }), /Access denied/);
  await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ error_code: "NOT_AUTHENTICATED", error_message: "Not authenticated" }) }), storeLogo }), /NOT_AUTHENTICATED/);
  await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ errors: { message: "Access denied" } }) }), storeLogo }), /Access denied/);
  await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => response(board([])), storeLogo }), /no publishable/);
});

test("schema changes, invalid tiers, and broken logo downloads fail the refresh", async () => {
  const storeLogo = async () => "logo.svg";
  for (const [data, message] of [
    [board([item()], null, { id: "wrong-board" }), /not returned/],
    [board([item()], null, { groups: [] }), /Current Members group/],
    [board([item()], null, { columns: [] }), /required.*column/],
    [board([item({ tier: "" })]), /Invalid membership tier/]
  ]) {
    await assert.rejects(loadMondayMembers(config, { fetchImpl: async () => response(data), storeLogo }), message);
  }
  await assert.rejects(loadMondayMembers(config, {
    fetchImpl: async () => response(board([item()])), storeLogo: async () => { throw new Error("Download failed"); }
  }), /Download failed/);
  await assert.rejects(loadMondayMembers(config, {
    fetchImpl: async () => response(board([item()], "repeated")), storeLogo
  }), /repeated pagination/);
});

test("website links reject emails, script URLs, and malformed values", () => {
  assert.equal(normalizeWebsite("dlapiper.com/en"), "https://dlapiper.com/en");
  assert.equal(normalizeWebsite("HTTPS://cosimo.fund"), "https://cosimo.fund/");
  for (const value of [null, "", "person@example.com", "Company Name", "javascript:alert(1)", "https://user:password@example.com"]) {
    assert.equal(normalizeWebsite(value), "");
  }
});
