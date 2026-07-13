/*
 * Agent Town lifecycle v2
 *
 * Fully online GitHub Actions wake cycle:
 *   1) one town-context Groq call
 *   2) one Groq call per living agent
 *   3) one final town-reconciliation Groq call
 *
 * Output: lifecycle_v2/data/agents-v2.json
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "data", "agents-v2.json");
const SEED_PATH = path.join(ROOT, "data", "agents-seed-v2.json");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const AGENT_MODEL = process.env.GROQ_AGENT_MODEL || "llama-3.3-70b-versatile";
const TOWN_MODEL = process.env.GROQ_TOWN_MODEL || "llama-3.3-70b-versatile";

const DAYS_PER_WAKE = 2;
const LIFESPAN_DAYS = 56;
// No artificial delays needed — free tier allows 30 req/min, we use 18 per wake

const STAGES = [
  { name: "kid", max: 7 },
  { name: "teen", max: 14 },
  { name: "young_adult", max: 28 },
  { name: "full_adult", max: 42 },
  { name: "senior", max: 49 },
  { name: "elder", max: LIFESPAN_DAYS },
];

const VALID_LOCATIONS = [
  "home", "academy", "garden", "park", "market", "workshop", "cafe",
  "town_square", "clinic", "cathedral", "funeral_ground", "road"
];

// No delays between normal calls — we're well under Groq's 30 req/min free tier.
// sleep() is kept only for the retry backoff on genuine 429/5xx responses.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function stageFor(ageDays) {
  for (const stage of STAGES) {
    if (ageDays <= stage.max) return stage.name;
  }
  return "elder";
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadState() {
  const source = fs.existsSync(DATA_PATH) ? DATA_PATH : SEED_PATH;
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function ensureAgent(agent) {
  agent.id = agent.id || slugify(agent.name);
  agent.ageDays = Number(agent.ageDays || 0);
  agent.stage = stageFor(agent.ageDays);
  agent.home = agent.home || `home_${agent.id}`;
  agent.job = agent.job ?? null;
  agent.personality = agent.personality || "still discovering who they are";
  agent.memoryDigest = agent.memoryDigest || "";
  agent.aspirations = Array.isArray(agent.aspirations) ? agent.aspirations : [];
  agent.gossip = Array.isArray(agent.gossip) ? agent.gossip : [];
  agent.relationships = agent.relationships && typeof agent.relationships === "object"
    ? agent.relationships : {};
  agent.lifeHistory = Array.isArray(agent.lifeHistory) ? agent.lifeHistory : [];
  agent.today = agent.today && typeof agent.today === "object" ? agent.today : {};
  return agent;
}

function pickReplacementName(state, lang, takenNames) {
  const pool = Array.isArray(state.namePool?.[lang]) ? state.namePool[lang] : [];
  const unused = pool.filter((name) => !takenNames.has(name));
  const options = unused.length ? unused : pool;
  if (!options.length) return lang === "hi" ? "New Child" : "Nuovo Bambino";
  return options[Math.floor(Math.random() * options.length)];
}

function createBirth(dead, state, takenNames) {
  takenNames.delete(dead.name);
  const name = pickReplacementName(state, dead.lang, takenNames);
  takenNames.add(name);
  return ensureAgent({
    id: `${dead.lang}-${slugify(name)}-${Date.now().toString(36)}`,
    name,
    lang: dead.lang,
    ageDays: 0,
    stage: "kid",
    home: dead.home,
    job: null,
    personality: "a blank slate — still discovering who they are",
    memoryDigest: `Born into the town after ${dead.name}'s death.`,
    aspirations: [],
    gossip: [],
    relationships: {},
    lifeHistory: [{ simDay: state.simDay, type: "birth", summary: `Born into ${dead.home}.` }],
    today: { locked: false, schedule: [] },
  });
}

function compactAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    lang: agent.lang,
    ageDays: agent.ageDays,
    stage: agent.stage,
    home: agent.home,
    job: agent.job,
    personality: agent.personality,
    memoryDigest: agent.memoryDigest,
    aspirations: agent.aspirations,
    gossip: agent.gossip.slice(-5),
    relationships: agent.relationships,
  };
}

function stripCodeFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJson(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first < 0 || last <= first) throw new Error("No JSON object in model response");
    return JSON.parse(cleaned.slice(first, last + 1));
  }
}

async function askGroqJson({
  model,
  system,
  user,
  maxTokens,
  temperature,
  maxAttempts = 4,
}) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY is not configured");

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      const raw = await response.text();

      if (!response.ok) {
        const error = new Error(
          `Groq HTTP ${response.status}: ${raw.slice(0, 500)}`
        );

        if (response.status === 429 || response.status >= 500) {
          const retryAfterHeader = Number(
            response.headers.get("retry-after") || 0
          );

          const retryMatch = raw.match(
            /try again in\s+([0-9.]+)\s*(ms|s)?/i
          );

          let retryMs = retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : 0;

          if (retryMatch) {
            const amount = Number(retryMatch[1]);
            retryMs = retryMatch[2]?.toLowerCase() === "ms"
              ? amount
              : amount * 1000;
          }

          retryMs = Math.max(retryMs, 5000 * attempt);

          console.warn(
            `Groq retry ${attempt}/${maxAttempts} after ${Math.ceil(retryMs)} ms`
          );

          lastError = error;
          await sleep(retryMs);
          continue;
        }

        throw error;
      }

      const data = JSON.parse(raw);
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("Groq returned empty content");
      }

      return extractJson(content);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts) {
        break;
      }

      const retryMs = 3000 * attempt;
      console.warn(
        `Groq response retry ${attempt}/${maxAttempts}: ${error.message}`
      );
      await sleep(retryMs);
    }
  }

  throw lastError || new Error("Groq request failed");
}

function fallbackSchedule(agent) {
  const dutyLocation = agent.job || (agent.stage === "kid" || agent.stage === "teen" ? "academy" : "town_square");
  const duty = dutyLocation === "academy" ? "Attending classes" : agent.job ? "Working" : "Spending time in town";
  return [
    { start: "06:30", end: "08:00", location: "home", activity: "Morning routine and breakfast", status: "planned", eventId: null },
    { start: "08:00", end: "12:00", location: dutyLocation, activity: duty, status: "planned", eventId: null },
    { start: "12:00", end: "13:00", location: "market", activity: "Lunch", status: "planned", eventId: null },
    { start: "13:00", end: "17:00", location: dutyLocation, activity: duty, status: "planned", eventId: null },
    { start: "17:00", end: "19:00", location: "town_square", activity: "Free time", status: "planned", eventId: null },
    { start: "19:00", end: "23:00", location: "home", activity: "Dinner and evening at home", status: "planned", eventId: null },
  ];
}

function normalizeSchedule(agent, schedule) {
  if (!Array.isArray(schedule) || schedule.length < 4) return fallbackSchedule(agent);
  return schedule
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 10)
    .map((entry) => ({
      start: String(entry.start || "08:00"),
      end: String(entry.end || "09:00"),
      location: VALID_LOCATIONS.includes(entry.location) ? entry.location : "town_square",
      activity: String(entry.activity || "Continuing the day").slice(0, 180),
      status: ["planned", "changed", "skipped", "emergency"].includes(entry.status)
        ? entry.status : "planned",
      eventId: entry.eventId ? String(entry.eventId) : null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function initialTownCall(state) {
  const system = `You plan shared circumstances for a persistent small-town life simulation before residents decide their individual days.
Return JSON only with: {"townMood":"...","sharedEvents":[{"id":"...","type":"...","summary":"...","participants":["agent_id"],"affectedAgents":["agent_id"],"location":"...","importance":1}],"publicRumors":[{"id":"...","text":"...","sourceAgentId":null,"aboutAgentIds":["agent_id"],"truthStatus":"true|false|mixed|unknown"}]}.
Most days should be ordinary. Use zero to three meaningful shared events. Events may include birthdays, illness, forgotten obligations, work or school disruptions, visitors, arguments, celebrations, emergencies, or funerals caused by deterministic deaths already supplied in the input. Keep all shared events coherent. Use only supplied agent IDs and these locations: ${VALID_LOCATIONS.join(", ")}.`;

  const user = JSON.stringify({
    simDay: state.simDay,
    deterministicDeaths: state.lastDeaths || [],
    deterministicBirths: state.lastBirths || [],
    agents: state.agents.map(compactAgent),
  });

  try {
    const result = await askGroqJson({ model: TOWN_MODEL, system, user, maxTokens: 400, temperature: 0.85 });
    return {
      townMood: String(result.townMood || "an ordinary day"),
      sharedEvents: Array.isArray(result.sharedEvents) ? result.sharedEvents : [],
      publicRumors: Array.isArray(result.publicRumors) ? result.publicRumors : [],
    };
  } catch (error) {
    console.error("Initial town call failed:", error.message);
    return { townMood: "an ordinary day", sharedEvents: [], publicRumors: [] };
  }
}

async function individualAgentCall(agent, state, townContext) {
  // Flat parallel arrays of short plain strings — this is the safe structure.
  // Nested arrays-of-arrays with long free text inside them is what caused the
  // truncation bugs; a flat array of short strings gives the model nothing
  // complicated to lose track of, while still letting it write real,
  // personality-specific content instead of a hardcoded lookup table.
  const system = `You are simulating a village resident for one day. Reply with ONLY a JSON object, no explanation:
{"m":"mood (2-4 words)","d":"day summary (1 sentence)","mem":"new memory (1 sentence)","a":"current aspiration (1 short sentence)","g":"gossip sentence or empty string","locs":["loc1","loc2","loc3","loc4"],"acts":["activity 1 (3-6 words)","activity 2","activity 3","activity 4"]}
locs = exactly 4 locations in order through the day, each one of: ${VALID_LOCATIONS.join(",")}.
acts = exactly 4 short activity descriptions, one per location, in character with this resident's personality. Keep each field short — do not write paragraphs.`;

  const user = JSON.stringify({
    day: state.simDay,
    name: agent.name,
    stage: agent.stage,
    job: agent.job || "none",
    personality: String(agent.personality || "").slice(0, 80),
    memory: String(agent.memoryDigest || "").slice(-150),
    aspiration: agent.aspirations?.[0] || "",
    townMood: String(townContext.townMood || "").slice(0, 40),
    event: (townContext.sharedEvents || [])[0]?.summary?.slice(0, 60) || "",
  });

  try {
    const result = await askGroqJson({
      model: AGENT_MODEL,
      system,
      user,
      maxTokens: 320,
      temperature: 0.85,
    });

    const locs = Array.isArray(result.locs) ? result.locs.slice(0, 4) : [];
    const acts = Array.isArray(result.acts) ? result.acts.slice(0, 4) : [];
    const times = [["06:00","09:00"],["09:00","13:00"],["13:00","18:00"],["18:00","23:00"]];
    const compactSchedule = locs.map((loc, i) => ({
      start: times[i]?.[0] || "08:00",
      end: times[i]?.[1] || "12:00",
      location: VALID_LOCATIONS.includes(String(loc)) ? String(loc) : "town_square",
      activity: String(acts[i] || "Going about the day").slice(0, 60),
      status: "planned",
      eventId: null,
    }));

    const gossip = String(result.g || "").trim();
    const aspiration = String(result.a || "").trim();

    return {
      mood: String(result.m || "neutral").slice(0, 40),
      daySummary: String(result.d || "An ordinary day.").slice(0, 200),
      memoryDigest: String(result.mem || agent.memoryDigest).slice(0, 300),
      aspirations: aspiration ? [aspiration.slice(0, 150)] : agent.aspirations.slice(0, 1),
      privateDevelopments: [],
      gossipToShare: gossip ? [{ text: gossip.slice(0, 150), aboutAgentIds: [], confidence: 0.5 }] : [],
      relationshipIntentions: [],
      schedule: compactSchedule.length ? normalizeSchedule(agent, compactSchedule) : fallbackSchedule(agent),
    };
  } catch (error) {
    console.error(`Agent call failed for ${agent.name}:`, error.message);
    return {
      mood: "neutral",
      daySummary: "A quiet and ordinary day.",
      memoryDigest: agent.memoryDigest,
      aspirations: agent.aspirations,
      privateDevelopments: [],
      gossipToShare: [],
      relationshipIntentions: [],
      schedule: fallbackSchedule(agent),
    };
  }
}

function applyRelationshipIntentions(agent, intentions, knownIds, simDay) {
  for (const intent of intentions) {
    const targetId = String(intent.targetAgentId || "");
    if (!knownIds.has(targetId) || targetId === agent.id) continue;
    const rel = agent.relationships[targetId] || {
      status: "acquaintance", closeness: 50, trust: 50, tension: 0, attraction: 0,
    };
    rel.closeness = clamp((rel.closeness ?? 50) + Number(intent.closenessDelta || 0), 0, 100);
    rel.trust = clamp((rel.trust ?? 50) + Number(intent.trustDelta || 0), 0, 100);
    rel.tension = clamp((rel.tension ?? 0) + Number(intent.tensionDelta || 0), 0, 100);
    rel.attraction = clamp((rel.attraction ?? 0) + Number(intent.attractionDelta || 0), 0, 100);
    rel.lastChangeReason = String(intent.reason || "ordinary interaction");
    rel.lastChangedSimDay = simDay;
    agent.relationships[targetId] = rel;
  }
}

async function finalTownCall(state, townContext) {
  const system = `You reconcile a town's shared events with agent schedules. Some agents must attend funerals, births, or celebrations.
Return ONLY this JSON, no extra text:
{"townSummary":"1-2 sentences","patches":[{"id":"agent_id","loc":"location"}]}
Only include patches for agents who MUST change location due to a shared event. Use only these locations: ${VALID_LOCATIONS.join(", ")}.`;

  const user = JSON.stringify({
    simDay: state.simDay,
    townMood: townContext.townMood,
    events: (townContext.sharedEvents || []).map((e) => ({
      type: e.type,
      summary: e.summary,
      location: e.location,
      mustAttend: e.affectedAgents || [],
    })),
    agents: state.agents.map((a) => ({
      id: a.id,
      name: a.name,
      mood: a.today?.mood || "neutral",
    })),
  });

  try {
    const result = await askGroqJson({ model: TOWN_MODEL, system, user, maxTokens: 200, temperature: 0.5 });
    return result;
  } catch (error) {
    console.error("Final town call failed:", error.message);
    return { townSummary: "The town completed another ordinary wake cycle.", patches: [] };
  }
}

function applyFinalTownResult(state, result) {
  // Apply location patches for shared events (funerals, births, celebrations)
  // The model only returns {id, loc} — we inject that as the agent's first schedule slot
  const byId = new Map(state.agents.map((a) => [a.id, a]));
  for (const patch of Array.isArray(result.patches) ? result.patches : []) {
    const agent = byId.get(String(patch.id || ""));
    if (!agent || !patch.loc) continue;
    if (!VALID_LOCATIONS.includes(patch.loc)) continue;
    // Override the first schedule slot to the event location
    if (agent.today?.schedule?.length) {
      agent.today.schedule[0].location = patch.loc;
      agent.today.schedule[0].activity = "Attending a town event";
      agent.today.reconciled = true;
    }
  }

  state.today = {
    simDay: state.simDay,
    generatedAt: state.lastWake,
    locked: true,
    townMood: state.today?.townMood || "",
    townSummary: String(result.townSummary || "The town completed another wake."),
    sharedEvents: state.today?.sharedEvents || [],
    publicRumors: state.today?.publicRumors || [],
  };
}

async function main() {
  const state = loadState();
  state.schemaVersion = 2;
  state.simDay = Number(state.simDay || 0) + DAYS_PER_WAKE;
  state.lastWake = new Date().toISOString();
  state.agents = (Array.isArray(state.agents) ? state.agents : []).map(ensureAgent);

  const takenNames = new Set(state.agents.map((a) => a.name));
  const survivors = [];
  const deaths = [];

  for (const agent of state.agents) {
    agent.ageDays += DAYS_PER_WAKE;
    if (agent.ageDays >= LIFESPAN_DAYS) deaths.push(agent);
    else {
      agent.stage = stageFor(agent.ageDays);
      survivors.push(agent);
    }
  }

  const births = deaths.map((dead) => createBirth(dead, state, takenNames));
  state.agents = [...survivors, ...births].map(ensureAgent);
  state.lastDeaths = deaths.map((a) => ({ id: a.id, name: a.name, lang: a.lang, ageDays: a.ageDays, simDay: state.simDay }));
  state.lastBirths = births.map((a) => ({ id: a.id, name: a.name, lang: a.lang, home: a.home, simDay: state.simDay }));

  console.log(`Wake ${state.simDay}: initial town call`);
  const townContext = await initialTownCall(state);
  state.today = { ...townContext, simDay: state.simDay, generatedAt: state.lastWake, locked: false, townSummary: "" };

  const knownIds = new Set(state.agents.map((a) => a.id));

  // Free tier TPM limit is 8,000 tokens/min. Each agent call uses ~735 tokens.
  // Batches of 4 = ~2,940 tokens per burst. 5s pause between batches is safe.
  // Total wake time: ~25 seconds instead of timing out.
  const BATCH_SIZE = 4;
  const BATCH_PAUSE_MS = 5000;
  const allGenerated = [];

  for (let b = 0; b < state.agents.length; b += BATCH_SIZE) {
    const batch = state.agents.slice(b, b + BATCH_SIZE);
    console.log(`Wake ${state.simDay}: agents ${b + 1}–${Math.min(b + BATCH_SIZE, state.agents.length)} of ${state.agents.length}`);
    const batchResults = await Promise.all(
      batch.map((agent) => {
        if (agent.ageDays === 0) {
          return Promise.resolve({
            mood: "newborn", daySummary: "A newborn's first quiet day.", memoryDigest: agent.memoryDigest,
            aspirations: [], privateDevelopments: [], gossipToShare: [], relationshipIntentions: [],
            schedule: [{ start: "00:00", end: "23:59", location: "home", activity: "Being cared for at home", status: "planned", eventId: null }],
          });
        }
        return individualAgentCall(agent, state, townContext);
      })
    );
    allGenerated.push(...batchResults);
    if (b + BATCH_SIZE < state.agents.length) await sleep(BATCH_PAUSE_MS);
  }

  for (let i = 0; i < state.agents.length; i += 1) {
    const agent = state.agents[i];
    const generated = allGenerated[i];
    agent.memoryDigest = generated.memoryDigest;
    agent.aspirations = generated.aspirations;
    agent.today = {
      simDay: state.simDay,
      dateKey: `sim-${state.simDay}`,
      generatedAt: state.lastWake,
      locked: true,
      mood: generated.mood,
      daySummary: generated.daySummary,
      privateDevelopments: generated.privateDevelopments,
      gossipToShare: generated.gossipToShare,
      schedule: generated.schedule,
      sharedEventIds: townContext.sharedEvents
        .filter((event) => Array.isArray(event.affectedAgents) && event.affectedAgents.includes(agent.id))
        .map((event) => event.id),
    };
    agent.lifeHistory.push({ simDay: state.simDay, type: "daily_update", summary: generated.daySummary });
    agent.lifeHistory = agent.lifeHistory.slice(-40);
    applyRelationshipIntentions(agent, generated.relationshipIntentions, knownIds, state.simDay);
  }

  console.log(`Wake ${state.simDay}: final town call`);
  const finalResult = await finalTownCall(state, townContext);
  applyFinalTownResult(state, finalResult);
  saveState(state);

  console.log(`Wake ${state.simDay} complete: ${state.agents.length} agents, ${deaths.length} deaths, ${births.length} births.`);
}

main().catch((error) => {
  console.error("Lifecycle v2 failed:", error);
  process.exitCode = 1;
});