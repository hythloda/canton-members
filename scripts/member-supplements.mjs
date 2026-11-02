// Keep verified members from the current membership system in legacy Airtable builds.
export function mergeMemberSupplements(members, supplements) {
  let result = members.filter(Boolean);

  for (const supplement of supplements) {
    if (!supplement.name || !supplement.tier || supplement.logoApproved !== true || !supplement.source) {
      throw new Error("Supplemental members require a name, tier, approved logo usage, and source record.");
    }

    const names = new Set([supplement.name, ...(supplement.aliases || [])].map(normalizeName));
    result = result.filter((member) => !names.has(normalizeName(member.name)));
    result.push({
      name: supplement.name,
      tier: supplement.tier,
      website: supplement.website || "",
      description: supplement.description || "",
      logoPath: supplement.logoPath || ""
    });
  }

  return result;
}

function normalizeName(name) {
  return String(name).trim().toLowerCase();
}
