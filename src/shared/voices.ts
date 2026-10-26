// 移植自 Squad 2.x packages/shared/src/voices.ts @ 8e96d9c
/**
 * voices.ts — the voices a seat can be given.
 *
 * MiniMax's system voices, as a list you pick from. The Chinese half is the
 * whole published catalogue minus the eight `-beta` duplicates of voices
 * already here; the English half is what the docs enumerate.
 *
 * ORDER is what makes fifty of them usable. The ones a working roster wants
 * come first; the character voices sit below, and the automatic assignment
 * never reaches them — a seat nobody configured should not turn out to be a
 * cartoon pig.
 *
 * The ids are MiniMax's own and are passed through untouched — a voice this
 * list does not name still works if it is typed in, and one MiniMax retires
 * fails at synthesis with their own message rather than being silently
 * swapped for a default.
 */
export interface VoiceOption {
  readonly voiceId: string;
  readonly label: string;
  /**
   * Which language this voice is FOR.
   *
   * Not a filter — MiniMax will read Chinese in an English voice and the
   * result is intelligible but wrong-sounding — but a grouping, so a roster
   * that works in English is not picked out of a list where every second
   * entry is unusable for it.
   */
  readonly language: "zh" | "en";
  /**
   * Whether it suits ordinary work.
   *
   * `character` voices are real and occasionally right, but 「卡通猪小琪」
   * reading a risk analysis is a joke that stops being funny on the second
   * round. Separated rather than removed: it is the user's roster.
   */
  readonly kind: "plain" | "character";
}

export const MINIMAX_VOICES: readonly VoiceOption[] = [
  // 中文 · 常用。Ordered so the ones a working roster wants are first: a
  // list of fifty is only navigable if the top of it is the answer most of
  // the time.
  { voiceId: "Chinese (Mandarin)_Gentleman", label: "温润男声", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_News_Anchor", label: "新闻女声", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Reliable_Executive", label: "沉稳高管", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Wise_Women", label: "阅历姐姐", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Radio_Host", label: "电台男主播", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Male_Announcer", label: "播报男声", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Lyrical_Voice", label: "抒情男声", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Sweet_Lady", label: "甜美女声", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Gentle_Youth", label: "温润青年", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Sincere_Adult", label: "真诚青年", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Unrestrained_Young_Man", label: "不羁青年", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Southern_Young_Man", label: "南方小哥", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Warm_Bestie", label: "温暖闺蜜", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Warm_Girl", label: "温暖少女", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Crisp_Girl", label: "清脆少女", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Soft_Girl", label: "软软女孩", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Gentle_Senior", label: "温柔学姐", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Mature_Woman", label: "傲娇御姐", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Humorous_Elder", label: "搞笑大爷", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Kind-hearted_Elder", label: "花甲奶奶", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Kind-hearted_Antie", label: "热心大婶", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_HK_Flight_Attendant", label: "港普空姐", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Straightforward_Boy", label: "率真弟弟", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Stubborn_Friend", label: "嘴硬竹马", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Pure-hearted_Boy", label: "清澈邻家弟弟", language: "zh", kind: "plain" },
  { voiceId: "Chinese (Mandarin)_Cute_Spirit", label: "憨憨萌兽", language: "zh", kind: "plain" },
  { voiceId: "male-qn-jingying", label: "精英青年", language: "zh", kind: "plain" },
  { voiceId: "male-qn-qingse", label: "青涩青年", language: "zh", kind: "plain" },
  { voiceId: "male-qn-badao", label: "霸道青年", language: "zh", kind: "plain" },
  { voiceId: "male-qn-daxuesheng", label: "青年大学生", language: "zh", kind: "plain" },
  { voiceId: "female-yujie", label: "御姐", language: "zh", kind: "plain" },
  { voiceId: "female-chengshu", label: "成熟女性", language: "zh", kind: "plain" },
  { voiceId: "female-tianmei", label: "甜美女性", language: "zh", kind: "plain" },
  { voiceId: "female-shaonv", label: "少女", language: "zh", kind: "plain" },

  // 中文 · 角色。Real voices, and occasionally the right answer — but a
  // 「病娇弟弟」 reading a risk analysis is a joke that stops being funny on
  // the second round, so they are kept below rather than mixed in.
  { voiceId: "junlang_nanyou", label: "俊朗男友", language: "zh", kind: "character" },
  { voiceId: "badao_shaoye", label: "霸道少爷", language: "zh", kind: "character" },
  { voiceId: "lengdan_xiongzhang", label: "冷淡学长", language: "zh", kind: "character" },
  { voiceId: "chunzhen_xuedi", label: "纯真学弟", language: "zh", kind: "character" },
  { voiceId: "bingjiao_didi", label: "病娇弟弟", language: "zh", kind: "character" },
  { voiceId: "wumei_yujie", label: "妩媚御姐", language: "zh", kind: "character" },
  { voiceId: "danya_xuejie", label: "淡雅学姐", language: "zh", kind: "character" },
  { voiceId: "diadia_xuemei", label: "嗲嗲学妹", language: "zh", kind: "character" },
  { voiceId: "qiaopi_mengmei", label: "俏皮萌妹", language: "zh", kind: "character" },
  { voiceId: "tianxin_xiaoling", label: "甜心小玲", language: "zh", kind: "character" },
  { voiceId: "Arrogant_Miss", label: "嚣张小姐", language: "zh", kind: "character" },
  { voiceId: "Robot_Armor", label: "机械战甲", language: "zh", kind: "character" },
  { voiceId: "clever_boy", label: "聪明男童", language: "zh", kind: "character" },
  { voiceId: "cute_boy", label: "可爱男童", language: "zh", kind: "character" },
  { voiceId: "lovely_girl", label: "萌萌女童", language: "zh", kind: "character" },
  { voiceId: "cartoon_pig", label: "卡通猪小琪", language: "zh", kind: "character" },

  { voiceId: "English_Trustworthy_Man", label: "Trustworthy man", language: "en", kind: "plain" },
  { voiceId: "English_Graceful_Lady", label: "Graceful lady", language: "en", kind: "plain" },
  { voiceId: "English_Insightful_Speaker", label: "Insightful speaker", language: "en", kind: "plain" },
  { voiceId: "English_Persuasive_Man", label: "Persuasive man", language: "en", kind: "plain" },
  { voiceId: "English_Diligent_Man", label: "Diligent man", language: "en", kind: "plain" },
  { voiceId: "English_Gentle-voiced_man", label: "Gentle-voiced man", language: "en", kind: "plain" },
  { voiceId: "English_Aussie_Bloke", label: "Aussie bloke", language: "en", kind: "plain" },
  { voiceId: "English_radiant_girl", label: "Radiant girl", language: "en", kind: "plain" },
  { voiceId: "English_Whispering_girl", label: "Whispering girl", language: "en", kind: "plain" },
  { voiceId: "Serene_Woman", label: "Serene woman", language: "en", kind: "plain" },
  { voiceId: "Charming_Lady", label: "Charming lady", language: "en", kind: "plain" },
  { voiceId: "Sweet_Girl", label: "Sweet girl", language: "en", kind: "plain" },
  { voiceId: "Attractive_Girl", label: "Attractive girl", language: "en", kind: "plain" },
  { voiceId: "Cute_Elf", label: "Cute elf", language: "en", kind: "plain" },
] as const;

