import { describe, expect, it } from 'vitest';
import { createHttpApi } from './httpApi';
import { fakeBackend } from './testBackend';

// 분류가 요구하는 속성(필수 여부 · 값 범위 · 관례로 채워지는 값)을 OPMS 에서 읽는다 (읽기 전용, 분류별로 한 번만).
describe('HTTP API: 분류의 필수 속성 규칙(getClassSpec)', () => {
  it('SocketHeadBolt 의 필수 속성 · 값 범위 · 관례 값을 화면이 쓰는 모양으로 준다', async () => {
    const api = createHttpApi({ fetchImpl: fakeBackend().fetch });
    const spec = await api.opms!.getClassSpec('SocketHeadBolt');
    expect(spec).toMatchObject({ code: 'SocketHeadBolt', label: '육각구멍붙이볼트' });
    const by = Object.fromEntries(spec.properties.map(p => [p.key, p]));
    expect(spec.properties.filter(p => p.required).map(p => p.key).sort())
      .toEqual(['length', 'material', 'pitch', 'socketSize', 'strengthGrade', 'surfaceTreatment', 'threadDirection', 'threadSize']);
    expect(by.length).toMatchObject({ label: '길이', unit: 'mm', min: 3, required: true });
    expect(by.socketSize).toMatchObject({ unit: 'mm', min: 1.5 });
    expect(by.threadDirection!.omittedDefault).toEqual({ code: 'RightHand', label: '오른나사' });
    expect(by.pitch!.lookupDefault).toMatchObject({ key: 'threadSize', seriesLabel: '보통 나사' });
    expect(by.pitch!.lookupDefault!.values.M4).toEqual([0.7]);
    expect(by.material!.omittedDefault).toBeUndefined();
    expect(by.material!.min).toBeUndefined();
  });

  it('분류별로 한 번만 읽는다 (같은 분류를 여러 번 물어도)', async () => {
    const backend = fakeBackend();
    const api = createHttpApi({ fetchImpl: backend.fetch });
    await Promise.all([api.opms!.getClassSpec('Bolt'), api.opms!.getClassSpec('Bolt'), api.opms!.getClassSpec('Bolt')]);
    await api.opms!.getClassSpec('Bolt');
    expect(backend.calls.filter(c => c.path === '/opms/classes/Bolt')).toHaveLength(1);
  });

  it('OPMS 에 없는 분류는 404, 백엔드가 꺼지면 503 이고, 실패는 기억하지 않아 다시 시도할 수 있다', async () => {
    const backend = fakeBackend();
    const api = createHttpApi({ fetchImpl: backend.fetch });
    await expect(api.opms!.getClassSpec('Nope')).rejects.toMatchObject({ status: 404 });
    backend.state.backend = 'down';
    await expect(api.opms!.getClassSpec('Bolt')).rejects.toMatchObject({ status: 503 });
    backend.state.backend = 'up';
    await expect(api.opms!.getClassSpec('Bolt')).resolves.toMatchObject({ code: 'Bolt' });       // 돌아오면 읽힌다
  });

  it('OPMS 를 읽지 못하면(503) 503 이다', async () => {
    const api = createHttpApi({ fetchImpl: fakeBackend({ opms: 'OPMS_UNAVAILABLE' }).fetch });
    await expect(api.opms!.getClassSpec('SocketHeadBolt')).rejects.toMatchObject({ status: 503 });
  });
});
