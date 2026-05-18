#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sampleArg = process.argv.includes("--sample");
const logoCachePath = path.join(rootDir, ".members-logo-cache.json");

async function main() {
  const env = await loadEnvFile(path.join(rootDir, ".env.members"));

  for (const [key, value] of Object.entries(env)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }

  const config = getConfig();
  const logoCache = await loadLogoCache();
  const rawMembers = sampleArg ? await loadSampleMembers() : await loadAirtableMembers(config, logoCache);
  const normalized = normalizeMembers(rawMembers);
  const tiers = buildTiers(normalized);

  await fs.mkdir(path.join(rootDir, "members-assets"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "members-data.js"),
    "window.MEMBERS_DATA = " + JSON.stringify({
      updatedAt: new Date().toISOString(),
      intro: "A current view of the member network, refreshed from Airtable and organized by membership tier.",
      tiers
    }, null, 2) + ";\n",
    "utf8"
  );

  await saveLogoCache(logoCache);

  console.log(`Wrote members-data.js with ${normalized.length} members across ${tiers.length} tiers.`);
}

function getConfig() {
  return {
    token: process.env.AIRTABLE_TOKEN || "",
    baseId: process.env.AIRTABLE_BASE_ID || "",
    tableId: process.env.AIRTABLE_TABLE_ID || "",
    view: process.env.AIRTABLE_VIEW || "",
    nameField: process.env.AIRTABLE_NAME_FIELD || "Member Name",
    tierField: process.env.AIRTABLE_TIER_FIELD || "Type",
    logoField: process.env.AIRTABLE_LOGO_FIELD || "Logo",
    logoModifiedField: process.env.AIRTABLE_LOGO_MODIFIED_FIELD || "Modified",
    logoApprovedField: process.env.AIRTABLE_LOGO_APPROVED_FIELD || process.env.AIRTABLE_APPROVED_FIELD || "PR/Logo Usage",
    websiteEnabledField: process.env.AIRTABLE_WEBSITE_ENABLED_FIELD || "",
    urlField: process.env.AIRTABLE_URL_FIELD || "Website",
    descriptionField: process.env.AIRTABLE_DESCRIPTION_FIELD || "Address",
    approvedValues: (process.env.AIRTABLE_APPROVED_VALUES || "yes")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    websiteEnabledValues: (process.env.AIRTABLE_WEBSITE_ENABLED_VALUES || "true,yes,1,checked,on")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  };
}

async function loadSampleMembers() {
  const samplePath = path.join(rootDir, "data", "members.sample.json");
  const contents = await fs.readFile(samplePath, "utf8");
  return JSON.parse(contents);
}

async function loadAirtableMembers(config, logoCache) {
  const missing = [];

  if (!config.token) missing.push("AIRTABLE_TOKEN");
  if (!config.baseId) missing.push("AIRTABLE_BASE_ID");
  if (!config.tableId) missing.push("AIRTABLE_TABLE_ID");

  if (missing.length) {
    throw new Error("Missing required Airtable configuration: " + missing.join(", "));
  }

  const params = new URLSearchParams({ pageSize: "100" });

  if (config.view) {
    params.set("view", config.view);
  }

  const allRecords = [];
  let offset = "";

  do {
    if (offset) {
      params.set("offset", offset);
    } else {
      params.delete("offset");
    }

    const url = `https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tableId)}?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`
      }
    });

    if (!response.ok) {
      const details = await safeText(response);
      throw new Error(`Airtable request failed (${response.status}): ${details}`);
    }

    const payload = await response.json();

    for (const record of payload.records || []) {
      allRecords.push(await mapRecord(record, config, logoCache));
    }

    offset = payload.offset || "";
  } while (offset);

  return allRecords;
}

async function mapRecord(record, config, logoCache) {
  const fields = record.fields || {};
  const onWebsite = isApproved(fields[config.websiteEnabledField], config.websiteEnabledValues);

  if (config.websiteEnabledField && !onWebsite) {
    return null;
  }

  const logoApproved = isApproved(fields[config.logoApprovedField], config.approvedValues);

  if (config.logoApprovedField && !logoApproved) {
    return null;
  }

  const name = toText(fields[config.nameField]) || "Untitled member";
  const tier = toText(fields[config.tierField]) || "General";
  const website = normalizeUrl(toText(fields[config.urlField]));
  const description = toText(fields[config.descriptionField]);
  const attachment = Array.isArray(fields[config.logoField]) ? fields[config.logoField][0] : null;
  const logoVersion = buildLogoVersion(attachment, fields[config.logoModifiedField], record.id);
  const logoPath = await downloadLogo(attachment, name, record.id, logoVersion, logoCache);

  return { name, tier, website, description, logoPath };
}

