export type QuestionType =
  | "SINGLE_CHOICE"
  | "MULTIPLE_CHOICE"
  | "TRUE_FALSE"
  | "FILL_BLANK"
  | "SHORT_ANSWER"
  | "UNKNOWN";

export interface StudyOption {
  id: string;
  text: string;
}

export interface StudyBlank {
  id: string;
  label: string;
}

export interface StudyQuestion {
  id: string;
  type: QuestionType;
  stem: string;
  options: StudyOption[];
  blanks: StudyBlank[];
  /** Optional rendered question, without page URLs or account information. */
  imageDataUrl?: string | null;
  /**
   * Optional original-quality images (largest first, at most 2) beyond the composite render.
   * Same data-URL rules as imageDataUrl; attached automatically when text cannot be read,
   * the composite render fails, or the model reports the composite image as unreadable.
   */
  extraImageDataUrls?: string[] | null;
}

export type SourceMode = "PASTE" | "SELECTION" | "ADAPTER";
export type AnswerStatus = "ANSWERED" | "NEEDS_CONTEXT" | "REFUSED";

export interface StudyAnswer {
  status: AnswerStatus;
  selectedOptionIds: string[];
  blankAnswers: { blankId: string; answer: string }[];
  textAnswer: string | null;
  explanation: string;
  caveats: string[];
}

export interface StudyConsent {
  shareQuestionWithSelectedProvider: true;
  privacyVersion: string;
}

export interface AnswerRequest {
  providerProfileId: string;
  expectedProfileVersion: number;
  sourceMode: SourceMode;
  question: StudyQuestion;
  consent: StudyConsent;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AnswerResponse {
  requestId: string;
  questionId: string;
  providerProfileId: string;
  profileVersion: number;
  answer: StudyAnswer;
  structurallyFillable: boolean;
  usage: TokenUsage | null;
  latencyMs: number;
  promptVersion: string;
}
