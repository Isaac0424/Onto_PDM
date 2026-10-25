import type { TaxonomyClass } from '../../api/types';

/** 분류를 트리 순서로 펼친 선택지: "체결류 › 볼트" */
export function classOptions(classes: TaxonomyClass[], kind: TaxonomyClass['kind'] = 'part') {
  const list = classes.filter(c => c.kind === kind);
  const out: { iri: string; label: string; code: string }[] = [];
  const walk = (parent: string | undefined, prefix: string) => {
    list
      .filter(c => c.parentIri === parent)
      .sort((a, b) => a.code.localeCompare(b.code))
      .forEach(c => {
        const label = prefix ? `${prefix} › ${c.labelKo}` : c.labelKo;
        out.push({ iri: c.iri, label, code: c.code });
        walk(c.iri, label);
      });
  };
  walk(undefined, '');
  return out;
}

export function classLabel(classes: TaxonomyClass[], iri?: string) {
  if (!iri) return undefined;
  return classOptions(classes).find(o => o.iri === iri)?.label ?? iri;
}
