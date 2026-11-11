// 화면은 이 파일의 createApi() 로만 API를 얻는다.
// VITE_API_MODE: 'http' = PDM 백엔드가 OPMS(Neo4j)를 읽어 준다 · 'empty' = 데이터를 읽어 올 곳이 없다(가짜 데이터는 없다).
// 정하지 않으면 개발 서버(pnpm dev)는 http, 빌드와 시험은 empty 다. 시험은 SessionProvider 에 API 를 직접 넣는다.
import type { PdmApi } from './types';
import { createEmptyApi } from './emptyApi';
import { createHttpApi } from './httpApi';

export function createApi(): PdmApi {
  const mode = import.meta.env.VITE_API_MODE ?? (import.meta.env.MODE === 'development' ? 'http' : 'empty');
  if (mode === 'http') return createHttpApi();
  if (mode === 'empty') return createEmptyApi();
  throw new Error(`VITE_API_MODE=${mode} 는 없는 값입니다. http 또는 empty 를 쓰세요.`);
}
