// 移植自 Squad 2.x packages/console/test/agenda-text.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { agendaInText } from "../src/renderer/src/agenda-text.ts";

const agenda = {
  hostGoal: "写第二章",
  phases: [
    { id: "setup", title: "建文件夹", tasks: [{ seatId: "蓝领", instruction: "建目录\n不改旧文件" }] },
    {
      id: "draft",
      title: "初稿",
      needs: ["setup"],
      tasks: [{ seatId: "文曲星", instruction: "写", artifactPath: "a.md" }],
      check: { command: "test -s a.md" },
    },
  ],
};

describe("议程消息里找出议程", () => {
  it("前面有话、后面是围栏里的 JSON：话留着，议程取出来", () => {
    const text = `我已确认大纲。下面是议程。\n\n\`\`\`json\n${JSON.stringify(agenda, null, 2)}\n\`\`\`\n\n请确认。`;
    const found = agendaInText(text);
    expect(found?.before).toBe("我已确认大纲。下面是议程。");
    expect(found?.after).toBe("请确认。");
    expect(found?.agenda.phases.map((phase) => phase.title)).toEqual(["建文件夹", "初稿"]);
    expect(found?.agenda.phases[0]?.tasks[0]?.instruction).toBe("建目录\n不改旧文件");
  });

  it("整条消息就是 JSON（秘书草拟时的样子）", () => {
    const found = agendaInText(JSON.stringify(agenda));
    expect(found?.before).toBe("");
    expect(found?.agenda.hostGoal).toBe("写第二章");
  });

  it("字符串里单个反斜杠（正则）也能读", () => {
    const text = String.raw`{"phases":[{"title":"查","tasks":[{"seatId":"a","instruction":"grep 0\.9"}]}]}`;
    expect(agendaInText(text)?.agenda.phases[0]?.tasks[0]?.instruction).toBe("grep 0\\.9");
  });

  it("括号错了、不是议程的 JSON、没有 JSON：都不处理，照原样显示", () => {
    expect(agendaInText('{"phases":[{"title":"x","tasks":[{"seatId":"a","instruction":"b"}]}')).toBeUndefined();
    expect(agendaInText('{"phases":[{"title":"x"}],"tasks":1}')).toBeUndefined();
    expect(agendaInText('{"seats":[],"phases":"no","tasks":1}')).toBeUndefined();
    expect(agendaInText("普通的一段话")).toBeUndefined();
  });

  it("任务缺指令或席位的不算议程", () => {
    expect(agendaInText('{"phases":[{"title":"x","tasks":[{"seatId":"a"}]}]}')).toBeUndefined();
  });
});
