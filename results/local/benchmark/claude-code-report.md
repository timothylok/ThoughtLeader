# Claude Code arm — Australian AI startup ecosystem

Same topic, same 5 goals, same 9 seed sources as run `19ac529b`.
Method: direct `WebFetch` per source, synthesised in one pass.
Started 00:37:56Z.

---

## Goal 1 — Sector concentration and growth

**240 companies across 17 sectors** (SmallBizAI). Largest clusters:

| Sector | Companies |
|---|---|
| Fintech & Finance | 30+ |
| HR & Workforce | 20+ |
| Health & Medical | 18+ |
| Construction & Property | 15+ |
| Retail & eCommerce | 14+ |

Growth signal comes from funding rather than headcount. Cut Through Venture, **Q2 2026**:
- **Highest deal count:** vertical business software, climate & energy
- **Highest funded:** AI models & data infrastructure, fintech, hardware, robotics & sensors
- **AI-enabled companies were ~two-thirds of all deals**

The notable shift is away from traditional SaaS toward hardware, robotics and AI infrastructure.

## Goal 2 — AI-native vs AI-enabled

SmallBizAI uses a **founding-date proxy**, which is concrete and checkable:

- **AI-native:** founded **2016 or later**, "when modern AI became commercially viable" — AI in the product from day one.
- **Established:** founded **pre-2016** — proven businesses that added AI to existing products.

**Split: ~45% AI-native / ~55% established.**

- AI-native examples: Harrison.ai, Annalise.ai, Baraja, Carbar, Leonardo AI, Marqo
- AI-enabled incumbents: WiseTech Global, REA Group, MYOB, Zip Co

## Goal 3 — Funding landscape

**Q2 2026: A$1.7 billion** across **64 VC rounds + 5 accelerator rounds**.

**Largest rounds:** Firmus, Airwallex, Liquid Instruments, Everlab, Omniscient Neurotechnology.

**Standout deal — Firmus:** **$2.85B at a $15B valuation** (Aug 7 2026), backed by **Nvidia, Blackstone and Jane Street**, funding *Project Southgate*, an Australian AI data-centre build. This single round dwarfs the rest of the quarter and signals sovereign AI-infrastructure investment.

**Recent smaller rounds (Jul–Aug 2026):**
| Company | Amount | Note |
|---|---|---|
| Vexev | $8.6M | UNSW medical robotics spinout, vascular ultrasound, pursuing FDA |
| Navi | $6.8M | paediatric medtech, FDA-cleared newborn catheter |
| Enrola | $2.1M seed | pivoted edtech → AI sales-tech |
| Rampart | $2.3M | media |
| Outlier Space | $10.5M pre-seed | **NZ** — reusable orbital capsules |

**Most active investors:** Blackbird (largest AU fund), Startmate (accelerator), AirTree, Square Peg, Main Sequence.

**Diversity:** female founders took ~**33% of capital** and **26% of deal count**.

## Goal 4 — Geographic clusters

| State / city | Companies | Character | Examples |
|---|---|---|---|
| NSW / Sydney | ~90 | Largest cluster; fintech + platform | Canva, Atlassian, WiseTech |
| VIC / Melbourne | ~50 | HR, property, consumer | Culture Amp, REA Group, MYOB |
| QLD / Brisbane | ~20 | Agtech, SaaS | Go1, AgriWebb, Simpro |
| WA / Perth | ~6 | Mining tech | IMDEX, Micromine, Artrya |
| SA / Adelaide | ~5 | Space, defence | Myriota, Complexica, Presagen |
| ACT / Canberra | ~5 | Research-driven | CSIRO/Data61, Seeing Machines |

**Sydney + Melbourne ≈ 60% of profiled companies.** Perth is distinctly mining-specialised; Adelaide skews space/defence; Canberra is research-adjacent.

## Goal 5 — Named companies by sector

- **Health/medical:** Harrison.ai, Annalise.ai, Cortical Labs, Artrya, Everlab, Omniscient Neurotechnology, Vexev, Navi
- **Fintech:** Airwallex, Athena Home Loans, Spaceship, Zip Co
- **HR/workforce:** Employment Hero, Deputy, Culture Amp, ELMO Software
- **Retail/eCommerce:** Canva, Linktree, Lexer, Swiftly
- **Mining/resources:** IMDEX, Micromine, Emesent, EARTH AI
- **Security:** Bugcrowd, Kasada, archTIS, WhiteHawk
- **AI infra / deep tech:** Firmus, PsiQuantum, Baraja, Morse Micro, Fleet Space, Gilmour Space, Nomad Atomics
- **Generative AI:** Leonardo AI, Marqo, Build Club
- **Agtech:** AgriWebb, Halter (NZ)
- **Early-stage AI (Startmate):** Voqo.ai, Pentacue, Duohub, Ninja AI, CareGP, Integuide, Luck AI, Fairgo.ai, Landid, Vulnetix

## Ecosystem context

- **949,000** Australians in tech-related jobs; sector contributes **~$250B to GDP** (Mar 2026, Tech Council)
- **CSIRO** runs "one of the largest applied AI capabilities in the world" — **1,000+ researchers**
- Women hold just **20%** of highly technical roles and leave at ~2× the rate of men

---

## Process record

| | |
|---|---|
| Sources attempted | 9 |
| `WebFetch` calls | 10 (one retry for a redirect) |
| Substantive successes | 7 |
| Failures | InnovationAus **HTTP 403**; Wikipedia returned near-empty |
| Redirect handling | `cutthroughventure.com/reports` → `cutthrough.com` required a manual second call |
| Wall clock | **~2.5 minutes** |
| Direct $ cost | none metered separately (part of this session) |
