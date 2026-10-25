// 화면은 이 파일의 createApi() 로만 API를 얻는다.
// 지금은 목 API뿐이다. 백엔드가 생기면 같은 PdmApi 를 fetch 로 구현해 VITE_API_MODE=http 로 바꾼다.
import type { PdmApi } from './types';
import { createMockApi, type Session } from './mock/mockApi';

export type { Session };

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createApi(getSession: () => Session): PdmApi & { reset?: () => void } {
  const mode = import.meta.env.VITE_API_MODE ?? 'mock';
  if (mode !== 'mock') {
    throw new Error(`VITE_API_MODE=${mode} 는 아직 없습니다. 백엔드 API가 생기면 HTTP 구현을 추가하세요.`);
  }
  return createMockApi(getSession, { latencyMs: 120, storage: browserStorage() });
}
