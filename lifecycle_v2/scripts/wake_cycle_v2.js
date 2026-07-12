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
const AGENT_MODEL = process.env.GROQ_AGENT_MODEL || "openai/gpt-oss-20b";
const TOWN_MODEL = process.env.GROQ_TOWN_MODEL || "openai/gpt-oss-120b";

const DAYS_PER_WAKE = 2;
const LIFESPAN_DAYS = 56;
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 2500);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function askGroqJson({ model, system, user, maxTokens, temperature }) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY is not configured");

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
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned empty content");
  return extractJson(content);
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
    const result = await askGroqJson({ model: TOWN_MODEL, system, user, maxTokens: 1400, temperature: 0.95 });
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
  const system = `You simulate one autonomous resident for one full day. Their choices are random before generation, but the resulting schedule is locked for the day.
They may follow or deviate from obligations: skip class, call in sick, leave work early, respond to family news, pursue aspirations, gossip, complain, reconcile, or change plans. Stay consistent with shared events and relationships. Do not invent agent IDs.
Return JSON only with: {"mood":"...","daySummary":"...","memoryDigest":"...","aspirations":["..."],"privateDevelopments":["..."],"gossipToShare":[{"text":"...","aboutAgentIds":["agent_id"],"confidence":0.5}],"relationshipIntentions":[{"targetAgentId":"agent_id","closenessDelta":0,"trustDelta":0,"tensionDelta":0,"attractionDelta":0,"reason":"..."}],"schedule":[{"start":"06:30","end":"08:00","location":"home","activity":"...","status":"planned|changed|skipped|emergency","eventId":null}]}.
Schedule must cover morning through night in 5-8 non-overlapping entries. Use only these locations: ${VALID_LOCATIONS.join(", ")}. Keep memoryDigest compact and in English.`;

  const user = JSON.stringify({
    simDay: state.simDay,
    agent: compactAgent(agent),
    normalObligation: agent.job ? `Usually goes to ${agent.job}` : (agent.stage === "kid" || agent.stage === "teen") ? "Usually attends academy" : "No fixed work obligation",
    townContext,
    otherResidents: state.agents.filter((a) => a.id !== agent.id).map((a) => ({ id: a.id, name: a.name, stage: a.stage, job: a.job })),
  });

  try {
    const result = await askGroqJson({ model: AGENT_MODEL, system, user, maxTokens: 1150, temperature: 1.05 });
    return {
      mood: String(result.mood || "neutral"),
      daySummary: String(result.daySummary || "An ordinary day."),
      memoryDigest: String(result.memoryDigest || agent.memoryDigest).slice(0, 1800),
      aspirations: Array.isArray(result.aspirations) ? result.aspirations.slice(0, 4) : agent.aspirations,
      privateDevelopments: Array.isArray(result.privateDevelopments) ? result.privateDevelopments.slice(0, 4) : [],
      gossipToShare: Array.isArray(result.gossipToShare) ? result.gossipToShare.slice(0, 5) : [],
      relationshipIntentions: Array.isArray(result.relationshipIntentions) ? result.relationshipIntentions.slice(0, 8) : [],
      schedule: normalizeSchedule(agent, result.schedule),
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
  const system = `You are the final continuity editor for a persistent town. Review independently generated agent days and reconcile only real contradictions in shared events, schedules, gossip, and relationships while preserving randomness.
Return JSON only with: {"townSummary":"...","sharedEvents":[...],"relationshipUpdates":[{"sourceAgentId":"...","targetAgentId":"...","closenessDelta":0,"trustDelta":0,"tensionDelta":0,"attractionDelta":0,"reason":"..."}],"gossipUpdates":[{"recipientAgentId":"...","text":"...","sourceAgentId":null,"aboutAgentIds":["..."],"truthStatus":"true|false|mixed|unknown"}],"schedulePatches":[{"agentId":"...","reason":"...","schedule":[...]}]}.
Use only existing IDs. Patch schedules only when necessary for consistency.`;

  const user = JSON.stringify({
    simDay: state.simDay,
    initialTownContext: townContext,
    agents: state.agents.map((agent) => ({ id: agent.id, name: agent.name, relationships: agent.relationships, today: agent.today })),
  });

  try {
    return await askGroqJson({ model: TOWN_MODEL, system, user, maxTokens: 1900, temperature: 0.65 });
  } catch (error) {
    console.error("Final town call failed:", error.message);
    return {
      townSummary: "The town completed another ordinary wake cycle.",
      sharedEvents: townContext.sharedEvents,
      relationshipUpdates: [], gossipUpdates: [], schedulePatches: [],
    };
  }
}

function applyFinalTownResult(state, result) {
  const byId = new Map(state.agents.map((a) => [a.id, a]));
  const knownIds = new Set(byId.keys());

  for (const update of Array.isArray(result.relationshipUpdates) ? result.relationshipUpdates : []) {
    const source = byId.get(update.sourceAgentId);
    if (source) applyRelationshipIntentions(source, [update], knownIds, state.simDay);
  }

  for (const gossip of Array.isArray(result.gossipUpdates) ? result.gossipUpdates : []) {
    const recipient = byId.get(gossip.recipientAgentId);
    if (!recipient) continue;
    recipient.gossip.push({
      simDay: state.simDay,
      text: String(gossip.text || ""),
      sourceAgentId: gossip.sourceAgentId || null,
      aboutAgentIds: Array.isArray(gossip.aboutAgentIds) ? gossip.aboutAgentIds : [],
      truthStatus: gossip.truthStatus || "unknown",
    });
    recipient.gossip = recipient.gossip.slice(-20);
  }

  for (const patch of Array.isArray(result.schedulePatches) ? result.schedulePatches : []) {
    const agent = byId.get(patch.agentId);
    if (!agent) continue;
    agent.today.schedule = normalizeSchedule(agent, patch.schedule);
    agent.today.reconciliationReason = String(patch.reason || "shared-event consistency");
  }

  state.today = {
    simDay: state.simDay,
    generatedAt: state.lastWake,
    locked: true,
    townMood: state.today?.townMood || "",
    townSummary: String(result.townSummary || "The town completed another wake."),
    sharedEvents: Array.isArray(result.sharedEvents) ? result.sharedEvents : [],
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
  await sleep(REQUEST_DELAY_MS);

  const knownIds = new Set(state.agents.map((a) => a.id));

  for (let i = 0; i < state.agents.length; i += 1) {
    const agent = state.agents[i];
    console.log(`Wake ${state.simDay}: agent ${i + 1}/${state.agents.length} — ${agent.name}`);
    const generated = agent.ageDays === 0
      ? {
          mood: "newborn", daySummary: "A newborn's first quiet day.", memoryDigest: agent.memoryDigest,
          aspirations: [], privateDevelopments: [], gossipToShare: [], relationshipIntentions: [],
          schedule: [{ start: "00:00", end: "23:59", location: "home", activity: "Being cared for at home", status: "planned", eventId: null }],
        }
      : await individualAgentCall(agent, state, townContext);

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
    await sleep(REQUEST_DELAY_MS);
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