async function downloadLogo(attachment, memberName, recordId, logoVersion, logoCache) {

  if (!attachment || !attachment.url) {
    return "";
  }

  const sourceUrl = attachment.url;
  const extension = guessExtension(attachment.filename || "", attachment.type || "", sourceUrl);
  const fileName = `${slugify(memberName)}${extension}`;
  const relativePath = path.posix.join("members-assets", fileName);
  const outputPath = path.join(rootDir, relativePath);

  const cacheKey = String(recordId || memberName);
  const cacheEntry = logoCache[cacheKey];

  if (cacheEntry && cacheEntry.version === logoVersion && cacheEntry.relativePath === relativePath && fsSync.existsSync(outputPath)) {
    return withVersion(relativePath, logoVersion);
  }

  const response = await fetch(sourceUrl);

  if (!response.ok) {
    throw new Error(`Unable to download logo for ${memberName} (${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
  logoCache[cacheKey] = { version: logoVersion, relativePath, updatedAt: new Date().toISOString() };

  return withVersion(relativePath, logoVersion);
}

function normalizeMembers(members) {
  return members
    .filter((member) => member && member.name)
    .sort((left, right) => {
      const tierCompare = tierRank(left.tier) - tierRank(right.tier);
      return tierCompare || left.name.localeCompare(right.name);
    });
}

function buildTiers(members) {
  const grouped = new Map();

  for (const member of members) {
    const key = toTierLabel(member.tier);

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(member);
  }

  return [...grouped.entries()]
    .sort((left, right) => tierRank(left[0]) - tierRank(right[0]))
    .map(([label, tierMembers]) => ({
      slug: slugify(label),
      label,
      members: tierMembers
    }));
}

function toTierLabel(value) {
  const tier = toText(value) || "General";
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}

function tierRank(value) {
  const normalized = toTierLabel(value).toLowerCase();
  const order = ["premier", "general", "associate"];
  const index = order.indexOf(normalized);
  return index === -1 ? order.length : index;
}

function toText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
  return "";
}

function normalizeUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

async function loadLogoCache() {
  try {
    const contents = await fs.readFile(logoCachePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function saveLogoCache(cache) {
  await fs.writeFile(logoCachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

function normalizeVersion(value) {
  const text = toText(value);
  return text ? text.replace(/[^a-zA-Z0-9._:-]/g, "-") : "";
}

function buildLogoVersion(attachment, modifiedValue, fallback) {
  if (!attachment) {
    return normalizeVersion(modifiedValue) || String(fallback || "");
  }

  const parts = [
    attachment.id,
    attachment.filename,
    attachment.size,
    attachment.type,
    normalizeVersion(modifiedValue)
  ].filter(Boolean);

  return normalizeVersion(parts.join("-")) || String(fallback || "");
}

function withVersion(relativePath, version) {
  return version ? `${relativePath}?v=${encodeURIComponent(version)}` : relativePath;
}


function isApproved(value, approvedValues) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  const normalized = toText(value).toLowerCase();
  return approvedValues.includes(normalized);
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function guessExtension(filename, mimeType, sourceUrl) {
  const fileMatch = filename.match(/\.[a-zA-Z0-9]+$/);
  if (fileMatch) return fileMatch[0].toLowerCase();

  const mimeMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };

  if (mimeMap[mimeType]) {
    return mimeMap[mimeType];
  }

  try {
    const pathname = new URL(sourceUrl).pathname;
    const urlMatch = pathname.match(/\.[a-zA-Z0-9]+$/);
    if (urlMatch) return urlMatch[0].toLowerCase();
  } catch {}

  return ".png";
}

async function loadEnvFile(filePath) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const splitIndex = line.indexOf("=");
          const key = line.slice(0, splitIndex).trim();
          const value = line.slice(splitIndex + 1).trim();
          return [key, value];
        })
    );
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return response.statusText || "Unknown error";
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
