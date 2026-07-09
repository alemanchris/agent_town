// wake_cycle.js
// Runs on a schedule (see .github/workflows/wake.yml). Free, no server needed.
// - Ages every agent
// - Kills agents past their lifespan, births a blank-memory replacement
// - Asks Groq (free tier) for a short "what happened since last wake" digest per agent
// - Writes everything back to data/agents.json (committed by the workflow)

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "agents.json");
const SEED_PATH = path.join(__dirname, "..", "data", "agents-seed.json");
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const LIFESPAN_DAYS = 56; // ~2 months
const DAYS_PER_WAKE = 2; // town wakes ~3x/week

const STAGES = [
  { name: "kid", max: 7 },
  { name: "teen", max: 14 },
  { name: "young_adult", max: 28 },
  { name: "full_adult", max: 42 },
  { name: "senior", max: 49 },
  { name: "elder", max: LIFESPAN_DAYS },
];

function stageFor(ageDays) {
  for (const s of STAGES) if (ageDays <= s.max) return s.name;
  return "elder";
}

function loadState() {
  if (fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  return JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
}

function pickReplacementName(pool, lang, takenNames) {
  const options = pool[lang].filter((n) => !takenNames.has(n));
  const list = options.length ? options : pool[lang];
  return list[Math.floor(Math.random() * list.length)];
}

async function askGroq(system, user) {
  if (!GROQ_KEY) {
    return "(no GROQ_API_KEY set — skipped digest generation)";
  }
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        temperature: 0.9,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "(quiet couple of days.)";
  } catch (e) {
    console.error("Groq call failed:", e.message);
    return "(quiet couple of days.)";
  }
}

async function main() {
  const state = loadState();
  state.simDay = (state.simDay || 0) + DAYS_PER_WAKE;
  state.lastWake = new Date().toISOString();

  const takenNames = new Set(state.agents.map((a) => a.name));
  const survivors = [];
  const deaths = [];

  for (const agent of state.agents) {
    agent.ageDays += DAYS_PER_WAKE;
    if (agent.ageDays >= LIFESPAN_DAYS) {
      deaths.push(agent);
      continue;
    }
    agent.stage = stageFor(agent.ageDays);
    survivors.push(agent);
  }

  // Births: one blank-memory replacement per death, same language, new random name
  const births = deaths.map((dead) => {
    takenNames.delete(dead.name);
    const name = pickReplacementName(state.namePool, dead.lang, takenNames);
    takenNames.add(name);
    return {
      id: `${dead.lang}-${name.toLowerCase().replace(/\s+/g, "")}-${Date.now().toString(36)}`,
      name,
      lang: dead.lang,
      ageDays: 0,
      stage: "kid",
      home: dead.home, // inherits the household
      job: null,
      personality: "a blank slate — still discovering who they are",
      memoryDigest: `Born into the town. Learning to speak and explore, one day at a time.`,
      relationships: {},
    };
  });

  state.agents = [...survivors, ...births];

  // Generate a fresh digest for every living agent — this is the only LLM
  // call per agent per wake, keeping token usage small and predictable.
  for (const agent of state.agents) {
    if (agent.ageDays === 0) continue; // newborns get no digest yet
    const others = state.agents.filter((a) => a.id !== agent.id).map((a) => `${a.name} (${a.stage})`).join(", ");
    const system = `You are quietly narrating the recent life of ${agent.name}, a ${agent.stage} in a small town, for a background journal entry. Personality: ${agent.personality}. Write 2-3 short sentences, warm and specific, in ENGLISH (this is an internal memory log, not dialogue). You may reference other townsfolk by name. Keep it grounded and small-scale — daily life, not drama.`;
    const user = `Previous memory: ${agent.memoryDigest || "(no memories yet)"}\nOther townsfolk: ${others}\nWrite what has happened in ${agent.name}'s life over the last few days.`;
    const digest = await askGroq(system, user);
    agent.memoryDigest = digest;
  }

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));

  console.log(`Wake cycle complete. simDay=${state.simDay}. Deaths: ${deaths.map(d=>d.name).join(", ") || "none"}. Births: ${births.map(b=>b.name).join(", ") || "none"}.`);
}

main();
