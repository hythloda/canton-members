const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".avif"]);
const mimeTypes = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif"
};

export function getMondayConfig(env = process.env) {
  return {
    token: env.MONDAY_API_TOKEN || "",
    apiVersion: env.MONDAY_API_VERSION || "2026-04",
    boardId: env.MONDAY_BOARD_ID || "18418382784",
    groupId: env.MONDAY_GROUP_ID || "group_mm7qj8b3",
    tierColumnId: env.MONDAY_TIER_COLUMN_ID || "color_mm891eb8",
    logoColumnId: env.MONDAY_LOGO_COLUMN_ID || "file_mm4ebxv1",
    approvalColumnId: env.MONDAY_APPROVAL_COLUMN_ID || "color_mm89z1pw",
    websiteColumnId: env.MONDAY_WEBSITE_COLUMN_ID || "text_mm7wwmtm",
    nameOnlyMembers: new Set((env.MONDAY_NAME_ONLY_MEMBERS ?? "Visa Inc.|Lloyds Bank Plc")
      .split("|").map((name) => name.trim().toLowerCase()).filter(Boolean))
  };
}

const query = `query MemberDirectory($boardIds: [ID!]!, $cursor: String, $columnIds: [String!]!) {
  boards(ids: $boardIds) {
    id
    groups { id }
    columns(ids: $columnIds) { id }
    items_page(limit: 500, cursor: $cursor) {
      cursor
      items {
        id name group { id }
        column_values(ids: $columnIds) {
          id text
          ... on FileValue {
            files { ... on FileAssetValue { asset { id name file_extension file_size public_url } } }
          }
        }
      }
    }
  }
}`;

export async function loadMondayMembers(config, { fetchImpl = fetch, storeLogo } = {}) {
  if (!config.token) throw new Error("MONDAY_API_TOKEN is required to refresh members from Monday.");
  if (typeof storeLogo !== "function") throw new Error("A logo storage callback is required.");

  const columnIds = [config.tierColumnId, config.logoColumnId, config.approvalColumnId, config.websiteColumnId];
  const items = new Map();
  const cursors = new Set();
  let cursor = null;

  do {
    const response = await fetchImpl("https://api.monday.com/v2", {
      method: "POST",
      headers: { Authorization: config.token, "Content-Type": "application/json", "API-Version": config.apiVersion },
      body: JSON.stringify({ query, variables: { boardIds: [config.boardId], cursor, columnIds } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Monday request failed (${response.status}).`);
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error("Monday request failed: " + payload.errors.map((error) => error.message).join("; "));
    }
    const board = payload.data?.boards?.find((entry) => String(entry.id) === String(config.boardId));
    if (!board) throw new Error(`Monday board ${config.boardId} was not returned. Check the token's board access.`);
    if (!board.groups?.some((group) => group.id === config.groupId)) {
      throw new Error("The configured Current Members group was not returned by Monday.");
    }
    const available = new Set((board.columns || []).map((column) => column.id));
    if (columnIds.some((id) => !available.has(id))) throw new Error("A required member directory column is missing from Monday.");
    if (!Array.isArray(board.items_page?.items)) throw new Error("Monday did not return a member item page.");

    for (const item of board.items_page.items) items.set(String(item.id), item);
    cursor = board.items_page.cursor || null;
    if (cursor && cursors.has(cursor)) throw new Error("Monday returned a repeated pagination cursor.");
    if (cursor) cursors.add(cursor);
  } while (cursor);

  const members = [];
  for (const item of items.values()) {
    if (item.group?.id !== config.groupId) continue;
    const values = Object.fromEntries((item.column_values || []).map((value) => [value.id, value]));
    const name = item.name?.trim();
    const nameOnly = config.nameOnlyMembers.has(name?.toLowerCase());
    const approved = values[config.approvalColumnId]?.text?.trim().toLowerCase() === "yes";
    if (!approved && !nameOnly) continue;
    if (!name) throw new Error("A current Monday member has no name.");
    const tier = values[config.tierColumnId]?.text?.trim();
    if (!["Premier", "General", "Associate"].includes(tier)) throw new Error(`Invalid membership tier for ${name}.`);

    const asset = nameOnly ? null : (values[config.logoColumnId]?.files || [])
      .map((file) => file.asset).find((entry) => entry && supportedExtensions.has(entry.file_extension?.toLowerCase()));
    const attachment = asset ? {
      id: String(asset.id), filename: asset.name, size: asset.file_size,
      type: mimeTypes[asset.file_extension.toLowerCase()], url: asset.public_url
    } : null;
    if (asset && !asset.public_url) throw new Error(`Monday did not return a downloadable logo for ${name}.`);
    const logoPath = attachment ? await storeLogo(attachment, name, String(item.id)) : "";
    members.push({ name, tier, website: normalizeWebsite(values[config.websiteColumnId]?.text), description: "", logoPath });
  }
  if (!members.length) throw new Error("Monday returned no publishable current members; keeping the deployed directory unchanged.");
  return members;
}

export function normalizeWebsite(value) {
  const text = value?.trim();
  if (!text || /\s|@/.test(text)) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}
