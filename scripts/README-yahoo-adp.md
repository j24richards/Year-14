# Auto-refreshing the ADP pool from Yahoo

The draft grades on this site score every pick against `MOCK_DRAFT_POOL_RAW`
in `index.html`. A player's position in that list *is* their ADP rank, so if
the list goes stale the grades quietly skew. This setup refreshes it from
Yahoo automatically each preseason.

Setup is a one-time thing. After that it runs itself.

## One-time setup

**1. Create a Yahoo developer app**

Go to <https://developer.yahoo.com/apps/create/> and create an app:

- Application Name: anything (e.g. "Fantasy ADP refresh")
- Redirect URI: leave blank, or use `oob`
- API Permissions: check **Fantasy Sports**, with **Read** access

Yahoo gives you a **Client ID** and **Client Secret**. Keep them handy.

**2. Get a refresh token**

On your own computer, in a clone of this repo:

```
node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret>
```

It prints a URL. Open it, approve access, and Yahoo shows you a short code.
Then run it again with that code on the end:

```
node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret> <code>
```

It prints a refresh token. Codes expire fast, so if it complains, just start
the step over.

**3. Add three repository secrets**

In this repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add all three:

| Name | Value |
| --- | --- |
| `YAHOO_CLIENT_ID` | from step 1 |
| `YAHOO_CLIENT_SECRET` | from step 1 |
| `YAHOO_REFRESH_TOKEN` | from step 2 |

**4. Test it without touching anything**

Go to **Actions → Refresh ADP from Yahoo → Run workflow**, leave
"Report what would change without committing" checked, and run it. The log
shows how many players came back and what the new top five would be, but
writes nothing.

When that looks right, run it again with the box unchecked. It commits the
updated list, and GitHub Pages redeploys on its own.

## What it does on its own

It runs Mondays from June through September. That window is deliberate: once
your draft has happened, refreshing ADP would move the yardstick underneath
grades that are already published, and last season's grades would drift on
their own. Let it lapse after draft day — it starts again next June.

## Safety

The script refuses to write a list that looks wrong. If Yahoo returns too few
players, is missing a position entirely, or sends duplicates, it fails loudly
and leaves `index.html` exactly as it was. A bad write here would corrupt
every grade on the site, so failing is the correct outcome.

It also matches the file's existing conventions on purpose: team defenses are
stored by nickname only (`Seahawks`, not `Seattle Seahawks`) and team codes
are uppercase. Those have to match the draft results or every defense lookup
silently fails.

## If it stops working

Almost always the refresh token was revoked or rotated away. The log will say
`invalid_grant`. Redo step 2 and update the `YAHOO_REFRESH_TOKEN` secret;
nothing else needs changing.
