// CAD 파일 이름 · 부품 이름에서 로봇 모델(HCR-3A · HCR-5A · HCR-12A)을 읽는다. 규칙집은 모델마다 값이 다른 규칙(베이스 고정 볼트의 토크 등)이 있어
// 모델을 알아야 값이 하나로 정해진다. 불확실하면(아무것도 없거나 서로 다른 모델이 섞여 있으면) 보내지 않는다: 지어내지 않는다.
const MODEL_PATTERN = /(?:^|[^A-Za-z0-9])HCR[-_ ]?(?:2G[-_ ]?)?(3A|5A|12A)(?![A-Za-z0-9])/gi;

/** 읽은 모델이 정확히 하나일 때만 돌려준다 (예: 'Body HCR12A R00 3D.stp' → 'HCR-12A') */
export function modelFromNames(names: readonly (string | undefined)[]): string | undefined {
  const found = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    for (const m of n.matchAll(MODEL_PATTERN)) found.add(`HCR-${m[1]!.toUpperCase()}`);
  }
  return found.size === 1 ? [...found][0] : undefined;
}
