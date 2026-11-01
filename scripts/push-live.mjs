// Pushes the freshest scores to Firebase so the site can update by itself,
// without waiting for a file commit and a Pages rebuild.
//
// Reads data/yahoo-league.json and data/yahoo-lineups.json (written just
// before by fetch-yahoo-league.mjs) and writes ONE small document,
// live/scores, with: the league info, standings, this week's scores and this
// week's lineups, as a JSON string in the field "json". Nothing else in
// Firebase is touched -- in particular never the site/leagueData document.
//
// Needs the repository secret FIREBASE_SERVICE_ACCOUNT (the whole key file).
// Skips quietly when the data has not changed since the last push.
//
//   DRY_RUN=true   build the document and print its size, but do not write

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const STATE_FILE = process.env.LIVE_STATE_FILE || ".live-state";
const LEAGUE_FILE = process.env.OUT_FILE || "data/yahoo-league.json";
const LINEUPS_FILE = LEAGUE_FILE.replace(/[^/\\]*$/, "yahoo-lineups.json");

function build() {
  const league = JSON.parse(readFileSync(LEAGUE_FILE, "utf8"));
  const cur = String(league.league && league.league.current_week);
  let lineups = {};
  try {
    const l = JSON.parse(readFileSync(LINEUPS_FILE, "utf8"));
    if (l.lineups && l.lineups[cur]) lineups[cur] = l.lineups[cur];
  } catch { /* lineups are optional */ }
  if (!league.scores || !league.scores[cur]) throw new Error("No scores for week " + cur + " in " + LEAGUE_FILE);
  return {
    updated: league.updated,
    league: league.league,
    standings: league.standings,
    scores: { [cur]: league.scores[cur] },
    lineups
  };
}

async function main() {
  const doc = build();
  const json = JSON.stringify(doc);
  let last = "";
  try { if (existsSync(STATE_FILE)) last = readFileSync(STATE_FILE, "utf8").trim(); } catch { /* ignore */ }
  if (last === String(doc.updated)) { console.log("Firebase already has this update."); return; }
  if (json.length > 900000) throw new Error("Live document too large (" + json.length + " bytes).");
  if (DRY_RUN) { console.log("DRY_RUN: would write live/scores (" + json.length + " bytes, updated " + doc.updated + ")."); return; }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log("FIREBASE_SERVICE_ACCOUNT is not set; skipping the Firebase push."); return; }
  let key;
  try { key = JSON.parse(raw); } catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); }

  const require = createRequire(import.meta.url);
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(key) });
  await admin.firestore().collection("live").doc("scores").set({ updated: String(doc.updated), json });
  writeFileSync(STATE_FILE, String(doc.updated) + "\n", "utf8");
  console.log("Pushed live/scores to " + key.project_id + " (" + json.length + " bytes, updated " + doc.updated + ").");
}

main().then(() => process.exit(0)).catch(err => { console.error("Firebase push failed: " + (err && err.message ? err.message : err)); process.exit(1); });
