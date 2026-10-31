#!/usr/bin/env node
//
// Pulls league data (standings, weekly scores, transactions, rosters) from
// Yahoo Fantasy and writes it to data/yahoo-league.json.
//
// Uses the same Yahoo app and the same three secrets as refresh-adp.mjs, so
// no new approval or credentials are needed.
//
// Runs on plain Node 18+ with no dependencies.
//
// Required environment variables:
//   YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN
// Optional:
//   YAHOO_LEAGUE_ID  numeric league id (the number in your Yahoo league URL).
//                    If unset, the script lists your NFL leagues and stops.
//   WEEK             fetch just this one week (default: current week and the
//                    week before it, so finished scores get their final numbers)
//   DRY_RUN          "true" to report what would change without writing
//   OUT_FILE         output path (default ./data/yahoo-league.json)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const CLIENT_ID = process.env.YAHOO_CLIENT_ID;
const CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YAHOO_REFRESH_TOKEN;
const LEAGUE_ID = String(process.env.YAHOO_LEAGUE_ID || "").trim();
const WEEK = String(process.env.WEEK || "").trim();
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const OUT_FILE = process.env.OUT_FILE || "data/yahoo-league.json";
// Overridable only so the script can be tested against a local stand-in.
const API_BASE = process.env.YAHOO_API_BASE || "https://fantasysports.yahooapis.com/fantasy/v2/";
const TOKEN_URL = process.env.YAHOO_TOKEN_URL || "https://api.login.yahoo.com/oauth2/get_token";

function fail(message) {
  console.error("ERROR: " + message);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  fail("Missing YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET or YAHOO_REFRESH_TOKEN.");
}

// ---------------------------------------------------------------------------
// Auth + requests
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      redirect_uri: "oob"
    })
  });
  const text = await res.text();
  if (!res.ok) fail("Token refresh failed (" + res.status + "): " + text.slice(0, 400));
  return JSON.parse(text).access_token;
}

let TOKEN = "";

async function yahoo(path) {
  const url = API_BASE + path + (path.includes("?") ? "&" : "?") + "format=json";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN } });
    const text = await res.text();
    if (res.ok) {
      await new Promise(r => setTimeout(r, 150));
      return JSON.parse(text);
    }
    // 999 = Yahoo's rate limit; back off and retry. Anything else is real.
    if ((res.status === 999 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error("HTTP " + res.status + " for " + path + ": " + text.slice(0, 300));
  }
}

// ---------------------------------------------------------------------------
// Yahoo's JSON nests everything in mixed arrays and objects (and numbered
// keys like "0", "1", "count"). These helpers avoid indexing positionally.
// ---------------------------------------------------------------------------

// Collapse a subtree into one flat object of scalar values.
function flatten(node, out = {}) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach(item => flatten(item, out));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === "object") {
      if (key === "name" && typeof value.full === "string") out.name = value.full;
      else flatten(value, out);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Every value stored under `key` anywhere in the tree (not descending into a
// match, so nested duplicates are not double-counted).
function findAll(node, key, found = []) {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach(item => findAll(item, key, found));
    return found;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) found.push(v);
    else findAll(v, key, found);
  }
  return found;
}

const num = v => (v === undefined || v === null || v === "" ? null : Number(v));

// A Yahoo "team" is an array: [ [meta items...], {team_points}, {team_standings}, ... ]
function readTeam(arr) {
  const meta = {};
  let points = null, projected = null, standing = null;
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n === null || typeof n !== "object") return;
    if (n.team_points) { points = num(n.team_points.total); return; }
    if (n.team_projected_points) { projected = num(n.team_projected_points.total); return; }
    if (n.team_standings) { standing = n.team_standings; return; }
    if (n.managers || n.team_logos || n.roster_adds || n.clinched_playoffs !== undefined) {
      if (n.managers) {
        const m = findAll(n.managers, "nickname");
        meta.managers = m.filter(x => typeof x === "string");
      }
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (v !== null && typeof v === "object") walk(v);
      else meta[k] = v;
    }
  })(arr);
  const t = {
    team_key: meta.team_key || null,
    team_id: num(meta.team_id),
    name: meta.name || null,
    managers: meta.managers || []
  };
  if (points !== null) t.points = points;
  if (projected !== null) t.projected = projected;
  if (standing) {
    const o = standing.outcome_totals || {};
    t.rank = num(standing.rank);
    t.wins = num(o.wins);
    t.losses = num(o.losses);
    t.ties = num(o.ties);
    t.pct = o.percentage === undefined ? null : Number(o.percentage);
    t.points_for = num(standing.points_for);
    t.points_against = num(standing.points_against);
  }
  return t;
}

