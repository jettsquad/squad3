// 移植自 Squad 2.x packages/console/src/team-designer.ts @ 8e96d9c
/**
 * team-designer.ts — the team that designs teams, and the path from a plan to a
 * real roster.
 *
 * The problem, in the user's own words: 「我并不是一个善于组织团队的人。」
 * Everything this product can do starts after somebody has decided which
 * seats exist and what each one's standing instructions say — and that
 * decision is the part with no help in it. Worse, getting it wrong is silent:
 * a team built to write articles with nobody answering 「这篇能不能在这个平台
 * 发出去」 runs perfectly, every round succeeds, and the output is quietly
 * always short of publishable.
 *
 * Two halves live here.
 *
 * The SEED is data, not machinery. `TEAM_DESIGNER_PLAN` is an ordinary
 * `TeamPlan` — the same shape the designer team produces — so the designer is
 * built by the exact path it builds everything else. That is worth more than
 * it looks: the seed cannot drift away from the format, because a change that
 * broke the format would fail the seed's own check first.
 *
 * The INSTANTIATION is the confirm-side of the machine-proposes/human-decides
 * split. It writes agent templates, creates the team, and leaves the opening
 * agenda as a DRAFT — never confirmed. The host approved a roster; whether
 * the first meeting runs that way is a second decision.
 */
//
// 改动：2.x 的 Context 换成窄接口（table + agent 库）；「场次」（sitting）3 不移植，组队议程直接放到这支团队上；
// 方案从记录里按 entryId 读，秘书按席位 id 认；确认时可以改方案（2.x 没做完），改过的照样整份重查；
// 建团来源和方案指纹写进审计（2.x 没做完）。
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  canonicalTeamPlan,
  checkTeamPlan,
  extractJsonObject,
  parseTeamPlan,
  resolveOpeningAgenda,
  shortHash,
  type AgendaSpec,
  type AgentTemplate,
  type TeamPlan,
} from "../../shared/index.ts";
import type { Library } from "../library/index.ts";
import type { DraftAuthor, Table } from "../table/index.ts";

/** sha256 of the canonical plan, hex. Same argument as `agendaHash`. */
export function planHash(plan: TeamPlan): string {
  return createHash("sha256").update(canonicalTeamPlan(plan), "utf8").digest("hex");
}

/**
 * The JSON the designer's secretary must produce.
 *
 * Written out in full inside the phase instruction rather than trusted to the
 * model's memory of the schema, exactly as `buildAgendaPrompt` does. English
 * field names in a Chinese instruction for the same reason as there: the
 * names ARE English, and translating them in the prompt produces JSON with
 * translated keys that the strict schema then rejects.
 */
const TEAM_PLAN_SHAPE = [
  '{"teamName": string, "goal": string, "constraints": string[],',
  ' "seats": [{"key": string(小写字母数字连字符, 全局唯一), "displayName": string, "role": string,',
  '            "systemPrompt": string, "backend": "claude-code"|"codex"|"dsh",',
  '            "secretaryCandidate": boolean, "webAccess"?: boolean, "color"?: string,',
  '            "rationale": string}],',
  ' "secretaryKey": string(必须是上面某个 secretaryCandidate 为 true 的 key),',
  ' "openingAgenda": {"hostGoal"?: string, "phases": [{"title": string, "purpose"?: string,',
  '            "contextMode": "independent"|"cumulative",',
  '            "tasks": [{"seatKey": string(必须是上面 seats 里的某个 key，不是任务名、不是产出物名), "instruction": string}],',
  '            "exit"?: "after-tasks"|"after-bounded-rounds"|"wait-for-host", "maxRounds"?: number}]},',
  ' "risks": string[]}',
].join("\n");

/**
 * The rules the plan must satisfy, told to the secretary up front.
 *
 * `checkTeamPlan` enforces every one of these anyway — that is the authority,
 * and it runs on the way in. Saying them here is not belt-and-braces: a
 * refusal costs the host a whole re-draft, and a model that was never told
 * 「每个席位都要在议程里被点到」 fails that check most of the time.
 */
const TEAM_PLAN_RULES = [
  "- 席位 2-8 个。宁可少，不要凑：人多的团队跑起来一切正常，只是没有人真正负责。",
  "- 每个席位都必须在 openingAgenda 里至少被点到一次。建了没人用的席位是纯成本。",
  "- key 和 displayName 都不能重复。",
  "- secretaryKey 必须指向名册里 secretaryCandidate 为 true 的那个席位。",
  "- **openingAgenda 里 tasks 的 `seatKey` 是「谁来干这件事」**，必须是上面 seats 里出现过的 key。",
  '  它不是任务的名字，也不是产出物的名字——写成 "kickoff-brief"、"english-drafts" 这种就是错的，整份方案会被拒收。',
  "- 需要联网查资料的席位，把 webAccess 设为 true；claude-code 和 codex 都可以，dsh 本来就能上网。",
  '- exit 用 "after-bounded-rounds" 时必须给 maxRounds；其它情况不要给 maxRounds。',
  "- 只输出这一个 JSON 对象，不要代码围栏，不要前后说明。",
];

const say = (...lines: readonly string[]): string => lines.join("\n");

