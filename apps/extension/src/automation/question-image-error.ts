import type { TaskQuestion } from "./protocol";

/** A recoverable question image issue, distinct from navigation or control failures. */
export class QuestionImageError extends Error {
  constructor(message: string, readonly captured?: TaskQuestion) { super(message); }
}
