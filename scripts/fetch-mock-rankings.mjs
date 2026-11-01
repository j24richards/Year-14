// Pulls Fantasy Football Calculator's free ADP feed into data/mock-rankings.json
// so the Mock Draft can offer it as an alternate ranking.
// FFC asks for attribution and for the API not to be called too often; this
// runs about once a week. Other ranking sets already in the file are kept.
import fs from "node:fs";

const SCORING = process.env.FFC_SCORING || "half-ppr"; // standard | ppr | half-ppr
const TEAMS = process.env.FFC_TEAMS || "10";
const YEAR = process.env.FFC_YEAR || String(new Date().getUTCFullYear());
const DRY = String(process.env.DRY_RUN || "false") === "true";
const FILE = "data/mock-rankings.json";

const url = `https://fantasyfootballcalculator.com/api/v1/adp/${SCORING}?teams=${TEAMS}&year=${YEAR}`;
console.log("GET", url);
const res = await fetch(url, { headers: { "User-Agent": "league-site-mock-draft (personal, weekly)", Accept: "application/json" } });
if (!res.ok) { console.error("FFC replied", res.status); process.exit(1); }
const body = await res.json();
const list = Array.isArray(body.players) ? body.players : [];
console.log("status:", body.status, "players:", list.length, "meta:", JSON.stringify(body.meta || {}).slice(0, 300));
if (list.length < 30) { console.error("Too few players returned; leaving the file alone."); process.exit(1); }
if (list.length < 150) console.log("Note: FFC only returns players drafted in its recent window, so this is a partial list; everyone else keeps his Yahoo spot on the site.");
if (list[0]) console.log("sample:", JSON.stringify(list[0]));

const players = list
  .filter(p => p && p.name && p.adp != null)
  .sort((a, b) => Number(a.adp) - Number(b.adp))
  .map(p => [String(p.name), p.position === "PK" ? "K" : String(p.position), String(p.team || ""), Number(p.adp)]);

let out = {};
try { out = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { out = {}; }
out.sets = out.sets || {};
const label = SCORING === "ppr" ? "Fantasy Football Calculator (PPR)" : SCORING === "half-ppr" ? "Fantasy Football Calculator (Half-PPR)" : "Fantasy Football Calculator (Standard)";
const m = body.meta || {};
out.sets.ffc = {
  label,
  note: `Mock-draft ADP from fantasyfootballcalculator.com, ${TEAMS}-team ${SCORING}, ${YEAR}` + (m.total_drafts ? ` (${m.total_drafts} drafts, ${m.start_date || ""} to ${m.end_date || ""})` : "") + `. ${players.length} players ranked` + (players.length < 150 ? "; everyone else keeps his Yahoo spot." : "."),
  source: "https://fantasyfootballcalculator.com/adp/" + SCORING + "/" + TEAMS + "-team/all",
  fetched: new Date().toISOString().slice(0, 10),
  players
};
const text = JSON.stringify(out) + "\n";
if (DRY) { console.log("Dry run: would write", players.length, "players,", text.length, "bytes"); process.exit(0); }
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(FILE, text);
console.log("Wrote", FILE, players.length, "players");