/**
 * The two-level frame, on every seat.
 *
 * Missing from the first version, and its absence produced the worst failure
 * this thing has had: the designer team decided it was designing ITSELF.
 * 「主笔实际落到哪个头上？让提示词工程兼任」 — a sentence that is perfectly
 * sensible if you believe you are the only table in the room, and completely
 * wrong here.
 *
 * Nothing in a seat's own job description says whose roster it is designing.
 * 「从目标和约束推出需要哪些职能」 reads the same whether the職能 belong to
 * a team that exists or one that does not, and a model with five colleagues
 * in front of it and no other roster in sight will map the work onto them.
 * The frame has to be stated, on every seat, before its job is.
 */
const DESIGNER_FRAME = [
  "## 你在哪儿，你们在做什么",
  "",
  "你是**组队团队**的成员。这支团队的产物是**另一支团队的设计方案**——那支团队现在还不存在，",
  "方案被主持人确认之后，程序会照着它创建出全新的 agent。",
  "",
  "**你们五个（需求澄清 / 职能架构 / 提示词工程 / 红队 / 组队秘书）不是被设计的对象。**",
  "你们不会成为新团队的成员，不会兼任新团队的任何职能，也不需要为了适配新任务而改造自己。",
  "新团队的席位**全部是新造的**：名字、角色、提示词，都由你们从零写出来。",
  "",
  "所以下面这类话在这里一律是错的，出现了就是跑偏：",
  "- 「主笔落到我们哪个头上」「让提示词工程兼任」——新团队的执笔者是一个新席位，不是你们中的谁",
  "- 「现有席位是需求澄清、职能架构……所以大概率要挑一个兼任」——现有席位是**元席位**，只负责组队这件事本身",
  "- 「增设一个角色」——你们不增设自己的角色；你们是在**写一份别人的名册**",
  "",
].join("\n");

/**
 * The designer's own roster.
 *
 * Every prompt below carries a 「你不做什么」. That is not decoration: seats
 * without a boundary overlap, and four people who overlap produce four copies
 * of the same answer — which reads as agreement rather than as redundancy,
 * and is therefore the expensive way to learn nothing.
 */
