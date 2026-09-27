import type { Diagnostic, DiagnosticCategory } from '../gates/gate-types';

/**
 * Deterministic classification. The gate category (and parser-provided
 * category) is authoritative; heuristics only apply to `unknown`.
 */
const HEURISTICS: { category: DiagnosticCategory; pattern: RegExp }[] = [
  { category: 'security', pattern: /\b(secret|credential|password|api[_ -]?key|private key|token leak|pii|personal data|insecure|injection|xss|csrf)\b/i },
  { category: 'compile', pattern: /\b(undefined (name|class|method|getter)|isn't defined|is not defined|compil(e|ation)|syntax error|expected to find|can't be assigned|type '.+' is not a subtype|import(ed)? .* (not found|doesn't exist)|uri_does_not_exist)\b/i },
  { category: 'test', pattern: /\b(expected:|actual:|test failed|some tests failed|assertion)\b/i },
  { category: 'architecture', pattern: /\b(layer|dependency direction|forbidden import|must not (import|depend)|architecture)\b/i },
  { category: 'coverage', pattern: /\bcoverage\b/i },
  { category: 'lint', pattern: /\b(lint|style|prefer_|avoid_|unused|duplicate code|complexity)\b/i },
];

export function classify(diagnostic: Diagnostic): DiagnosticCategory {
  if (diagnostic.category !== 'unknown') {
    return diagnostic.category;
  }
  const text = `${diagnostic.rule ?? ''} ${diagnostic.message}`;
  for (const h of HEURISTICS) {
    if (h.pattern.test(text)) {
      return h.category;
    }
  }
  return 'unknown';
}

export function classifyAll(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => {
    const category = classify(d);
    return category === d.category ? d : { ...d, category };
  });
}
