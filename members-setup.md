# Members Directory Setup

The directory is generated directly from the Monday Members board. Refreshes do not
call Airtable or use its token, table, attachments, or supplemental member records.

## Source and publication rules

- Board: `18418382784` — [Members](https://canton-foundation.monday.com/boards/18418382784).
- Group: `group_mm7qj8b3` — Current Members. Applicants and upload staging rows are excluded.
- Name: the item's canonical member name.
- Tier: Type (`color_mm891eb8`), which must be Premier, General, or Associate.
- Logo consent: PR/Logo Usage (`color_mm89z1pw`) must be Yes.
- Logo file: Logo (`file_mm4ebxv1`). Approved PNG, JPEG, SVG, WebP, GIF, and AVIF images are supported.
- Website: Website (`text_mm7wwmtm`). Invalid URLs and email addresses are not linked.

Visa Inc. and Lloyds Bank Plc retain the existing name-only publication exceptions:
their names appear and their logos are never downloaded or displayed. Other members
without logo consent are excluded. Approved members without supported images appear
under Members without logos.

The On Website checkbox tracks existing website coverage; it is not a publication
filter. A newly approved Current Member can appear without that box being checked.
DLA Piper is now read from its Monday item like every other member; no separate
supplement is used. Moving a member out of Current Members or withdrawing consent
removes it on the next successful refresh (apart from the two name-only exceptions).

Only names, tiers, websites, and approved logos are written to the public directory.
Contact details, agreements, invoices, and temporary signed download URLs are not
published. The script downloads approved images locally because Monday's public asset
URLs expire after one hour.

## Scheduled automation

`.github/workflows/deploy-members.yml` runs every Monday at 12:00 UTC, retaining the
existing schedule. It can also be started manually using Run workflow under Actions.
Each run tests the sync, reads every page of Monday items, downloads current approved
logos, regenerates `members-data.js`, versions the page's data URL, commits updates,
and deploys to GitHub Pages.

Add a GitHub Actions repository secret named `MONDAY_API_TOKEN` at
[repository secrets](https://github.com/hythloda/canton-members/settings/secrets/actions).
The token must have read access to the Members board and its logo assets. Never put
the token in source or public data. The old Airtable secret is no longer referenced.

Missing credentials, API errors, missing groups or columns, invalid tiers, empty
results, and failed downloads stop deployment so the last successful directory stays
live. There is no fallback to Airtable or to the previous DLA supplement.

## Local refresh and tests

Copy `.env.members.example` to the ignored `.env.members` file and enter the Monday
token there. The board, group, column IDs, API version, and name-only exceptions can be
overridden using the documented environment variables.

```bash
node --test scripts/*.test.mjs
node scripts/build-members.mjs
```

`node scripts/build-members.mjs --sample` builds the isolated sample dataset without
credentials or network access. `scripts/refresh-members.sh` remains a wrapper for a
local cron job. The GitHub workflow runs independently of that local setup.
