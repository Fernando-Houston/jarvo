import type { ToolContext } from "../tools/index";

export type BrainEvents = {
  /** Raw streaming text (captions). */
  onTextDelta: (delta: string) => void;
  /** Complete speakable sentence (feed to TTS). */
  onSentence: (sentence: string) => void;
  onTool: (name: string, status: "start" | "end") => void;
};

export type Brain = {
  name: "claude" | "rules";
  run(userText: string, events: BrainEvents, ctx: ToolContext, signal: AbortSignal): Promise<void>;
  reset(): void;
};
