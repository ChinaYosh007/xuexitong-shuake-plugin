import { practiceFixtureAdapter } from "./practice-fixture";
import { xuexitongGradedAdapter } from "./xuexitong-graded";
import type { PageAdapter, PageMatch } from "./types";

const ADAPTERS: readonly PageAdapter[] = [xuexitongGradedAdapter, practiceFixtureAdapter];

export interface AdapterMatch {
  adapter: PageAdapter;
  match: PageMatch;
}

/**
 * Registry of verified page adapters. Only synthetic Fixture pages have an adapter today.
 * Real Xuexitong selectors are intentionally absent until redacted DOM evidence exists
 * (see docs/compatibility.md and AGENTS.md rule 11).
 */
export function findAdapter(document: Document): AdapterMatch | null {
  for (const adapter of ADAPTERS) {
    const match = adapter.match(document);
    if (match.matched || match.evidence.includes("FRAME_ACCESS_DENIED") || match.pageKind === "GRADED") {
      return { adapter, match };
    }
  }
  return null;
}

export function listAdapters(): readonly PageAdapter[] {
  return ADAPTERS;
}

export function isKnownFixturePage(document: Document): boolean {
  return findAdapter(document) !== null;
}