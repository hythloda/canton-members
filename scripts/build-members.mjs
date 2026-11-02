#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMondayConfig, loadMondayMembers } from "./monday-members.mjs";

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

  const config = getMondayConfig();
  const logoCache = await loadLogoCache();
  await fs.mkdir(path.join(rootDir, "members-assets"), { recursive: true });
  const rawMembers = sampleArg ? await loadSampleMembers() : await loadMondayMembers(config, {
    storeLogo: (attachment, name, id) => downloadLogo(attachment, name, id, buildLogoVersion(attachment, null, id), logoCache)
  });
  const normalized = normalizeMembers(rawMembers);
  const tiers = buildTiers(normalized);
  const updatedAt = new Date().toISOString();

  await fs.writeFile(
    path.join(rootDir, "members-data.js"),
    "window.MEMBERS_DATA = " + JSON.stringify({
      updatedAt,
      source: sampleArg ? "sample" : "monday",
      intro: "A current view of the member network, refreshed from Monday and organized by membership tier.",
      tiers
    }, null, 2) + ";\n",
    "utf8"
  );

  const pagePath = path.join(rootDir, "members.html");
  const page = await fs.readFile(pagePath, "utf8");
  const dataScript = /<script src="members-data\.js(?:\?[^"]*)?"><\/script>/;
  if (!dataScript.test(page)) {
    throw new Error("Cannot version the member data script in members.html.");
  }
  await fs.writeFile(pagePath, page.replace(dataScript, `<script src="members-data.js?v=${Date.parse(updatedAt)}"></script>`), "utf8");

  await saveLogoCache(logoCache);

  console.log(`Wrote members-data.js with ${normalized.length} members across ${tiers.length} tiers.`);
}

async function loadSampleMembers() {
  const samplePath = path.join(rootDir, "data", "members.sample.json");
  const contents = await fs.readFile(samplePath, "utf8");
  return JSON.parse(contents);
}

async function downloadLogo(attachment, memberName, recordId, logoVersion, logoCache) {

  if (!attachment || !attachment.url) {
    return "";
  }

  if (!isRenderableLogoAsset(attachment)) {
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


function isRenderableLogoAsset(attachment) {
  if (!attachment) return false;

  const supportedMimeTypes = new Set([
    'image/png',
    'image/jpeg',
    'image/svg+xml',
    'image/webp',
    'image/gif',
    'image/avif'
  ]);

  if (supportedMimeTypes.has(attachment.type)) {
    return true;
  }

  const extension = guessExtension(attachment.filename || '', attachment.type || '', attachment.url || '');
  return ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.avif'].includes(extension);
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
