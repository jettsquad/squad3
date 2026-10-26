/**
 * Voice.tsx — read a reply aloud, pick a seat's voice, dictate into the box.
 *
 * 移植自 Squad 2.x packages/console/src/client/agents.tsx 的 VoicePreview 与声音一栏、
 * discussion.tsx 的 SpeakButton @ 8e96d9c
 * 改动：合成用的连接与语速在设置页（listen.tsx 的 ListenBar 挪了过去）；错误跟着那条消息显示。
 * 听写是 3 新写的（2.x 的 dictate.tsx 用 Web Speech，Electron 里用不了，设计文档 Q3）：
 * 录一段音，交给设置里选的语音转文字连接，文字填进输入框——只填不发。
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { defaultVoiceFor, MINIMAX_VOICES, voiceLabel, voicesFor, voicesOf } from "../../shared/voices.ts";
import { t } from "./locale.ts";
import { speech, type SpeechState } from "./speech.ts";
import { api } from "./speech-api.ts";

function useSpeech(): SpeechState {
  const [state, setState] = useState(speech.state());
  useEffect(() => {
    return speech.subscribe(setState);
  }, []);
  return state;
}

/**
 * Read one reply aloud.
 *
 * Per message rather than a switch over the whole discussion: a global
 * auto-read decides for you which answers are worth hearing, and pays for all
 * of them to find out. Here the cost is one click on the one you want.
 */
export function SpeakButton(props: {
  readonly entryId: string;
  readonly speaker: string;
  readonly text: string;
  readonly voiceId: string;
}): JSX.Element {
  const state = useSpeech();
  const [unset, setUnset] = useState(false);
  const playing = state.turnId === props.entryId;
  const held = playing && state.paused;
  return (
    <>
      {/* Two controls while a reply is being read, because holding it and
          ending it are different intentions and only one of them is cheap to
          undo: stopping discards the position AND the synthesis paid for so far.
          Clickable before read-aloud is set up: a greyed-out ▶ with the reason
          only in a tooltip read as "there is no read-aloud" (2026-10-22). */}
      <button
        type="button"
        className="link"
        title={
          !speech.ready
            ? t("先在设置里选一个朗读用的连接")
            : !playing
              ? t("念这一条")
              : held
                ? t("从暂停的地方接着念")
                : t("暂停，位置留着")
        }
        onClick={() => {
          if (!speech.ready) {
            setUnset((shown) => !shown);
            return;
          }
          if (!playing)
            void speech.play({
              turnId: props.entryId,
              speaker: props.speaker,
              text: props.text,
              voiceId: props.voiceId,
            });
          else speech.togglePause();
        }}
      >
        {!playing ? t("▶ 念") : `${held ? "▶" : "⏸"} ${state.chunk}/${state.chunks}`}
      </button>
      {playing && (
        <button
          type="button"
          className="link"
          title={t("停下并回到开头——再念要从头合成一遍")}
          onClick={() => speech.stop()}
        >
          ■
        </button>
      )}
      {unset && !speech.ready && (
        <span className="notice inline-hint">
          {t("朗读还没设置：要一个填好密钥的 MiniMax 连接，在设置里选上。")}{" "}
          <button type="button" className="link" onClick={() => openPage("settings")}>
            {t("去设置")}
          </button>
        </span>
      )}
      {state.failedTurnId === props.entryId && state.error !== undefined && (
        <span className="error inline">{state.error}</span>
      )}
    </>
  );
}

/** Ask the workbench to show one of its pages (App listens). */
export function openPage(kind: "settings" | "connections"): void {
  window.dispatchEvent(new CustomEvent("squad:open-page", { detail: kind }));
}

/** English voices whose id does not start with `English`. */
const ENGLISH_ONLY = new Set(voicesFor("en").map((voice) => voice.voiceId));
/** Every id the list offers, for telling a listed voice from a typed one. */
const KNOWN = new Set(MINIMAX_VOICES.map((voice) => voice.voiceId));
const CUSTOM = "__custom__";

export function VoicePreview(props: { readonly voiceId: string; readonly name: string }): JSX.Element {
  const state = useSpeech();
  const turnId = `preview-${props.voiceId}`;
  const playing = state.turnId === turnId;
  return (
    <>
      <button
        type="button"
        disabled={!speech.ready}
        title={speech.ready ? t("念一句试试") : t("先在设置里选一个朗读用的连接")}
        onClick={() =>
          void speech.play({
            turnId,
            speaker: props.name,
            text:
              props.voiceId.startsWith("English") || ENGLISH_ONLY.has(props.voiceId)
                ? "This is my voice. I will sound like this whenever I speak."
                : "这是我的声音，之后我说的话都会是这个调子。",
            voiceId: props.voiceId,
          })
        }
      >
        {playing ? t("■ 停") : t("▶ 试听")}
      </button>
      {state.failedTurnId === turnId && state.error !== undefined && (
        <span className="error inline">{state.error}</span>
      )}
    </>
  );
}

