# Agent Town — free, generational language-practice sim

16 agents (6 speak Hindi, 10 speak Italian), living on a schedule, aging,
dying, and being replaced by blank-memory newborns. Free to run.

## What runs where
- **The town itself** (this repo) — free on GitHub.
- **Background "wake cycle"** (aging, births/deaths, memory digests) — runs
  automatically 3x/week via GitHub Actions, free, using Groq's free API tier.
- **The viewer** (`index.html`) — a single static page, free to host on
  GitHub Pages. This is where you actually walk around and talk to agents.
- **Live conversations** — also use Groq's free tier, called directly from
  your browser using a key you paste in once (stored only in your browser,
  never committed to the repo).

## One-time setup (about 10 minutes)

1. **Create a free Groq account** at console.groq.com → API Keys → create a
   key. No credit card needed.
2. **Create a new GitHub repo** and upload everything in this folder
   (`index.html`, `data/`, `scripts/`, `.github/`).
3. **Add the background-cycle secret**: repo → Settings → Secrets and
   variables → Actions → New repository secret → name it `GROQ_API_KEY`,
   paste your key.
4. **Enable Actions** if prompted (repo → Actions tab → "I understand, enable").
   The wake cycle will now run automatically Mon/Wed/Fri. You can also trigger
   it manually anytime from the Actions tab → "Wake the Town" → Run workflow.
5. **Enable GitHub Pages**: repo → Settings → Pages → Source: "Deploy from a
   branch" → branch `main`, folder `/ (root)` → Save. GitHub gives you a URL
   like `https://yourname.github.io/agent-town/`.
6. **Open that URL**, paste your same Groq key into the box at the top
   (this is separate from the Actions secret — it's used for your live,
   on-demand conversations, right from your browser).

That's it — no server, no bill, nothing to keep running on your own machine.

## How the pieces work
- `data/agents-seed.json` — the starting 16 agents, staggered across life
  stages so the town never ages in synchronized "waves."
- `scripts/wake_cycle.js` — runs on the schedule in
  `.github/workflows/wake.yml`. Ages every agent, kills anyone past ~8 weeks,
  births a same-language blank-memory replacement, and asks Groq for one
  short memory-digest per agent (kept small on purpose to stay well inside
  the free tier).
- `data/agents.json` — the *live* state, overwritten by each wake cycle. This
  is what the viewer reads. (It doesn't exist until the first wake cycle
  runs — until then the viewer falls back to the seed file.)
- `index.html` — one continuous walkable world with a camera that follows
  you (no more button-switching between areas). Town Square, Residential
  Street (every agent has their own house), Museum, Outskirts & Airport, and
  a small Old Dungeon all sit in the same space, connected by paths. A few
  faded, wandering "extras" per area add life with no memory, nothing to
  say, and no API cost.
- **Living, non-repeating schedules.** Each agent's daily plan is generated
  from a seeded pattern tied to the current in-game day (`TOWN.simDay`, which
  advances with every wake cycle) — so times shift day to day, evening plans
  rotate, and there's a real, stage-dependent chance an agent spontaneously
  skips what they were "supposed" to do (a teen ditching class for the park,
  an adult blowing off work for the market). This costs zero extra API
  calls — it's computed entirely in the browser from a formula, not asked of
  the model. The **"Today's Schedules" button** shows every agent's full-day
  plan for today, pulled from that exact same function, so it's always in
  sync with what's actually happening — if someone's ditching today, the
  popup already shows it.

## Growing the world further
This is deliberately a starting frame, not a finished city — `REGIONS` and
`ZONES` near the top of `index.html`'s script are where you'd add more areas
(another town, a beach, a second museum wing). Each new zone just needs a
region, a label, and a position/size in world percentage coordinates. No
agent logic needs to change.

## Honest limits worth knowing
- Groq's free tier is real and has no credit card, but it is rate-limited —
  fine for one person's daily practice, not built for many simultaneous
  users.
- Your Groq key typed into the page lives in your browser's local storage
  and is visible in your own network requests. Fine for a personal project;
  don't share the deployed URL somewhere your key could be misused, and
  rotate the key at console.groq.com if you ever suspect it leaked.
- The wake-cycle cadence (Mon/Wed/Fri) is set in
  `.github/workflows/wake.yml` — edit the cron line if you want a different
  rhythm.
