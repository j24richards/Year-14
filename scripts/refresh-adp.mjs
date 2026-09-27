#!/usr/bin/env node
//
// Refreshes MOCK_DRAFT_POOL_RAW inside index.html from Yahoo's current NFL
// average draft position data.
//
// The draft grades on this site are scored against that list -- a player's
// index in it IS their ADP rank -- so a stale list quietly skews every grade.
// This keeps it current without anyone hand-editing 200+ rows each August.
//
// Runs on plain Node 18+ with no dependencies.
//
// Required environment variables:
//   YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN
// Optional:
//   POOL_SIZE   how many players to keep (default 250)
//   DRY_RUN     "true" to report what would change without writing the file
//   TARGET_FILE path to index.html (default ./index.html)

import { readFileSync, writeFileSync } from "node:fs";

const CLIENT_ID = process.env.YAHOO_CLIENT_ID;
const CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YAHOO_REFRESH_TOKEN;
const POOL_SIZE = Number(process.env.POOL_SIZE || 250);
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const TARGET_FILE = process.env.TARGET_FILE || "index.html";

const KEEP_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function fail(message) {
  console.error("ERROR: " + message);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  fail("Missing YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET or YAHOO_REFRESH_TOKEN.");
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: REFRESH_TOKEN,
    redirect_uri: "oob"
  });
  const res = await fetch("https://api.login.yahoo.com/oauth2/get_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    // invalid_grant means the refresh token was revoked or rotated away --
    // the one-time authorization has to be redone, nothing else will fix it.
    fail("Token refresh failed (" + res.status + "): " + text.slice(0, 400));
  }
  const json = JSON.parse(text);
  if (json.refresh_token && json.refresh_token !== REFRESH_TOKEN) {
    console.warn(
      "NOTE: Yahoo issued a new refresh token. If a later run fails with " +
      "invalid_grant, update the YAHOO_REFRESH_TOKEN secret using " +
      "scripts/get-yahoo-refresh-token.mjs."
    );
  }
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Yahoo's JSON nests everything in mixed arrays and objects, and the exact
// shape shifts between resources. Rather than index into it positionally,
// collapse the whole subtree into one flat object and read the keys we want.
// ---------------------------------------------------------------------------

function flatten(node, out = {}) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach(item => flatten(item, out));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === "object") {
      if (key === "name" && typeof value.full === "string") {
        out.name = value;
      } else if (key === "draft_analysis") {
        Object.assign(out, flatten(value, {}));
      } else {
        flatten(value, out);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function fetchPage(token, start, sort) {
  const sortPart = sort ? ";sort=" + sort : "";
  const url =
    "https://fantasysports.yahooapis.com/fantasy/v2/game/nfl/players;" +
    "start=" + start + ";count=25" + sortPart +
    "/draft_analysis?format=json";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + ": " + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// Walks the parsed page and pulls out every player object it contains.
function extractPlayers(page) {
  const found = [];
  (function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.player) {
      const flat = flatten(node.player, {});
      if (flat.name && flat.name.full) found.push(flat);
      return;
    }
    Object.values(node).forEach(walk);
  })(page);
  return found;
}

// ---------------------------------------------------------------------------
// Shaping to match the file's existing conventions exactly: team defenses are
// stored by nickname only ("Seahawks", not "Seattle Seahawks") and team codes
// are uppercase. Getting this wrong silently breaks every defense lookup.
// ---------------------------------------------------------------------------

function toPoolRow(p) {
  const position = String(p.display_position || "").split(",")[0].trim().toUpperCase();
  if (!KEEP_POSITIONS.has(position)) return null;

  const team = String(p.editorial_team_abbr || "").trim().toUpperCase();
  let name = String(p.name.full || "").trim();
  if (position === "DEF") {
    const parts = name.split(/\s+/);
    name = parts[parts.length - 1];
  }
  if (!name || !team) return null;

  const averagePick = Number(p.average_pick);
  if (!isFinite(averagePick) || averagePick <= 0) return null;

  return { row: [name, team, position], averagePick };
}

// ---------------------------------------------------------------------------

async function collectPlayers(token) {
  // sort=AR asks Yahoo for players in draft-relevance order so the first few
  // hundred are the ones that actually matter. If that sort key is rejected,
  // fall back to the unsorted collection -- the final ordering comes from
  // average_pick below either way.
  let sort = process.env.YAHOO_SORT || "AR";
  const collected = new Map();
  let start = 0;

  while (collected.size < POOL_SIZE * 2 && start < 1000) {
    let page;
    try {
      page = await fetchPage(token, start, sort);
    } catch (err) {
      if (sort && start === 0) {
        console.warn("Sort '" + sort + "' rejected (" + err.message + "); retrying unsorted.");
        sort = "";
        continue;
      }
      throw err;
    }
    const players = extractPlayers(page);
    if (!players.length) break;
    for (const p of players) {
      const shaped = toPoolRow(p);
      if (!shaped) continue;
      const key = shaped.row[0] + "|" + shaped.row[2];
      if (!collected.has(key)) collected.set(key, shaped);
    }
    start += 25;
    await new Promise(r => setTimeout(r, 120));
  }

  return [...collected.values()]
    .sort((a, b) => a.averagePick - b.averagePick)
    .slice(0, POOL_SIZE)
    .map(p => p.row);
}

// Refuses to write a pool that looks broken. A bad write here would corrupt
// every draft grade on the site, so it is better to fail loudly and leave the
// existing list alone.
function sanityCheck(rows) {
  if (rows.length < 150) {
    fail("Only got " + rows.length + " usable players; expected at least 150. Leaving the file untouched.");
  }
  const positions = new Set(rows.map(r => r[2]));
  for (const needed of KEEP_POSITIONS) {
    if (!positions.has(needed)) {
      fail("No " + needed + " players came back. Leaving the file untouched.");
    }
  }
  const names = new Set(rows.map(r => r[0]));
  if (names.size !== rows.length) {
    fail("Duplicate player names in the result. Leaving the file untouched.");
  }
}

function formatPool(rows) {
  return "const MOCK_DRAFT_POOL_RAW = [\n" +
    rows.map(r => JSON.stringify(r)).join(",\n") +
    "\n];";
}

async function main() {
  const token = await getAccessToken();
  console.log("Authenticated with Yahoo.");

  const rows = await collectPlayers(token);
  console.log("Collected " + rows.length + " players.");
  sanityCheck(rows);

  const src = readFileSync(TARGET_FILE, "utf8");
  const pattern = /const MOCK_DRAFT_POOL_RAW = \[[\s\S]*?\];/;
  const existing = src.match(pattern);
  if (!existing) fail("Could not find MOCK_DRAFT_POOL_RAW in " + TARGET_FILE + ".");

  const replacement = formatPool(rows);
  if (existing[0] === replacement) {
    console.log("ADP list already current -- nothing to do.");
    return;
  }

  const oldCount = (existing[0].match(/\[/g) || []).length - 1;
  console.log("Top 5 now: " + rows.slice(0, 5).map(r => r[0]).join(", "));
  console.log("Pool size " + oldCount + " -> " + rows.length + ".");

  if (DRY_RUN) {
    console.log("DRY_RUN set -- not writing the file.");
    return;
  }

  writeFileSync(TARGET_FILE, src.replace(pattern, replacement), "utf8");
  console.log("Updated " + TARGET_FILE + ".");
}

main().catch(err => fail(err && err.stack ? err.stack : String(err)));