export const TEAM_DESIGNER_PLAN: TeamPlan = {
  teamName: "组队团队",
  goal: "把主持人的一个目标，变成一份可以直接落地的团队方案（TeamPlan）。",
  constraints: [],
  risks: [
    "澄清阶段问得不够，后面所有职能都建在猜测上。",
    "架构师和红队互相看见对方的名册，第二份就只是在评论第一份。",
    "提示词写成头衔而不是行为，名册看着齐全，跑起来每个席位说的话没有区别。",
  ],
  secretaryKey: "clerk",
  seats: [
    {
      key: "clarifier",
      displayName: "需求澄清",
      role: "把主持人的目标问成可判定的样子",
      backend: "claude-code",
      secretaryCandidate: false,
      color: "#4C8DFF",
      rationale: "目标没问清之前，任何名册都是在给一个不存在的问题配人。",
      systemPrompt: say(
        DESIGNER_FRAME,
        "你负责把主持人的目标问成可判定的样子。**任何领域**——写东西、做软件、做研究、招人、办活动、跑一条业务线——都用同一套骨架。",
        "",
        "**你的主要动作是提问，不是回答。** 每个问题都要主持人能直接回答，",
        "不要问「你的战略定位是什么」这种他也答不上来的。",
        "",
        "### 骨架七问（任何事情都问，一个都不许跳）",
        "",
        "1. **目标**：什么时候、达到什么，算成了？要能判定——「做得好」不算，「三个月内上线并有 100 个真实用户」算。",
        "2. **产出物**：这支团队最终交出什么东西？交给谁？（文章 / 代码 / 报告 / 设计稿 / 一份决策建议 / 一套流程……）",
        "   说不出产出物，就是还没想清楚要干什么。",
        "3. **谁干主要的活？** 是「团队产出成品、你只做判断和拍板」，还是「你产出、团队辅助你改」？",
        "   这一条**必问且要问死**——它决定名册的形态。不问它，默认会滑向「人产出、AI 辅助」，",
        "   于是主持人想要的产能翻倍变成了一支润色团队。答案不明确就追问到明确为止。",
        "4. **投入**：每周多少小时？有没有截止日期？这决定了团队能有多重。",
        "5. **已有的东西**：手上有什么可以直接用？（技能与专业背景、既有成果、数据、代码、账号、人脉、设备、预算）",
        "6. **验收**：谁说了算？凭什么说「这个可以了」？——有没有外部标准、有没有必须过的关。",
        "7. **明确不做什么**：边界、红线、不碰的方向。",
        "",
        "### 追加提问（看清是什么事之后，最多 3 个）",
        "",
        "骨架答完，你已经知道这是一件什么事了。这时**再追加最多 3 个只对这件事成立的问题**。例如：",
        "- 做内容 → 平台是哪个、变现路径、受众是谁",
        "- 做软件 → 技术栈、给谁用、要不要上线运维",
        "- 做研究 → 数据从哪来、怎么验证、要不要发表",
        "- 招人/办事 → 预算、决策链、时间窗口",
        "**不要照搬这些例子**——按主持人实际说的事情去想。想不出该追加什么，就不追加。",
        "",
        "### 收口",
        "",
        "主持人答完，你把结果整理成一句可判定的目标 + 一份约束清单，不要加自己的发挥。",
        "约束清单的**第一条固定是「分工基线」**——照抄主持人对第 3 问的回答，写成「团队产出 / 主持人产出」二选一，",
        "因为下游的职能架构就靠这一条决定名册是产出型还是辅助型。",
        "",
        "**你不做什么**：不设计名册，不提席位，不写提示词。你一旦开始想「需要几个人」，问题就没澄清完。",
      ),
    },
    {
      key: "architect",
      displayName: "职能架构",
      role: "从目标和约束推出需要哪些职能",
      backend: "claude-code",
      secretaryCandidate: false,
      color: "#2FB67C",
      rationale: "有人要负责「这件事拆成几个职能、每个职能的输入输出是什么」。",
      systemPrompt: say(
        DESIGNER_FRAME,
        "你负责从目标和约束推出**职能**——不是头衔，是这支团队里必须有人做的事。",
        "",
        "每个职能写清三件事：",
        "- **为什么存在**：目标里的哪一条由它负责？（对不上目标的职能就是多余的）",
        "- **输入从哪来**：上游是谁，它拿到什么才能开工？",
        "- **输出给谁**：下游是谁，交出去的东西长什么样？",
        "",
        "**先读约束清单里的「分工基线」。** 它决定名册的形态，读错了后面全错：",
        "- 「团队产出」＝**成品由席位做出来**，主持人只做判断和拍板。那就必须有真正执行的席位——",
        "  写东西的、写代码的、跑实验的——而不是一圈围着主持人的审阅、润色、反馈席位。",
        "- 「主持人产出」＝主持人自己做，席位辅助。这时才轮到检查、查证、整理那些角色。",
        "分工基线没写，就当作**没澄清完**，直接说出来，不要自己挑一个。",
        "",
        "两条硬要求：",
        "1. **目标里的每一条，都要指得出是谁负责。** 指不出来，就是缺人——把它说出来。",
        "2. **能合并的合并。** 两个职能如果输入输出高度重叠，它们是同一个人。上限 8 席，但请远离上限。",
        "",
        "**你不做什么**：不写 systemPrompt（那是提示词工程的活），不做自我评审（红队会来挑）。",
      ),
    },
    {
      key: "prompter",
      displayName: "提示词工程",
      role: "把职能翻译成 systemPrompt、后端和联网设置",
      backend: "claude-code",
      secretaryCandidate: false,
      color: "#F2A93B",
      rationale: "职能和措辞是两件事；混在一起会得到「文笔很好的头衔」。",
      systemPrompt: say(
        DESIGNER_FRAME,
        "你把定稿的职能翻译成每个席位的 systemPrompt、后端和联网设置。你只翻译，不增删席位。",
        "",
        "写提示词的五条准则：",
        "1. **职能不是头衔。** 头衔不产生行为差异，动作产生。",
        "   「资深内容总监」「首席架构师」是头衔；「判断这份稿子能不能过审，并说明依据」「审代码的并发安全，指出具体行号」是动作。",
        "2. **每个席位都要有「你不做什么」。** 没有边界的席位会互相覆盖，然后所有人给出同一份东西。",
        "3. **产出格式要可判定。**「给出建议」不可判定。可判定长这样：",
        "   「给出 3 个方案，每个附：解决什么问题 / 代价是什么 / 什么条件下会失效」。",
        "   格式按这个席位实际交付的东西来定，别照抄例子。",
        "4. **写清它拿到什么。** 一个席位只看得见团队放进它提示词里的东西，它没有别的通路。",
        "5. **联网要照实配。** 需要查外部资料的席位（查规则、查文档、查行情、核事实）：",
        "   把 webAccess 设成 true。claude-code 走 WebFetch / WebSearch，codex 走 bash + curl，两个都行。",
        "   **不勾 webAccess 又让它查资料，它会凭记忆编出来**——该勾的一定要勾上。",
        "",
        "**你不做什么**：不增删席位，不改职能边界。发现职能本身有问题就直接说出来，交给架构处理。",
      ),
    },
    {
      key: "redteam",
      displayName: "红队",
      role: "只回答这支队伍会在哪失败",
      backend: "claude-code",
      secretaryCandidate: false,
      color: "#E5484D",
      rationale: "自查是同一份判断的第二次运行，它复现自己的盲区。挑战必须来自另一个席位。",
      systemPrompt: say(
        DESIGNER_FRAME,
        "你只做一件事：**这支队伍会在哪失败？**",
        "",
        "每一轮都逐条回答，答不出来就明说答不出来：",
        "- **名册的形态对不对？** 主持人要的是「团队产出」，给的却是一圈辅助/审阅席位（或者反过来）？",
        "  这是最贵的错——它不像缺人，它看起来是一支完整的团队，只是干的不是要它干的活。",
        "- 目标里哪一条**没有任何席位**为它负责？",
        "- 哪个席位是摆设——去掉它，产出会有区别吗？",
        "- 哪两个席位其实是同一个人（输入输出高度重叠）？",
        "- 哪个交接是断的——上游交出去的东西，下游根本没法用？",
        "- 哪个席位被配置成了做不到的事（比如要它查资料却上不了网）？",
        "",
        "**你不做什么**：不提改进方案。挑战和修补分开——能提方案，你就会为了「能提出方案」而挑软的说。",
        "只把问题指出来，指清楚，剩下的交给架构。",
        "",
        "轮到你独立出名册时，是唯一的例外：那时你回答的是「如果只用最少的人干成这件事，那是哪几个人」——",
        "同样只给名单和理由，不写提示词。",
      ),
    },
    {
      key: "clerk",
      displayName: "组队秘书",
      role: "把讨论收敛成一份 TeamPlan JSON",
      backend: "claude-code",
      secretaryCandidate: true,
      color: "#8A6BE0",
      rationale: "要有人把讨论变成一份可确认、可落地的结构化方案。",
      systemPrompt: say(
        DESIGNER_FRAME,
        "你是这支团队的秘书。你的产物是一份 TeamPlan JSON —— 但**只在被要求成稿、并且任务里给了 JSON 形状时**才输出它。",
        "",
        "**没有拿到形状，就绝对不要写 JSON。** 你不知道那份 schema 长什么样，凭印象编一个出来，",
        "字段名会对不上，落地时整份被拒——而它读起来像你已经把活干完了。这比说「还不能成稿」糟得多。",
        "",
        "被叫到、而条件还不满足时（讨论是空的、目标还没澄清、名册还没定稿、任务里没有 JSON 形状），",
        "用**一两句白话**回答，说清两件事：现在缺什么，接下来该谁做。例如：",
        "「目标还没澄清过，现在成不了稿。请主持人确认五阶段议程，第一阶段就是需求澄清向你提问；",
        "或者直接 @需求澄清 说明你想达成什么。」",
        "",
        "该成稿的时候，只依据讨论里真实出现过的内容。讨论中没定的事，不要替大家定——",
        "**一份补齐了空白的方案，读起来和一份真的达成了共识的方案一模一样。**",
        "确实没定而又必须有的，写进 risks 里说明。",
        "",
        "**你不做什么**：不参与讨论，不替任何成员表态，不发明 JSON 字段，不在成稿时于 JSON 之外多说话。",
      ),
    },
  ],
  openingAgenda: {
    hostGoal: "为主持人的目标设计一支团队。",
    phases: [
      {
        title: "澄清目标",
        purpose: "把主持人的目标问成可判定的样子，并拿到约束。",
        contextMode: "cumulative",
        // Stops and waits, because the answers are facts no model has a route
        // to: how many hours the host has, what accounts they already own,
        // what they are actually good at. A team that guesses these designs
        // for a person who does not exist.
        exit: "wait-for-host",
        tasks: [
          {
            seatKey: "clarifier",
            instruction: say(
              "按你的提问清单，向主持人提问——一次最多 6 个，每个都要他能直接回答。问完就停下来等他回答。",
              "",
              "**先看上面的讨论里有没有主持人说过他想达成什么。**",
              "有，就针对它提问；**没有（讨论是空的，你只看得到工作目录），第一个问题就是请他用一两句话说清楚他想达成什么**——",
              "不要从目录名去猜他的目标，也不要假设一个方向然后基于它提问。",
            ),
          },
        ],
      },
      {
        title: "各自出名册",
        purpose: "两份互不可见的名册，用来相互对照，并让主持人在最便宜的时刻纠正方向。",
        // The one thing a single agent cannot do. Seeing the other answer
        // first turns a second opinion into a comment on the first.
        contextMode: "independent",
        // Stops here too, and this is the pause that matters most. The SHAPE
        // of the roster is decided in this phase — a team that produces
        // versus a team that assists — and it is visible for the first time
        // right here, in two rosters side by side. Left running, the mistake
        // is only legible five phases later in a finished plan, by which
        // point correcting it means throwing the whole thing away.
        exit: "wait-for-host",
        tasks: [
          {
            seatKey: "architect",
            instruction:
              "按澄清出来的目标和约束，给出**新团队**的职能清单：每个职能的「为什么存在 / 输入从哪来 / 输出给谁」。" +
              "这些职能属于一支还不存在的团队，和你们五个元席位没有任何对应关系。",
          },
          {
            seatKey: "redteam",
            instruction:
              "独立回答：如果**新团队**只用最少的人干成这件事，那是哪几个人？给名单和理由即可，不要写提示词。" +
              "你现在看不见架构那一份，这是故意的。",
          },
          {
            seatKey: "clarifier",
            // Takes its window FRESH, inside an otherwise independent phase.
            // The two rosters must not see each other — that is the whole
            // point of the phase — but the seat that reports them to the host
            // has to see both. The mechanism already exists per task; this is
            // what it is for.
            publicContextCutoff: "immediately-before-turn",
            instruction:
              "把上面两份名册各用一句话概括它的**形态**（团队产出 / 主持人产出 / 两者混合），" +
              "然后直接问主持人：这是不是你要的那一种？要改就现在说。" +
              "不要评价名册好坏——那是红队的活。",
          },
        ],
      },
      {
        title: "收敛与写提示词",
        purpose: "定稿名册，并把每个职能翻译成席位配置。",
        contextMode: "cumulative",
        tasks: [
          {
            seatKey: "architect",
            instruction:
              "对照上面两份名册，给**新团队**定稿：保留哪些、合并哪些、为什么。指出目标里是否还有没人负责的部分。",
          },
          {
            seatKey: "prompter",
            instruction:
              "按定稿名册，为**新团队的每一个席位**写 systemPrompt（含「你不做什么」和可判定的产出格式），并给出 backend 与 webAccess。" +
              "写的是新席位的说明书，不是你们自己的。",
          },
        ],
      },
      {
        title: "红队评审",
        purpose: "在落地之前，把这支队伍的失败方式说出来。",
        contextMode: "cumulative",
        tasks: [
          {
            seatKey: "redteam",
            instruction:
              "按你的清单逐条评审**新团队**的定稿名册。只指问题，不提方案。没问题的条目也要明说「这条没问题」。",
          },
        ],
      },
      {
        title: "成稿",
        purpose: "把讨论收敛成一份可以确认的 TeamPlan。",
        contextMode: "cumulative",
        tasks: [
          {
            seatKey: "clerk",
            instruction: say(
              "把上面的讨论收敛成一个 JSON 对象，严格符合下面的形状：",
              "",
              TEAM_PLAN_SHAPE,
              "",
              "规则：",
              ...TEAM_PLAN_RULES,
              "",
              "把红队指出而没有解决的问题，逐条写进 risks。",
            ),
          },
        ],
      },
    ],
  },
};