function readTeams(node) {
  return findAll(node, "team").filter(Array.isArray).map(readTeam).filter(t => t.team_key);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function listLeagues() {
  const data = await yahoo("users;use_login=1/games;game_keys=nfl/leagues");
  return findAll(data, "league")
    .filter(Array.isArray)
    .map(l => flatten(l))
    .filter(l => l.league_key)
    .map(l => ({
      league_key: l.league_key,
      league_id: String(l.league_id),
      name: l.name,
      season: l.season,
      num_teams: num(l.num_teams),
      current_week: num(l.current_week)
    }));
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

async function getLeagueMeta(key) {
  const data = await yahoo("league/" + key + "/settings");
  const league = findAll(data, "league").find(Array.isArray) || [];
  const meta = flatten(league[0] || league);
  return {
    id: String(meta.league_id || LEAGUE_ID),
    key,
    name: meta.name || null,
    season: meta.season || null,
    num_teams: num(meta.num_teams),
    scoring_type: meta.scoring_type || null,
    current_week: num(meta.current_week),
    start_week: num(meta.start_week),
    end_week: num(meta.end_week)
  };
}

async function getStandings(key) {
  return readTeams(await yahoo("league/" + key + "/standings"))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
}

async function getScoreboard(key, week) {
  const data = await yahoo("league/" + key + "/scoreboard;week=" + week);
  const matchups = findAll(data, "matchup").filter(m => m && typeof m === "object");
  return matchups.map(m => {
    const f = {};
    for (const k of ["week", "week_start", "week_end", "status", "is_playoffs", "is_consolation", "is_tied", "winner_team_key"]) {
      if (m[k] !== undefined) f[k] = m[k];
    }
    return {
      week: num(f.week) ?? Number(week),
      status: f.status || null,
      is_playoffs: f.is_playoffs === "1" || f.is_playoffs === 1,
      is_tied: f.is_tied === "1" || f.is_tied === 1,
      winner_team_key: f.winner_team_key || null,
      teams: readTeams(m)
    };
  }).filter(m => m.teams.length);
}

async function getTransactions(key) {
  const data = await yahoo("league/" + key + "/transactions;count=50");
  const out = [];
  for (const tx of findAll(data, "transaction").filter(Array.isArray)) {
    const meta = flatten(tx[0] || {});
    const players = [];
    for (const p of findAll(tx[1] || {}, "player").filter(Array.isArray)) {
      const info = flatten(p[0] || []);
      const dataBlock = flatten(findAll(p, "transaction_data")[0] || {});
      players.push({
        name: info.name || null,
        team: info.editorial_team_abbr || null,
        pos: String(info.display_position || "").split(",")[0] || null,
        action: dataBlock.type || null,
        from: dataBlock.source_team_key || dataBlock.source_type || null,
        to: dataBlock.destination_team_key || dataBlock.destination_type || null
      });
    }
    out.push({
      id: num(meta.transaction_id),
      type: meta.type || null,
      status: meta.status || null,
      timestamp: num(meta.timestamp),
      date: meta.timestamp ? new Date(Number(meta.timestamp) * 1000).toISOString() : null,
      players
    });
  }
  return out;
}

async function getRoster(teamKey) {
  const data = await yahoo("team/" + teamKey + "/roster/players");
  const rows = [];
  for (const p of findAll(data, "player").filter(Array.isArray)) {
    const info = flatten(p);
    if (!info.name) continue;
    rows.push({
      name: info.name,
      team: info.editorial_team_abbr || null,
      pos: String(info.display_position || "").split(",")[0] || null,
      slot: info.position || null
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------

function readExisting() {
  if (!existsSync(OUT_FILE)) return null;
  try { return JSON.parse(readFileSync(OUT_FILE, "utf8")); } catch { return null; }
}

async function main() {
  TOKEN = await getAccessToken();
  console.log("Authenticated with Yahoo.");

  if (!LEAGUE_ID) {
    const leagues = await listLeagues();
    console.log("YAHOO_LEAGUE_ID is not set. Your NFL leagues:");
    for (const l of leagues) {
      console.log("  id " + l.league_id + "  \"" + l.name + "\"  season " + l.season +
        "  teams " + l.num_teams + "  week " + l.current_week);
    }
    fail("Set the YAHOO_LEAGUE_ID repository variable (or the league_id input) to one of the ids above.");
  }

  const key = "nfl.l." + LEAGUE_ID;
  const league = await getLeagueMeta(key);
  console.log("League: " + league.name + " (season " + league.season + ", week " + league.current_week + ").");

  const standings = await getStandings(key);
  console.log("Standings: " + standings.length + " teams.");
  if (!standings.length) fail("No teams came back from standings. Leaving the file untouched.");

  const current = league.current_week || 1;
  const weeks = WEEK ? [Number(WEEK)] : (current > 1 ? [current - 1, current] : [current]);
  const prior = readExisting();
  const scores = (prior && prior.scores) || {};
  for (const w of weeks) {
    const matchups = await getScoreboard(key, w);
    if (matchups.length) scores[String(w)] = matchups;
    console.log("Week " + w + ": " + matchups.length + " matchups.");
  }

  const transactions = await getTransactions(key);
  console.log("Transactions: " + transactions.length + " recent.");

  const rosters = {};
  for (const t of standings) rosters[t.team_key] = await getRoster(t.team_key);
  console.log("Rosters: " + Object.keys(rosters).length + " teams, " +
    Object.values(rosters).reduce((n, r) => n + r.length, 0) + " players.");

  const result = {
    attribution: "Fantasy data provided by Yahoo Fantasy",
    updated: new Date().toISOString(),
    league,
    standings,
    scores,
    transactions,
    rosters
  };

  // Skip the write (and the commit) when only the timestamp would change.
  const strip = o => JSON.stringify({ ...o, updated: null });
  if (prior && strip(prior) === strip(result)) {
    console.log("Nothing changed since the last run.");
    return;
  }

  const top = standings.slice(0, 3).map(t => t.rank + ". " + t.name + " (" + t.wins + "-" + t.losses + ")");
  console.log("Top of standings: " + top.join(", "));

  if (DRY_RUN) {
    console.log("DRY_RUN set -- not writing " + OUT_FILE + ".");
    return;
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log("Wrote " + OUT_FILE + ".");
}

main().catch(err => fail(err && err.stack ? err.stack : String(err)));
