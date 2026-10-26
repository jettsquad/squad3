/**
 * slash.ts — running a slash command typed into the box.
 *
 * The result is shown to the person and not written into the team's record:
 * a command is the host operating the table, not something anyone said.
 */
import { parseNewTeam, parseSay } from "../../shared/parse.ts";
import { parseSlash } from "../../shared/slash.ts";
import type { TeamSummary } from "../../shared/wire.ts";
import { call } from "./api.ts";

export interface SlashOutcome {
  /** Text to show above the box, when the command produced any. */
  readonly show?: string | undefined;
  /** A team to switch to. */
  readonly select?: string | undefined;
}

/** `undefined` when the text is not a slash command and should go to the team as written. */
export async function runSlash(
  text: string,
  team: TeamSummary,
  teams: readonly TeamSummary[],
): Promise<SlashOutcome | undefined> {
  const parsed = parseSlash(text);
  if (parsed.kind === "none") return undefined;
  if (parsed.kind === "unknown") throw new Error(`没有 /${parsed.name} 这条命令。输入 / 看看有哪些。`);
  const { spec, args } = parsed;
  if (spec.later !== undefined) return { show: `/${spec.name}（${spec.summary}）在阶段 ${spec.later} 接入。` };
  const names = team.seats.map((seat) => seat.displayName);

  switch (spec.name) {
    case "squad-say": {
      const say = parseSay(args, names);
      // Into the same `@` form the box uses, so one sentence addresses the same
      // seats whichever way it was typed (2.x parse.ts).
      const text =
        say.named.length === 0
          ? say.instruction
          : `${say.named.map((name) => `@${name}`).join(" ")} ${say.instruction}`;
      await call("round.say", { teamId: team.teamId, text });
      return {};
    }
    case "squad-record": {
      const { lines, earlier } = await call("teams.transcript", { teamId: team.teamId, limit: 500 });
      const spoken = lines
        .filter((line) => line.kind !== "checkpoint")
        .map((line) => `【${line.speaker}】${line.text}`);
      if (spoken.length === 0) return { show: "记录是空的。" };
      // Said, not dropped: a record that starts mid-discussion reads as the whole one.
      const head = earlier > 0 ? `（前面还有 ${earlier} 条，完整副本在项目的 .squad/discussions 里。）\n\n` : "";
      return { show: head + spoken.join("\n\n") };
    }
    case "squad-window": {
      const window = await call("teams.window", { teamId: team.teamId, seatName: args });
      return {
        show:
          window.lines.length === 0
            ? `${window.seatName} 这一轮看不到任何上下文（第一轮就是这样）。`
            : `${window.seatName} 新开会话时会看到 ${window.lines.length} 行：\n\n${window.lines.join("\n")}`,
      };
    }
    case "squad-fold": {
      const before = await call("context.state", { teamId: team.teamId });
      await call("context.fold", { teamId: team.teamId });
      return {
        show: `已折叠（折叠前累计约 ${before.accumulated} / 上限 ${before.limit} token）。检查点在右边的上下文面板里。`,
      };
    }
    case "squad-teams": {
      if (args === "") {
        // A team with several sessions lists each, so 「→」 says which one you are in.
        return {
          show: teams
            .map(
              (one) =>
                `${one.teamId === team.teamId ? "→" : "  "} ${one.displayName}${one.sessionCount > 1 ? ` · ${one.sessionLabel}` : ""}`,
            )
            .join("\n"),
        };
      }
      const target = teams.find((one) => one.displayName === args || one.teamId === args);
      if (target === undefined) throw new Error(`没有叫「${args}」的团队。`);
      return { select: target.teamId };
    }
    case "squad-new": {
      const input = parseNewTeam(args);
      const created = await call("teams.create", {
        displayName: input.displayName,
        projectFolder: input.projectFolder,
        // The command's grammar names seats and roles only, so they sit on
        // the host's own Claude Code login; the form builds from the agent
        // library when a seat should say more (2.x createTeamFrom).
        seats: input.seats.map((seat) => ({
          displayName: seat.displayName,
          role: seat.role,
          systemPrompt: `你的角色是${seat.role}。回答简明，有依据。`,
          backend: "claude-code" as const,
          isSecretary: seat.isSecretary,
        })),
      });
      return { select: created.teamId, show: `已建团队「${input.displayName}」。` };
    }
    // 移植自 Squad 2.x packages/console/src/index.ts（squad-design/build）@ 8e96d9c
    case "squad-design": {
      // Empty means 「this table again」: the five phases are not a decision,
      // they are the same every time — but running them still is one.
      if (args === "") {
        await call("designer.agenda", { teamId: team.teamId });
        return { show: `已经给「${team.displayName}」放了一份组队议程草案（五个阶段），还没确认。确认了就开始。` };
      }
      const built = await call("designer.create", { projectFolder: args });
      return {
        select: built.teamId,
        show:
          `已建「组队团队」，Agent 库新增：${built.templateIds.join("、")}；方案指纹 ${built.hash.slice(0, 12)}。\n` +
          "五阶段议程已经作为草案放好了（不是确认——第一场怎么开是你的第二个决定）。",
      };
    }
    case "squad-build": {
      if (args === "") throw new Error("要给一个项目文件夹的绝对路径，新团队在那里工作。");
      // Read out of the record, not re-generated: running the plan through a
      // model again would be a second chance to change what is being approved.
      const { plans } = await call("designer.status", { teamId: team.teamId });
      const offer = plans.findLast((plan) => plan.ok) ?? plans.at(-1);
      if (offer === undefined) throw new Error("秘书还没有给出过团队方案。先把议程跑到「成稿」那一阶段。");
      if (!offer.ok) throw new Error(`秘书最近的方案还不能落地：\n\n${offer.detail}`);
      const { plan } = await call("designer.preview", { teamId: team.teamId, entryId: offer.entryId });
      const built = await call("designer.build", { teamId: team.teamId, entryId: offer.entryId, projectFolder: args });
      return {
        select: built.teamId,
        show:
          `已建「${plan.teamName}」：${plan.seats.map((seat) => `${seat.displayName}（${seat.role}）`).join("、")}。\n` +
          `方案指纹 ${built.hash.slice(0, 12)}。` +
          (plan.risks.length === 0 ? "" : `\n红队留下的风险：\n${plan.risks.map((risk) => `  · ${risk}`).join("\n")}`) +
          "\n首场议程已经作为草案放好了，还没确认。",
      };
    }
    // 移植自 Squad 2.x packages/console/src/index.ts（squad-criteria/accept/reject）@ 8dcb903
    case "squad-criteria": {
      const { live, pending } = await call("criteria.list", {});
      const lines = [`已生效 ${live.length} 条，待你裁定 ${pending.length} 条。`];
      for (const criterion of live) lines.push(`  ✓ ${criterion.claim}`);
      for (const proposal of pending) lines.push(`  ? ${proposal.id}  ${proposal.claim}`);
      if (pending.length > 0) lines.push("", "裁定：/squad-accept <id> 或 /squad-reject <id>");
      return { show: lines.join("\n") };
    }
    case "squad-accept":
    case "squad-reject": {
      if (args === "") throw new Error("要给一个判据 id。先看 /squad-criteria");
      const verdict = spec.name === "squad-accept" ? "accept" : "reject";
      await call("criteria.resolve", { id: args, verdict });
      return { show: verdict === "accept" ? `已采纳 ${args}。` : `已否掉 ${args}。` };
    }
    default:
      return { show: `/${spec.name} 还没有接上。` };
  }
}