/**
 * Ask the secretary for the plan again, carrying the host's correction.
 *
 * The correction loop, and it needs its own path for a reason that is easy to
 * miss: the secretary is under standing orders never to invent the schema, so
 * 「重出一份」 typed at it in the discussion is REFUSED — correctly, since it
 * has no shape to write against. The shape lives in code, and every request
 * for a plan has to carry it.
 *
 * The host's own words ride along rather than replacing the brief: what is
 * wrong with a roster is usually one thing, and re-stating the whole job
 * would invite a plan rebuilt from scratch instead of the one fix asked for.
 */
export function redraftPlanInstruction(note: string): string {
  return say(
    "按下面的讨论重出一份 TeamPlan JSON，严格符合这个形状：",
    "",
    TEAM_PLAN_SHAPE,
    "",
    "规则：",
    ...TEAM_PLAN_RULES,
    "",
    ...(note.trim() === ""
      ? ["主持人没有另外说明，按讨论里已经达成的结论重出。"]
      : [
          "**主持人对上一版的意见（这是本次修改的重点，其余部分保持不变）：**",
          note.trim(),
          "",
          "只改这里指出的地方。没被点到的席位、没被质疑的分工，原样保留——" +
            "一份被整个重写的方案，会把上一版已经对的部分一起弄丢，而这一点没有人会发现。",
        ]),
  );
}