/** The voices for one language, for a picker that groups them. */
export const voicesFor = (language: VoiceOption["language"]): readonly VoiceOption[] =>
  MINIMAX_VOICES.filter((voice) => voice.language === language);

/** One language's voices, split by whether they suit ordinary work. */
export const voicesOf = (language: VoiceOption["language"], kind: VoiceOption["kind"]): readonly VoiceOption[] =>
  MINIMAX_VOICES.filter((voice) => voice.language === language && voice.kind === kind);

/**
 * The `language_boost` one voice should be synthesised under.
 *
 * Sent on every request, and the reason is a bug rather than a refinement:
 * with nothing sent, MiniMax auto-detects per request, and `German` is one of
 * the forty values it can land on. A Chinese sentence carrying a formula gave
 * it a run of isolated Latin letters to guess from, and it guessed German —
 * variable names were being read in German out loud.
 *
 * Naming the language takes German out of the running entirely. It follows
 * the VOICE rather than the text because the voice is what the reply's
 * language was chosen for; a formula inside that reply is handled by
 * `spokenMath`, which turns it into English words before it is ever sent.
 *
 * An id this list does not know is matched on MiniMax's own naming, which
 * prefixes its English catalogue — a typed-in voice should not silently fall
 * back to the wrong language.
 */
export const languageBoostFor = (voiceId: string): "Chinese" | "English" => {
  const known = MINIMAX_VOICES.find((voice) => voice.voiceId === voiceId);
  if (known !== undefined) return known.language === "en" ? "English" : "Chinese";
  return /^english/i.test(voiceId.trim()) ? "English" : "Chinese";
};

/** What a voice is called, for a screen. Unknown ids show as themselves. */
export const voiceLabel = (voiceId: string): string =>
  MINIMAX_VOICES.find((voice) => voice.voiceId === voiceId)?.label ?? voiceId;

/**
 * A voice for a seat that has not been given one.
 *
 * Derived from the name rather than assigned at random, so the same member
 * sounds the same every time without anyone configuring anything — and two
 * seats in one team land on different voices far more often than not.
 */
export function defaultVoiceFor(name: string): string {
  // Drawn from the CHINESE voices only. A seat nobody has configured is a
  // seat writing in whatever the team writes in, and that is Chinese here —
  // an English voice reading Chinese is intelligible and unmistakably wrong,
  // which is a bad thing for a default to be.
  const pool = voicesOf("zh", "plain");
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_000;
  return pool[hash % pool.length]?.voiceId ?? "Chinese (Mandarin)_Gentleman";
}
