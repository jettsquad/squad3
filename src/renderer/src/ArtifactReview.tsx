import { useState, type JSX } from "react";
import type { MethodInput, MethodOutput, TeamSummary } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { t } from "./locale.ts";

type Comment = MethodInput<"artifacts.feedback">["comments"][number];
type Snapshot = MethodOutput<"artifacts.read"> & { path: string };

export function ArtifactReview({ team }: { team: TeamSummary }): JSX.Element {
  const [paths, setPaths] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [comments, setComments] = useState<Comment[]>([]);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [seatId, setSeatId] = useState("");
  const [sent, setSent] = useState(false);
  const action = useAction();
  const teamId = team.teamId;
  const lines = snapshot?.text.split(/\r?\n/) ?? [];
  const end = to === "" ? from : Number(to);
  const valid =
    Number.isInteger(from) &&
    Number.isInteger(end) &&
    from >= 1 &&
    end >= from &&
    end <= lines.length &&
    end - from < 20 &&
    note.trim() !== "";

  return (
    <details className="card">
      <summary>{t("产物审阅")}</summary>
      <button
        type="button"
        disabled={action.busy}
        onClick={() => void action.run(async () => setPaths((await call("artifacts.list", { teamId })).paths))}
      >
        {t("列出报告和议程产物")}
      </button>
      {paths.length > 0 && (
        <select
          aria-label={t("已知产物")}
          value={paths.includes(path) ? path : ""}
          onChange={(e) => setPath(e.target.value)}
        >
          <option value="">{t("选择产物")}</option>
          {paths.map((file) => (
            <option key={file}>{file}</option>
          ))}
        </select>
      )}
      <div className="seat-row">
        <input
          value={path}
          aria-label={t("项目相对路径")}
          placeholder={t("项目相对路径")}
          onChange={(e) => setPath(e.target.value)}
        />
        <button
          type="button"
          disabled={action.busy || path.trim() === ""}
          onClick={() => {
            const filename = path.trim();
            void action.run(async () => {
              const loaded = await call("artifacts.read", { teamId, path: filename });
              setSnapshot({ ...loaded, path: filename });
              setComments((old) => (snapshot?.path === filename && snapshot.version === loaded.version ? old : []));
              setSent(false);
            });
          }}
        >
          {t("打开产物")}
        </button>
      </div>
      {snapshot && (
        <fieldset disabled={action.busy}>
          <legend>{snapshot.path}</legend>
          <pre className="review-text">{lines.map((line, index) => `${index + 1}  ${line}`).join("\n")}</pre>
          <div className="seat-row">
            <label>
              {t("起始行")}{" "}
              <input
                type="number"
                min={1}
                max={lines.length}
                value={from}
                onChange={(e) => setFrom(e.target.valueAsNumber || 0)}
              />
            </label>
            <label>
              {t("结束行")}{" "}
              <input
                type="number"
                min={from}
                max={lines.length}
                value={to}
                placeholder={String(from)}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <textarea
            aria-label={t("审阅意见")}
            placeholder={t("审阅意见")}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            disabled={!valid || comments.length >= 20}
            onClick={() => {
              setComments([...comments, { from, to: end, note: note.trim() }]);
              setNote("");
              setSent(false);
            }}
          >
            {t("添加批注")}
          </button>
          {comments.map((comment, index) => (
            <p key={index}>
              {comment.from}–{comment.to} · {comment.note}{" "}
              <button
                type="button"
                className="link"
                onClick={() => setComments(comments.filter((_, i) => index !== i))}
              >
                {t("移除")}
              </button>
            </p>
          ))}
          <select aria-label={t("接收批注的席位")} value={seatId} onChange={(e) => setSeatId(e.target.value)}>
            <option value="">{t("选择席位")}</option>
            {team.seats.map((seat) => (
              <option key={seat.seatId} value={seat.seatId}>
                {seat.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!team.seats.some((seat) => seat.seatId === seatId) || !comments.length}
            onClick={() => {
              void action.run(async () => {
                await call("artifacts.feedback", {
                  teamId,
                  seatId,
                  path: snapshot.path,
                  version: snapshot.version,
                  comments,
                });
                setComments([]);
                setSent(true);
              });
            }}
          >
            {t("发送批注")}
          </button>
        </fieldset>
      )}
      {sent && <p>{t("批注已发到讨论。")}</p>}
      {action.error && <p className="error">{action.error}</p>}
    </details>
  );
}