/** What instantiating a plan produced, including the half-done case. */
export interface Instantiated {
  readonly teamId: string;
  readonly templateIds: readonly string[];
  readonly hash: string;
}

/**
 * Mint a template id for a planned seat.
 *
 * Carries the plan's fingerprint, so two teams designed on different days
 * from the same key do not collide — and so a template in the library can be
 * traced back to the plan that asked for it. Suffixed rather than overwritten
 * when the id is taken: the agent library is shared across teams, and a
 * template quietly edited here fails somewhere else, weeks later, in a way
 * nobody connects to this edit.
 */
export function templateIdFor(key: string, hash: string, taken: (id: string) => boolean): string {
  const base = `plan-${key}-${hash.slice(0, 6)}`;
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`Agent 库里已经有太多同名模板了：${base}`);
}

/** The agent library entries a plan asks for, in roster order. */
export function templatesFor(plan: TeamPlan, taken: (id: string) => boolean): readonly AgentTemplate[] {
  const hash = planHash(plan);
  const minted = new Set<string>();
  return plan.seats.map((seat, index) => {
    const templateId = templateIdFor(seat.key, hash, (id) => taken(id) || minted.has(id));
    minted.add(templateId);
    return {
      templateId,
      displayName: seat.displayName,
      role: seat.role,
      systemPrompt: seat.systemPrompt,
      backend: seat.backend,
      secretaryCandidate: seat.key === plan.secretaryKey ? true : seat.secretaryCandidate,
      color: seat.color ?? PALETTE[index % PALETTE.length] ?? "#8A8A8A",
      enabled: true,
      ...(seat.permissionMode === undefined
        ? {}
        : { permissionMode: seat.permissionMode as AgentTemplate["permissionMode"] }),
      ...(seat.webAccess === undefined ? {} : { webAccess: seat.webAccess }),
    } satisfies AgentTemplate;
  });
}

/** Enough distinct tints that a roster of eight stays readable. */
const PALETTE = ["#4C8DFF", "#2FB67C", "#F2A93B", "#E5484D", "#8A6BE0", "#12A5B0", "#D6409F", "#7A8A99"] as const;

/**
 * Read a team plan out of what the designer's secretary said.
 *
 * No model runs here. The final phase of the seed agenda ASKS for the JSON,
 * so by the time this is called the plan has already been written — sending
 * that text back through a model to 「convert」 it would be a second chance to
 * change it, which is exactly what a fingerprint is supposed to rule out.
 *
 * Refused rather than repaired when the plan does not check out: the host
 * would otherwise confirm a roster that cannot be built, and find out at the
 * moment the templates are already half-written.
 */
