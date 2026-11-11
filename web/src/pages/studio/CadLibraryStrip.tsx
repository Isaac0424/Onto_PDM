import { useState } from 'react';
import { Icon } from '../../components/AppShell';
import type { CadEntry, VaultCadRecord } from './cadLibrary';
import { minutesLeft } from './sessionCache';

const OPEN_KEY = 'onto-pdm.cad.lib-open';
const readOpen = (): boolean | undefined => { try { const v = window.localStorage.getItem(OPEN_KEY); return v === null ? undefined : v === '1'; } catch { return undefined; } };
const writeOpen = (open: boolean) => { try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 기억 못 해도 동작에는 지장 없음 */ } };

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 저장 상태 칩 + 캐시 남은 시간. 서버 DB 가 정본이고, 브라우저 캐시는 마지막 사용에서 10분 */
function StorageState({ entry, now }: { entry: CadEntry; now: number }) {
  if (entry.storage === 'browser-only') {
    return (
      <small className="cad-card-store">
        <span className="chip-store chip-store-warn" title={entry.syncNote ?? '서버가 꺼져 있어요. 켜지면 자동으로 올려요'}>
          <Icon name="cloud_off" size={12} />이 브라우저에만
        </span>
        {entry.syncNote ? '서버가 받지 않았어요' : '서버에 못 보냈어요'}
      </small>
    );
  }
  if (entry.storage === 'cache-expired') {
    return (
      <small className="cad-card-store">
        <span className="chip-store chip-store-off" title="캐시가 만료돼 서버 DB에서 받아 열어요"><Icon name="cloud_download" size={12} />서버에서 불러와요</span>
      </small>
    );
  }
  return (
    <small className="cad-card-store">
      <span className="chip-store chip-store-ok" title="서버 DB에 저장돼 있어요"><Icon name="cloud_done" size={12} />서버 DB 저장됨</span>
      {entry.cached && entry.cacheExpiresAt ? `캐시 ${minutesLeft(entry.cacheExpiresAt, now)}분 남음` : '열면 서버에서 불러와요'}
    </small>
  );
}

/**
 * 등록한 CAD 목록. 올린 CAD 는 서버 DB 에 저장되고, 연 CAD 는 창을 닫아도 10분 동안 브라우저 캐시에 남아 바로 열린다.
 * 지금 열린 CAD 는 aria-current 로 표시한다. "보관소에서 가져오기"는 파일 보관소 서버에만 있는 CAD 를 이 목록으로 가져온다.
 */
export function CadLibraryStrip({
  entries, activeId, now, onOpen, onRemove, onUpload, onLoadVault, onImportVault,
}: {
  entries: CadEntry[];
  /** 지금 열린 등록 CAD 의 id (열린 CAD 가 없으면 undefined) */
  activeId?: string;
  /** 캐시 남은 시간을 계산하는 현재 시각 (ms) */
  now: number;
  onOpen(entry: CadEntry): void;
  onRemove(entry: CadEntry): void;
  onUpload(): void;
  onLoadVault(): Promise<VaultCadRecord[]>;
  onImportVault(rec: VaultCadRecord): Promise<void>;
}) {
  const [vault, setVault] = useState<{ rows: VaultCadRecord[] } | { error: string } | 'loading' | null>(null);
  // 접고 펴기: 3D 화면이 바로 보이도록 기본은 접혀 있다(등록한 CAD 가 하나도 없을 때만 펴서 안내한다). 사람이 정한 것은 기억한다
  const [pref, setPref] = useState<boolean | undefined>(readOpen);
  const open = pref ?? entries.length === 0;
  const setOpen = (next: boolean) => { setPref(next); writeOpen(next); };
  const activeName = entries.find(e => e.id === activeId)?.name;
  const waiting = entries.filter(e => e.storage === 'browser-only' && !e.syncNote).length;

  const toggleVault = async () => {
    if (vault) { setVault(null); return; }
    setOpen(true);
    setVault('loading');
    try { setVault({ rows: await onLoadVault() }); } catch (e) { setVault({ error: String((e as Error).message ?? e) }); }
  };

  return (
    <section className="glass-panel cad-lib" aria-label="등록한 CAD">
      <header className="cad-lib-head">
        <h2>
          <button type="button" className="cad-lib-toggle" aria-expanded={open} aria-controls="cad-lib-body" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'expand_more' : 'chevron_right'} size={18} />
            등록한 CAD <span className="cad-lib-count">{entries.length}</span>
            {!open && activeName && <span className="cad-lib-now" title={activeName}>열린 CAD · {activeName}</span>}
          </button>
        </h2>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" aria-expanded={!!vault} onClick={() => void toggleVault()}><Icon name="cloud_download" size={16} />보관소에서 가져오기</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onUpload}><Icon name="add" size={16} />CAD 등록</button>
      </header>
      {waiting > 0 && <p className="cad-lib-pending">서버에 연결되면 자동으로 올려요 · 대기 {waiting}개</p>}
      <div id="cad-lib-body" hidden={!open}>

      {entries.length === 0 ? (
        <p className="cad-lib-empty">아직 등록한 CAD가 없어요. CAD를 올리면 서버 DB에 저장돼 언제든 다시 열 수 있어요.</p>
      ) : (
        <ul className="cad-cards">
          {entries.map(e => (
            <li key={e.id} className="cad-card-wrap">
              <button type="button" className={`cad-card ${e.id === activeId ? 'cad-card-on' : ''}`} aria-current={e.id === activeId ? 'true' : undefined}
                aria-label={`${e.name} 열기`} onClick={() => onOpen(e)}>
                <Icon name="view_in_ar" size={20} />
                <span className="cad-card-name">{e.name}</span>
                <small className="cad-card-meta">
                  <span className="chip-holo">{e.format.toUpperCase()}</span>
                  {sizeText(e.size)}{e.parts !== undefined ? ` · 부품 ${e.parts}개` : ''}{e.layers !== undefined ? ` · ${e.layers}단계` : ''} · {dateText(e.addedAt)}
                </small>
                <StorageState entry={e} now={now} />
              </button>
              <button type="button" className="cad-card-del" aria-label={`${e.name} 목록에서 제거`}
                title="목록에서 제거 (서버 DB의 사본도 목록에서 빠져요. 내용은 DB에 남아 같은 파일을 다시 올리면 되살아나요)" onClick={() => onRemove(e)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {vault && (
        <div className="cad-vault" role="region" aria-label="보관소의 CAD">
          {vault === 'loading' && <p className="faint">보관소를 읽는 중…</p>}
          {typeof vault === 'object' && 'error' in vault && <p className="cad-vault-error" role="alert">{vault.error}</p>}
          {typeof vault === 'object' && 'rows' in vault && (vault.rows.length === 0
            ? <p className="faint">이 목록에 없는 CAD가 보관소에 없어요.</p>
            : (
              <ul>
                {vault.rows.map(r => (
                  <li key={r.sha256}>
                    <span className="cad-vault-name">{r.name}</span>
                    <span className="faint">{r.format.toUpperCase()} · {sizeText(r.size)}</span>
                    <button type="button" className="btn btn-sm" aria-label={`${r.name} 가져오기`}
                      onClick={() => void onImportVault(r).then(() => setVault(null))}>가져오기</button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
      </div>
    </section>
  );
}
