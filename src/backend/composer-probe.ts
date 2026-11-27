export function composerProbeKey(draft: string): "x" | "y" {
  return draft === "x" ? "y" : "x";
}

export function classifyComposerProbe(draft: string, caret: number, probe: string, observed: string | null): "typed" | "suggestion" | null {
  if (observed === probe) return "suggestion";
  if (observed === draft.slice(0, caret) + probe + draft.slice(caret)) return "typed";
  return null;
}