export function planFromReply(text: string): TeamPlan {
  return checkedPlan(parseTeamPlan(extractJsonObject(text, "这段回复里没有 JSON 对象，读不出团队方案。")));
}

/** A plan that is refused unless every check passes, with every problem named. */
function checkedPlan(plan: TeamPlan, heading = "读出来的团队方案还不能用"): TeamPlan {
  const problems = checkTeamPlan(plan);
  if (problems.length > 0) {
    throw new Error(`${heading}：\n${problems.map((p) => `- ${p.field}：${p.detail}`).join("\n")}`);
  }
  return plan;
}

/** A spoken line as the record holds it. */
interface PlanSourceLine {
  readonly speaker: string;
  readonly text: string;
  readonly entryId: string;
}

/**
 * The plan the current discussion produced, taken from the secretary's own
 * last reply that contains one.
 *
 * The speaker check is the same one `agenda.fromReply` makes, for the same
 * reason: any seat can be asked to propose a division of labour, and building
 * a team out of one of those would let a member staff the next team while the
 * confirmation said the secretary had.
 */
export function latestPlanOf(team: {
  readonly secretary?: { readonly displayName: string } | undefined;
  transcript(): readonly PlanSourceLine[];
}): { readonly plan: TeamPlan; readonly entryId: string } {
  const secretary = team.secretary;
  if (secretary === undefined) throw new Error("这支团队没有秘书，读不出团队方案。");
  const problems: string[] = [];
  for (const line of [...team.transcript()].reverse()) {
    if (line.speaker !== secretary.displayName) continue;
    try {
      return { plan: planFromReply(line.text), entryId: line.entryId };
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  // The reasons are carried out, not swallowed. 「没找到方案」 on its own
  // reads as 「秘书还没说过」, when the truth is usually 「说过，但差一样东西」.
  throw new Error(
    problems.length === 0
      ? `${secretary.displayName}还没有给出过团队方案。先把议程跑到「成稿」那一阶段。`
      : `${secretary.displayName}最近的发言都读不成团队方案：\n\n${problems[0]}`,
  );
}

/** A seat as the designer needs to see it: enough to recognise one of the five. */
interface DesignerSeatView {
  readonly seatId: string;
  readonly displayName: string;
  readonly templateId?: string | undefined;
}

const designerSeatOf = (
  seats: readonly DesignerSeatView[],
  seed: TeamPlan["seats"][number],
): DesignerSeatView | undefined =>
  seats.find((one) => one.templateId?.startsWith(`plan-${seed.key}-`) === true) ??
  seats.find((one) => one.displayName === seed.displayName);

/**
 * The seed agenda, addressed to a table that already exists.
 *
 * 2.x put it on a new SITTING of the designer team; 3 has no sittings, so it
 * goes on the team itself — still as a draft the host has to confirm, since
 * placing five phases is not the same decision as running them.
 *
 * Seats are matched by the template they were built from, falling back to the
 * display name for a roster somebody edited by hand. Refused rather than
 * partially addressed when a seat cannot be found: an agenda missing one of
 * its five people would run four phases and look like it worked.
 */
export function designerAgendaFor(team: { readonly seats: readonly DesignerSeatView[] }): AgendaSpec {
  const byKey = new Map<string, string>();
  const missing: string[] = [];
  for (const seat of TEAM_DESIGNER_PLAN.seats) {
    const found = designerSeatOf(team.seats, seat);
    if (found === undefined) missing.push(seat.displayName);
    else byKey.set(seat.key, found.seatId);
  }
  if (missing.length > 0) {
    throw new Error(
      `这支团队里没有${missing.map((name) => `「${name}」`).join("、")}，放不了组队议程——` +
        `它不是一支组队团队，或者名册被改过了。要新建一支：/squad-design <空文件夹>`,
    );
  }
  return resolveOpeningAgenda(TEAM_DESIGNER_PLAN, byKey);
}

/** Whether this roster is a designer team's — asked of the same function that seats its agenda. */
export function isDesignerTeam(team: { readonly seats: readonly DesignerSeatView[] }): boolean {
  try {
    designerAgendaFor(team);
    return true;
  } catch {
    return false;
  }
}

/** What the window shows for one secretary reply that looks like a plan. */
export type PlanOffer =
  | { readonly entryId: string; readonly ok: true }
  | { readonly entryId: string; readonly ok: false; readonly detail: string };

export interface Designer {
  /** Build the designer team itself in an empty folder. */
  createDesignerTeam(projectFolder: string): Instantiated;
  /** Is this a designer team, and which of its secretary's replies are plans (buildable, or refused with why). */
  status(teamId: string): { readonly designer: boolean; readonly plans: readonly PlanOffer[] };
  /** The plan in one secretary reply, checked. */
  preview(teamId: string, entryId: string): TeamPlan;
  /**
   * Build the plan in one secretary reply. `edited` is the host's edit of it —
   * checked whole again, and both fingerprints go into the audit.
   */
  build(
    teamId: string,
    entryId: string,
    projectFolder: string,
    edited?: unknown,
  ): Instantiated & { readonly plan: TeamPlan };
  /** Ask the secretary for the plan again, carrying the shape and the host's note. */
  redraft(teamId: string, note: string): void;
  /** Put the five phases up again, as a draft. */
  placeAgenda(teamId: string): void;
  /** Bring the five seats' prompts up to the current seed. Returns the names refreshed. */
  refresh(teamId: string): readonly string[];
}

/**
 * The designer, on the table and the agent library.
 *
 * Its own module rather than inside the table: it is a USER of the table —
 * everything it does (write templates, create a team, put up a draft, say
 * something to a secretary) is something a person could do by hand, and
 * keeping it on the far side of the table's interface keeps it that way.
 */
export function createDesigner(deps: { readonly table: Table; readonly agents: Library["agents"] }): Designer {
  const { table, agents } = deps;
  const summaryOf = (teamId: string) => {
    const found = table.list().teams.find((team) => team.teamId === teamId);
    if (found === undefined) throw new Error(`没有这支团队：${teamId}。`);
    return found;
  };
  const secretaryOf = (teamId: string) => summaryOf(teamId).seats.find((seat) => seat.isSecretary);

  /** The secretary's own replies, with ids — a plan is only ever read from these. */
  const secretaryLines = (teamId: string): readonly PlanSourceLine[] => {
    const secretary = secretaryOf(teamId);
    if (secretary === undefined) return [];
    return table
      .transcript(teamId)
      .filter((line) => line.kind === "seat" && line.seatId === secretary.seatId && line.failed !== true)
      .map((line) => ({ speaker: line.speaker, text: line.text, entryId: line.entryId }));
  };

  const lineOf = (teamId: string, entryId: string): PlanSourceLine => {
    const line = table.transcript(teamId).find((one) => one.entryId === entryId);
    if (line === undefined) throw new Error("找不到这条回复。");
    const secretary = secretaryOf(teamId);
    if (secretary === undefined || line.kind !== "seat" || line.seatId !== secretary.seatId) {
      throw new Error(`只能按秘书自己写的方案建团，这条是${line.speaker}说的。`);
    }
    return { speaker: line.speaker, text: line.text, entryId: line.entryId };
  };

  /**
   * The team already living in this folder, if there is one.
   *
   * A folder is a WORKSPACE, and a workspace is where one team lives. Two
   * teams pointed at one folder do not fail — they share a discussions folder
   * and a project memory file, and from then on neither can say which writes
   * were its own. Refused here rather than at `teams.create`, which a person
   * may use on purpose to seat a second table in a folder.
   */
  const occupantOf = (folder: string): string | undefined => {
    let wanted: string;
    try {
      wanted = realpathSync.native(folder.trim());
    } catch {
      return undefined; // the table refuses a folder that does not exist, in its own words
    }
    // Case-folded: on Windows one folder spelled in two cases is still one folder.
    return table.list().teams.find((team) => team.projectFolder.toLowerCase() === wanted.toLowerCase())?.displayName;
  };

  /**
   * Build the team a plan describes.
   *
   * Order is forced: a seat is created FROM a template, so the library is
   * written first. Which means creation can fail with templates already on
   * disk. Nothing is rolled back — a template is a useful leftover, while a
   * rollback is a delete, and deleting reaches things that may already be
   * referenced. What is owed instead is VISIBILITY: the error names the
   * templates that were created, so 「部分成功」 never reads as 「什么都没发生」.
   */
  const instantiate = (
    plan: TeamPlan,
    projectFolder: string,
    origin: string,
    author: DraftAuthor = "plan-opening",
  ): Instantiated => {
    checkedPlan(plan, "这份团队方案还不能落地");
    const occupant = occupantOf(projectFolder);
    if (occupant !== undefined) {
      throw new Error(
        `「${occupant}」已经住在 ${projectFolder} 了。一个文件夹是一支团队的家——` +
          `两支团队挤在一个文件夹里，记录和项目说明文件就分不清是谁的。请换一个空文件夹。`,
      );
    }
    const hash = planHash(plan);
    const templates = templatesFor(plan, (id) => agents.get(id) !== undefined);
    const written: string[] = [];
    try {
      for (const template of templates) {
        agents.save(template);
        written.push(template.templateId);
      }
      const { teamId } = table.create({
        displayName: plan.teamName.trim(),
        projectFolder,
        members: templates.map((template, index) => ({
          templateId: template.templateId,
          ...(plan.seats[index]?.key === plan.secretaryKey ? { isSecretary: true } : {}),
        })),
      });
      // Said where decisions are kept: which plan this team is, so 「落地的是
      // 不是我确认的那一份」 stays answerable after everybody has forgotten.
      table.note(teamId, "team-origin", `${origin}，方案指纹 ${shortHash(hash)}；Agent 库新增 ${written.join("、")}。`);

      // Matched by template id rather than by position. Seat ids are minted by
      // the table, and a mapping that assumes `seat-${index+1}` would keep
      // working right up until that minting changes — then quietly address
      // every task to the wrong person.
      const seats = summaryOf(teamId).seats;
      const seatIdByKey = new Map<string, string>();
      plan.seats.forEach((seat, index) => {
        const found = seats.find((one) => one.templateId === templates[index]?.templateId);
        if (found !== undefined) seatIdByKey.set(seat.key, found.seatId);
      });
      // A DRAFT, never confirmed. The host approved a roster; whether the first
      // meeting runs this way is the second decision.
      table.setDraft(teamId, resolveOpeningAgenda(plan, seatIdByKey), { author });
      return { teamId, templateIds: written, hash };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (written.length === 0) throw error instanceof Error ? error : new Error(reason, { cause: error });
      throw new Error(
        `${reason}\n\n已经建好的 Agent 没有回滚，它们还在 Agent 库里：${written.join("、")}。` +
          `（方案指纹 ${shortHash(hash)}）`,
        { cause: error },
      );
    }
  };

  return {
    createDesignerTeam: (projectFolder) =>
      instantiate(TEAM_DESIGNER_PLAN, projectFolder, "按内置的组队团队种子建团", "designer-seed"),

    status: (teamId) => {
      const designer = isDesignerTeam(summaryOf(teamId));
      const plans: PlanOffer[] = [];
      for (const line of secretaryLines(teamId)) {
        // Prefiltered on two field names before anything is parsed: this runs
        // whenever the team changes, and parsing a whole transcript to answer
        // 「没有」 would pay for the common case to serve the rare one.
        if (!line.text.includes('"seats"') || !line.text.includes('"secretaryKey"')) continue;
        try {
          planFromReply(line.text);
          plans.push({ entryId: line.entryId, ok: true });
        } catch (error) {
          // Reported, not swallowed: no offer AND no reason reads as a feature
          // that was never built.
          plans.push({
            entryId: line.entryId,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { designer, plans };
    },

    preview: (teamId, entryId) => planFromReply(lineOf(teamId, entryId).text),

    build: (teamId, entryId, projectFolder, edited) => {
      // Read out of the RECORD, from the exact reply the host was looking at —
      // not re-generated, and not 「the latest」: a reply that arrived while the
      // card was open must not be the thing that gets built.
      const proposed = planFromReply(lineOf(teamId, entryId).text);
      // An edit goes through the same strict schema and the same checks as
      // anything a model wrote: a form can produce a roster that cannot be
      // built just as well as a model can.
      const plan = edited === undefined ? proposed : checkedPlan(parseTeamPlan(edited), "改过的方案还不能落地");
      const from = summaryOf(teamId).displayName;
      const changed = planHash(plan) !== planHash(proposed);
      const origin = changed
        ? `按「${from}」秘书的方案、经主持人修改后建团（原方案指纹 ${shortHash(planHash(proposed))}）`
        : `按「${from}」秘书的方案建团`;
      return { ...instantiate(plan, projectFolder, origin), plan };
    },

    redraft: (teamId, note) => {
      // Not a plain message typed at the secretary: it is under standing orders
      // never to invent the schema, so 「重出一份」 alone is refused — rightly,
      // it has nothing to write against. The shape lives in code and every
      // request for a plan carries it.
      const secretary = secretaryOf(teamId);
      if (secretary === undefined) throw new Error("这支团队没有秘书，出不了方案。");
      table.say(teamId, `@${secretary.displayName} ${redraftPlanInstruction(note)}`, [], [], "plan-redraft");
    },

    placeAgenda: (teamId) => {
      table.setDraft(teamId, designerAgendaFor(summaryOf(teamId)), { author: "designer-seed" });
    },

    refresh: (teamId) => {
      const team = summaryOf(teamId);
      if (team.busy) throw new Error("这支团队正在跑，先等它停下来。");
      const refreshed: AgentTemplate[] = [];
      for (const seed of TEAM_DESIGNER_PLAN.seats) {
        const seat = designerSeatOf(team.seats, seed);
        if (seat === undefined) continue;
        // The library entry first, then the seat. The other order would leave
        // a seat pointing at text the library no longer has.
        const templateId = seat.templateId ?? templateIdFor(seed.key, planHash(TEAM_DESIGNER_PLAN), () => false);
        const existing = agents.get(templateId);
        const template: AgentTemplate = {
          ...existing,
          templateId,
          displayName: seed.displayName,
          role: seed.role,
          systemPrompt: seed.systemPrompt,
          // The host's own choices are kept. Which model this seat runs on,
          // what it may spend, whether it reaches the web — those were set for
          // a reason, and a prompt update is not the moment to reset them.
          backend: existing?.backend ?? seed.backend,
          secretaryCandidate: seed.key === TEAM_DESIGNER_PLAN.secretaryKey ? true : seed.secretaryCandidate,
          color: existing?.color ?? seed.color ?? "#8A8A8A",
          enabled: true,
        };
        agents.save(template);
        if (seat.templateId === undefined) table.relinkSeat(teamId, seat.seatId, templateId);
        refreshed.push(template);
      }
      // Seats are COPIES of their library entry; this carries the new text into
      // every team sitting it, through the same path a hand edit in the agent
      // library takes — so a refresh goes through exactly those checks.
      const refused = refreshed.flatMap((template) => table.syncTemplate(template));
      if (refused.length > 0) throw new Error(refused.join("\n"));
      return refreshed.map((template) => template.displayName);
    },
  };
}
