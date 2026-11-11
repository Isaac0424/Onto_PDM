// 시험 도우미: 스튜디오는 예시(목업) 모델 없이 시작한다. 화면 시험은 CAD 를 보관함에 미리 등록하고 "마지막에 열어 둔 CAD" 로 만들어 두고 시작한다.
// 기본은 서버가 꺼진 상태(서버 DB 에 못 보내 이 브라우저에만 있음)로 등록한다. 서버가 있는 상황은 server 를 넘긴다 (testServer.ts 의 가짜 서버).
import { createCadLibrary, writeActive, type CadEntry, type CadLibraryDeps } from './cadLibrary';
import { CadServerUnavailable, type CadServer } from './cadServer';

/** 꺼져 있는 서버: 모든 호출이 연결 오류 */
export const offlineServer: CadServer = {
  list: async () => { throw new CadServerUnavailable(); },
  upload: async () => { throw new CadServerUnavailable(); },
  content: async () => { throw new CadServerUnavailable(); },
  patch: async () => { throw new CadServerUnavailable(); },
  remove: async () => { throw new CadServerUnavailable(); },
};

/** CAD 하나를 보관함에 등록한다. active 가 true 면 마지막에 열어 둔 CAD 로 기록한다 */
export async function seedCad(name = 'base.step', body = `solid ${name}`, active = true, deps: CadLibraryDeps = { server: offlineServer }): Promise<CadEntry> {
  const { entry } = await createCadLibrary(deps).add(new File([body], name));
  if (active) writeActive({ kind: 'cad', id: entry.id });
  return entry;
}
