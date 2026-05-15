# Members Directory Setup

This repo now includes a static members directory page at [members.html](/Users/hal/Documents/member/members.html) plus a build script that refreshes its data from Airtable.

## What the build does

1. Calls Airtable's Web API for your member table.
2. Reads the member name, tier, logo, website, description, and optional logo approval fields.
3. Downloads each approved Airtable logo into `members-assets/`.
4. Regenerates [members-data.js](/Users/hal/Documents/member/members-data.js), which powers the page.

Downloading the images is important because Airtable attachment download links expire after a short time.

## Files added

- [members.html](/Users/hal/Documents/member/members.html): rendered page
- [members-data.js](/Users/hal/Documents/member/members-data.js): generated member data used by the page
- [scripts/build-members.mjs](/Users/hal/Documents/member/scripts/build-members.mjs): Airtable fetch + asset download script
- [scripts/refresh-members.sh](/Users/hal/Documents/member/scripts/refresh-members.sh): small wrapper for cron
- [.env.members.example](/Users/hal/Documents/member/.env.members.example): config template

## Airtable setup

Use the Airtable Web API, not the public shared-view URL directly.

The shared link you gave uses base ID `apptcH0H3OgfKEZzP`, but the script also needs:

- A personal access token with read access to the base
- The table name or table ID
- Optionally the view name if you only want one filtered view

Recommended Airtable fields:

- `Member Name`
- `Type`
- `Logo`
- `On Website`
- `PR/Logo Usage`
- `Website`
- `Address`

Create your local config file:

```bash
cp .env.members.example .env.members
```

Then edit `.env.members` and set:

```env
AIRTABLE_TOKEN=pat_your_token_here
AIRTABLE_BASE_ID=apptcH0H3OgfKEZzP
AIRTABLE_TABLE_ID=tblhhsanKJmjJtXbE
AIRTABLE_VIEW=viwYufMoBg9Km6dQl
AIRTABLE_NAME_FIELD=Member Name
AIRTABLE_TIER_FIELD=Type
AIRTABLE_LOGO_FIELD=Logo
AIRTABLE_LOGO_APPROVED_FIELD=PR/Logo Usage
AIRTABLE_APPROVED_VALUES=approved,approve,yes,true,1
AIRTABLE_WEBSITE_ENABLED_FIELD=On Website
AIRTABLE_WEBSITE_ENABLED_VALUES=true,yes,1,checked,on
AIRTABLE_URL_FIELD=Website
AIRTABLE_DESCRIPTION_FIELD=Address
```

The script now assumes:

- only rows with `On Website` checked should appear
- only rows with `PR/Logo Usage` matching an approved value should show and download logos

If your `PR/Logo Usage` select uses a different value than `approved` or `yes`, update `AIRTABLE_APPROVED_VALUES`.

## Running it

Test the page with sample content:

```bash
node scripts/build-members.mjs --sample
```

Run against Airtable:

```bash
node scripts/build-members.mjs
```

Open the page in a browser:

```bash
open members.html
```

## Weekly cron job

Make the wrapper executable once:

```bash
chmod +x scripts/refresh-members.sh
```

Open your crontab:

```bash
crontab -e
```

Example: refresh every Monday at 8:00 AM local time:

```cron
0 8 * * 1 /Users/hal/Documents/member/scripts/refresh-members.sh >> /Users/hal/Documents/member/members-refresh.log 2>&1
```

## Important note about the Airtable link

Your shared Airtable URL is useful for viewing the data, but it is not the stable integration target for a website build. The supported approach is:

1. Get Airtable base access or a token with access to the base.
2. Pull records through the Web API.
3. Download attachment files during each refresh.

If you want, the same logic can also be moved into Google Apps Script later, but the local cron version is the simplest and most reliable setup for this repo.
