// 올린 CAD · BOM · 사양서 원본을 파일 보관소 서버(server/files-server.mjs)에 저장한다.
// 개발 서버는 /api/files 를 FILES_PORT(8788)로 넘긴다 (vite.config.ts).
export type VaultKind = 'cad' | 'bom' | 'spec';

export interface VaultFile {
  sha256: string;
  size: number;
  name: string;
  format: string;
  kind: VaultKind;
  duplicate: boolean;   // 같은 내용이 이미 있어서 새로 저장하지 않았다
}

export async function uploadToVault(file: File, kind: VaultKind): Promise<VaultFile> {
  let res: Response;
  try {
    res = await fetch(`/api/files?name=${encodeURIComponent(file.name)}&kind=${kind}`, { method: 'POST', body: file });
  } catch {
    throw new Error('파일 보관소 서버에 연결하지 못했습니다. `node server/files-server.mjs`를 켜 주세요.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `파일 보관소 저장 실패 (HTTP ${res.status})`);
  }
  return res.json() as Promise<VaultFile>;
}