/**
 * A list AND a box. The list is every system voice; the box is for the ones
 * no list can have — a voice you cloned, or one MiniMax added after this
 * build. The id is passed through untouched all the way to synthesis.
 */
export function VoicePicker(props: {
  readonly value: string;
  readonly name: string;
  readonly onChange: (voiceId: string) => void;
}): JSX.Element {
  const typed = props.value !== "" && !KNOWN.has(props.value);
  const effective = props.value.trim() === "" ? defaultVoiceFor(props.name || t("这个席位")) : props.value.trim();
  return (
    <>
      <div className="row-gap">
        <select
          value={typed ? CUSTOM : props.value}
          onChange={(event) => props.onChange(event.target.value === CUSTOM ? " " : event.target.value)}
        >
          <option value="">
            {t("按名字自动分配（{voice}）", { voice: voiceLabel(defaultVoiceFor(props.name || t("这个席位"))) })}
          </option>
          {/* Grouped, because fifty in one flat list is a list nobody reads to
              the end. Nothing is hidden — MiniMax will read either language in
              any of these. */}
          {(
            [
              [t("中文"), "zh", "plain"],
              [t("中文 · 角色音"), "zh", "character"],
              ["English", "en", "plain"],
            ] as const
          ).map(([label, language, kind]) => (
            <optgroup key={label} label={label}>
              {voicesOf(language, kind).map((voice) => (
                <option key={voice.voiceId} value={voice.voiceId}>
                  {voice.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>{t("自己填一个 voice_id…")}</option>
        </select>
        <VoicePreview voiceId={effective} name={props.name || t("这个席位")} />
      </div>
      {typed && (
        <>
          <input
            placeholder={t("MiniMax 的 voice_id，比如你复刻出来的那个")}
            value={props.value.trim()}
            onChange={(event) => props.onChange(event.target.value)}
          />
          <p className="muted">
            {t("原样发给 MiniMax。写错了不会在这里被拦下——合成那一刻它会把 MiniMax 的原话报出来。")}
          </p>
        </>
      )}
    </>
  );
}

/** The recorder kinds to try, best first; the first one this build supports is used. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

/**
 * The microphone next to the send button. It fills the box; it never sends.
 *
 * Recognition mishears exactly the words this product is full of — seat names,
 * 「MiniMax」, 「seatKey」 — and a round costs real money, so 「说完自动发」
 * would spend it on an instruction nobody checked.
 */
export function Dictate(props: {
  readonly configured: boolean;
  readonly onText: (text: string) => void;
}): JSX.Element | null {
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const recorder = useRef<MediaRecorder | undefined>(undefined);

  // Released when the composer goes away: a recorder left running holds the
  // microphone open after nothing is listening to it.
  useEffect(() => {
    return () => {
      const held = recorder.current;
      recorder.current = undefined;
      if (held !== undefined && held.state !== "inactive") held.stop();
      held?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const start = async (): Promise<void> => {
    setError(undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (problem) {
      const name = problem instanceof DOMException ? problem.name : "";
      setError(
        name === "NotAllowedError"
          ? t("麦克风被拒绝了——系统设置里允许 Squad 使用麦克风后再试。")
          : name === "NotFoundError"
            ? t("没找到麦克风。")
            : t("打不开麦克风：{error}", { error: problem instanceof Error ? problem.message : String(problem) }),
      );
      return;
    }
    const mimeType = RECORDING_TYPES.find((kind) => MediaRecorder.isTypeSupported(kind)) ?? "";
    const made = new MediaRecorder(stream, mimeType === "" ? undefined : { mimeType });
    const parts: Blob[] = [];
    made.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    made.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (recorder.current !== made) return; // unmounted: nobody is waiting for the text
      recorder.current = undefined;
      setState("sending");
      void api
        .transcribe(new Blob(parts, { type: made.mimeType }))
        .then(
          (text) => {
            if (text === "") setError(t("没听出文字。"));
            else props.onText(text);
          },
          (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)),
        )
        .finally(() => setState("idle"));
    };
    recorder.current = made;
    made.start();
    setState("recording");
  };

  return (
    <>
      <button
        type="button"
        disabled={!props.configured || state === "sending"}
        title={
          !props.configured
            ? t("先在设置里选一个听写用的连接")
            : state === "recording"
              ? t("停止，转成文字")
              : t("说话，转成文字填进输入框（不会自动发送）")
        }
        onClick={() => {
          if (state === "recording") recorder.current?.stop();
          else void start();
        }}
      >
        {state === "recording" ? t("● 停止听写") : state === "sending" ? t("转文字中…") : t("🎤 说")}
      </button>
      {error !== undefined && <span className="error inline">{error}</span>}
    </>
  );
}
