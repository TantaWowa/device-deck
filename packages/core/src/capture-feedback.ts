import type { Artifact } from "./local/types";

const finished = (a: Artifact) => ["completed", "interrupted", "failed"].includes(a.status);

/** Baseline existing history once, then report each capture's first terminal state. */
export class CaptureCompletionTracker {
  private initialized = false;
  private seen = new Set<string>();

  completed(artifact: Artifact): Artifact | undefined {
    if (!finished(artifact) || artifact.deletedAt || artifact.purgedAt || this.seen.has(artifact.id)) return;
    this.seen.add(artifact.id);
    return artifact;
  }

  update(artifacts: Artifact[]): Artifact[] {
    if (!this.initialized) {
      this.initialized = true;
      for (const artifact of artifacts) if (finished(artifact)) this.seen.add(artifact.id);
      return [];
    }
    return artifacts.flatMap((artifact) => {
      const result = this.completed(artifact);
      return result ? [result] : [];
    });
  }
}
