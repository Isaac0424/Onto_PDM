/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** mock(기본) | http — 백엔드 API가 생기면 http 구현을 추가한다 */
  readonly VITE_API_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
