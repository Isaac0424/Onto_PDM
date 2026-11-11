/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** http(개발 서버 기본: PDM 백엔드가 OPMS 를 읽어 준다) | empty(빌드 · 시험 기본: 읽어 올 곳 없음) */
  readonly VITE_API_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
