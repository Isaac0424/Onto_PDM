import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FastenerCandidate, FastenerResult } from '../../extract/fastener';
import { FastenerBlock } from './FastenerBlock';

const cand = (classCode: string, label: string, headType: FastenerCandidate['headType'], score: number, proposed = false, evidence: string[] = ['근거 한 줄']): FastenerCandidate => ({ classCode, label, headType, score, proposed, evidence });
const result = (candidates: FastenerCandidate[], over: Partial<FastenerResult> = {}): FastenerResult => ({
  candidates, confidence: 0.8, ambiguous: false, driveType: 'HexSocket', unit: { known: true, assumed: false },
  geometry: { threadDiameter: 6, underHeadLength: 20, overallLength: 26, headDiameter: 10, headHeight: 6, profile: { cylinder: 1, dome: 0, cone: 0, flange: 0 }, hexness: 0, recess: { present: true, kind: 'hex', acrossFlats: 5, depth: 3 } },
  ...over,
});

describe('형상으로 본 볼트 종류 블록', () => {
  it('분석 중이면 "형상 분석 중…"만 보인다', () => {
    render(<FastenerBlock view={{ status: 'analyzing' }} onPick={() => {}} />);
    expect(screen.getByRole('status', { name: '형상 분석' })).toHaveTextContent('형상 분석 중…');
  });

  it('점수 차가 뚜렷하면 안내 없이 후보와 근거를 보이고, 확정을 알린다', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<FastenerBlock view={{ status: 'done', result: result([cand('SocketHeadBolt', '육각구멍붙이볼트', 'Socket', 0.98, false, ['머리 지름/나사 지름 1.6'])]) }} onPick={onPick} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await user.click(screen.getByText('근거'));
    expect(screen.getByText('머리 지름/나사 지름 1.6')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    expect(onPick).toHaveBeenCalledWith('SocketHeadBolt');
  });

  it('1·2위 점수가 가까우면 후보가 여러 개라고 알린다 (단정 금지)', () => {
    render(<FastenerBlock view={{ status: 'done', result: result([cand('SocketHeadBolt', '육각구멍붙이볼트', 'Socket', 0.62), cand('ButtonHeadBolt', '버튼헤드볼트', 'Button', 0.55, true)]) }} onPick={() => {}} />);
    expect(screen.getByRole('note')).toHaveTextContent('후보가 여러 개예요 — 1·2위 점수가 가까워 하나로 정하지 않았어요.');
  });

  it('구동부 구멍을 확인하지 못했으면 그 이유로 알린다', () => {
    render(<FastenerBlock view={{ status: 'done', result: result([cand('SocketHeadBolt', '육각구멍붙이볼트', 'Socket', 0.55, false, ['구동부 구멍을 확인하지 못함'])], { ambiguous: true }) }} onPick={() => {}} />);
    expect(screen.getByRole('note')).toHaveTextContent('구동부 구멍이 보이지 않아요');
  });

  it('머리 모양을 정하지 못한 볼트 형상은 후보 목록 없이 안내만 보인다', () => {
    render(<FastenerBlock view={{ status: 'done', result: result([], { confidence: 0 }) }} onPick={() => {}} />);
    expect(screen.getByRole('note')).toHaveTextContent('머리 모양을 정하지 못했어요');
    expect(screen.queryByRole('list', { name: '볼트 종류 후보' })).not.toBeInTheDocument();
  });

  it('후보는 4개까지만 보이고, 확정한 것은 취소할 수 있다', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const list = [
      cand('SocketHeadBolt', 'A', 'Socket', 0.9), cand('ButtonHeadBolt', 'B', 'Button', 0.5, true), cand('CountersunkHeadBolt', 'C', 'Countersunk', 0.4, true),
      cand('HexBolt', 'D', 'Hex', 0.3), cand('HexFlangeBolt', 'E', 'HexFlange', 0.2),
    ];
    render(<FastenerBlock view={{ status: 'done', result: result(list), pickedClass: 'ButtonHeadBolt' }} onPick={onPick} />);
    const items = [...screen.getByRole('list', { name: '볼트 종류 후보' }).children] as HTMLElement[];             // 후보 줄만 (근거 목록의 li 는 세지 않는다)
    expect(items).toHaveLength(4);
    expect(within(items[1]!).getByText('확정')).toBeInTheDocument();
    await user.click(within(items[1]!).getByRole('button', { name: 'B 확정 취소' }));
    expect(onPick).toHaveBeenCalledWith(undefined);
  });
});
