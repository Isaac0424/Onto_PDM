// ===== built-in example: a mechanical watch, built from primitives (Y is up) =====
function geomToRaw(g) {
  return {
    pos: Float32Array.from(g.attributes.position.array),
    idx: g.index ? Uint32Array.from(g.index.array) : null,
    nor: g.attributes.normal ? Float32Array.from(g.attributes.normal.array) : null,
  };
}
function ringProfile(pts, seg = 120) { return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg); }
function gearGeom(r, teeth, th, hole = 0, toothH = 0) {
  const sh = new THREE.Shape(), th2 = toothH || Math.min(r * .09, .55), n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, k = i % 4, rr = (k === 1 || k === 2) ? r : r - th2;
    const p = [Math.cos(a) * rr, Math.sin(a) * rr];
    i === 0 ? sh.moveTo(...p) : sh.lineTo(...p);
  }
  if (hole > 0) { const hp = new THREE.Path(); hp.absarc(0, 0, hole, 0, Math.PI * 2, true); sh.holes.push(hp); }
  if (r > 2.6) { // spokes: four windows
    for (let s = 0; s < 4; s++) {
      const a0 = s * Math.PI / 2 + .22, a1 = a0 + Math.PI / 2 - .44, ri = Math.max(hole + .5, r * .28), ro = r * .74;
      const w = new THREE.Path(); w.absarc(0, 0, ro, a0, a1, false); w.absarc(0, 0, ri, a1, a0, true); sh.holes.push(w);
    }
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  return g;
}
function cyl(r, h, y, x = 0, z = 0, seg = 64) { const g = new THREE.CylinderGeometry(r, r, h, seg); g.translate(x, y + h / 2, z); return g; }
function box(w, h, d, x, y, z, ry = 0) { const g = new THREE.BoxGeometry(w, h, d); g.rotateY(ry); g.translate(x, y + h / 2, z); return g; }

function loadWatch() {
  const parts = [];
  const add = (name, path, geoms) => parts.push({ name, path, meshes: [].concat(geoms).map(geomToRaw) });
  const at = (g, x, y, z) => { g.translate(x, y, z); return g; };

  // 01 caseback
  add('뒷뚜껑', '케이스 / 뒷뚜껑', ringProfile([[0, 0], [18.4, 0], [19.4, .7], [19.4, 1.6], [0, 1.6]]));
  add('뒷면 창 링', '케이스 / 뒷뚜껑', ringProfile([[10.4, 1.6], [12.2, 1.6], [12.2, 2.0], [10.4, 2.0], [10.4, 1.6]]));
  // 02 case
  add('미들 케이스', '케이스', ringProfile([[16.6, 2.0], [19.6, 2.0], [20.3, 3.2], [20.3, 8.6], [19, 10.1], [17.3, 10.1], [17.3, 9.5], [16.6, 9.5], [16.6, 2.0]]));
  [[-7.6, 21], [7.6, 21], [-7.6, -21], [7.6, -21]].forEach(([x, z], i) => add('러그', '케이스', box(3, 2.6, 7, x, 3.4, z)));
  { const g = new THREE.CylinderGeometry(1.7, 1.7, 2.6, 32); g.rotateZ(Math.PI / 2); g.translate(21.5, 5.6, 0); add('크라운', '케이스', g); }
  // 03 main plate
  add('메인 플레이트', '무브먼트', cyl(16, 1.1, 2.4, 0, 0, 120));
  [[0, 0], [-5.5, -4], [4.6, -4.4], [6.8, 1.2], [9.6, -2.6], [8.2, 6.6]].forEach(([x, z]) => add('보석 베어링', '무브먼트 / 메인 플레이트', cyl(.55, .3, 3.5, x, z, 20)));
  // 04 barrel
  add('태엽통', '무브먼트 / 동력', at(gearGeom(6.2, 72, 1.8, 1.1, .35), -5.5, 3.9, -4));
  add('태엽통 축', '무브먼트 / 동력', cyl(1.1, 2.8, 3.6, -5.5, -4, 32));
  // 05 gear train
  add('중심 바퀴', '무브먼트 / 기어 트레인', at(gearGeom(4.6, 64, .45, .5), 0, 4.6, 0));
  add('3번 바퀴', '무브먼트 / 기어 트레인', at(gearGeom(3.7, 56, .4, .4), 4.6, 5.2, -4.4));
  add('4번 바퀴', '무브먼트 / 기어 트레인', at(gearGeom(3.3, 50, .4, .35), 6.8, 5.7, 1.2));
  [[0, 0, 4.0], [4.6, -4.4, 4.6], [6.8, 1.2, 5.1]].forEach(([x, z, y]) => add('피니언', '무브먼트 / 기어 트레인', at(gearGeom(.9, 8, 1.6, .25, .3), x, y, z)));
  // 06 escapement
  add('이스케이프 휠', '무브먼트 / 탈진기', at(gearGeom(2.4, 15, .35, .3, .7), 9.6, 6.2, -2.6));
  { const g1 = box(4.6, .35, .55, 10.6, 6.3, 1.4, -1.05), g2 = box(2.2, .35, .5, 9.9, 6.3, -.2, .5), g3 = box(.5, .35, 2.2, 11.2, 6.3, -.6, .5);
    add('팔레트 포크', '무브먼트 / 탈진기', [g1, g2, g3]); }
  // 07 balance
  add('밸런스 휠', '무브먼트 / 조속기', ringProfile([[3.9, 7.0], [4.6, 7.0], [4.6, 7.7], [3.9, 7.7], [3.9, 7.0]], 96).translate(8.2, 0, 6.6));
  add('밸런스 암', '무브먼트 / 조속기', [box(7.9, .25, .5, 8.2, 7.2, 6.6), box(.5, .25, 7.9, 8.2, 7.2, 6.6)]);
  add('밸런스 축', '무브먼트 / 조속기', cyl(.22, 2.2, 6.4, 8.2, 6.6, 16));
  { const pts = []; for (let i = 0; i <= 420; i++) { const a = i / 420 * Math.PI * 2 * 9, r = .6 + i / 420 * 2.9; pts.push(new THREE.Vector3(8.2 + Math.cos(a) * r, 8.0, 6.6 + Math.sin(a) * r)); }
    add('헤어스프링', '무브먼트 / 조속기', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 900, .045, 5, false)); }
  // 08 dial
  add('문자판', '다이얼', cyl(16.2, .35, 8.5, 0, 0, 120));
  for (let h = 0; h < 12; h++) {
    const a = h / 12 * Math.PI * 2, r = 13.2;
    add('인덱스', '다이얼', box(h === 0 ? 1.6 : .8, .3, 2.6, Math.sin(a) * r, 8.85, -Math.cos(a) * r, -a));
  }
  // 09 hands (10:10:35)
  const hand = (len, wd, th, y, ang, tail = 1.2) => { const g = new THREE.BoxGeometry(wd, th, len + tail); g.translate(0, y + th / 2, -(len - tail) / 2); g.rotateY(-ang); return g; };
  add('시침', '바늘', hand(8, 1.0, .16, 9.3, (10 + 10 / 60) / 12 * Math.PI * 2));
  add('분침', '바늘', hand(12.6, .7, .14, 9.5, 10 / 60 * Math.PI * 2));
  add('초침', '바늘', hand(14.2, .22, .1, 9.7, 35 / 60 * Math.PI * 2, 3));
  add('바늘 캡', '바늘', cyl(.85, .5, 9.3, 0, 0, 32));
  // 10 crystal
  add('사파이어 크리스털', '케이스 / 유리', ringProfile([[0, 10.2], [17.3, 10.2], [17.3, 11.0], [16.4, 11.5], [0, 11.6]], 120));

  const byName = n => parts.map((p, i) => [p.name, i]).filter(([nm]) => n.includes(nm)).map(([, i]) => i);
  const L = (title, code, names, description, extra = {}) => Object.assign({ title, code, partIds: byName(names), description }, extra);
  const layers = [
    L('뒷뚜껑', 'CASEBACK', ['뒷뚜껑', '뒷면 창 링'], '무브먼트를 먼지와 습기로부터 막아 주는 마지막 덮개예요. 가운데 투명한 창으로 안쪽 부품이 움직이는 모습을 볼 수 있어요.'),
    L('케이스', 'CASE', ['미들 케이스', '러그', '크라운'], '모든 부품을 붙잡아 두는 몸체예요. 옆의 크라운을 돌려 태엽을 감고 시간을 맞춰요.'),
    L('메인 플레이트', 'MAIN PLATE', ['메인 플레이트', '보석 베어링'], '무브먼트의 바닥판이에요. 톱니바퀴 축이 꽂히는 자리마다 마찰을 줄이는 보석 베어링이 박혀 있어요.'),
    L('태엽통', 'BARREL', ['태엽통', '태엽통 축'], '안에 감긴 태엽이 천천히 풀리면서 시계 전체를 움직일 힘을 만들어요. 가득 감으면 보통 이틀 가까이 움직여요.'),
    L('기어 트레인', 'GEAR TRAIN', ['중심 바퀴', '3번 바퀴', '4번 바퀴', '피니언'], '태엽통의 느리고 강한 힘을 빠르고 가벼운 회전으로 바꿔 전달해요. 중심 바퀴는 한 시간에 한 바퀴 돌며 분침을 움직여요.'),
    L('탈진기', 'ESCAPEMENT', ['이스케이프 휠', '팔레트 포크'], '이스케이프 휠과 팔레트 포크가 흘러오는 힘을 일정한 조각으로 끊어 내보내요. 째깍 소리가 바로 여기서 나요.'),
    L('밸런스 휠', 'BALANCE', ['밸런스 휠', '밸런스 암', '밸런스 축', '헤어스프링'], '헤어스프링과 함께 정확한 리듬으로 좌우로 흔들리는 시계의 심장이에요. 1초에 8번씩, 한 시간에 28,800번 흔들려요.'),
    L('문자판', 'DIAL', ['문자판', '인덱스'], '시간을 읽는 얼굴이에요. 열두 개의 인덱스가 시각의 위치를 표시해요.'),
    L('시곗바늘', 'HANDS', ['시침', '분침', '초침', '바늘 캡'], '기어 트레인과 이어진 축에 끼워져 시, 분, 초를 가리켜요. 가장 위에 있어 유리 바로 아래에서 움직여요.'),
    L('유리', 'CRYSTAL', ['사파이어 크리스털'], '긁힘에 강한 사파이어 크리스털이 문자판과 바늘을 보호해요. 위에서 보이는 모든 것이 이 유리 너머에 있어요.', { glass: true }),
  ];
  $('modelFile').textContent = ''; $('specFile').textContent = ''; S.specText = ''; S.specName = '';
  setModel(parts, {
    name: '기계식 손목시계 · 예시 모델', unit: 'mm', source: 'demo', layers, keepOrder: true, base: '메인 플레이트',
    meta: { title: '기계식 손목시계', summary: '겉에서는 바늘만 보이지만, 안에는 힘을 만들고 나누고 다스리는 부품이 층층이 쌓여 있어요.', explode: '겉에선 바늘만 보이지만, 안에는 힘을 만들고 나누고 다스리는 부품이 층층이 쌓여 있어요.', specs: ['4 HZ · 28,800 VPH', 'JEWELS 21'] },
  });
  setAiStatus('예시 시계를 보고 있어요. 내 CAD 파일과 사양서를 올리면 같은 방식으로 만들어져요.');
}

// ===== built-in example 2: a small control box (Z is up) — screws, side covers, lid =====
function loadBox() {
  const parts = [];
  const add = (name, path, geoms) => parts.push({ name, path, meshes: [].concat(geoms).map(geomToRaw) });
  const bz = (sx, sy, sz, cx, cy, cz) => { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(cx, cy, cz); return g; };
  const cz = (r, h, x, y, z0, seg = 32) => { const g = new THREE.CylinderGeometry(r, r, h, seg); g.rotateX(Math.PI / 2); g.translate(x, y, z0 + h / 2); return g; };
  // screw along +Z (head at top) or ±X (head outward); tip at `from`, length `len`
  const screw = (axis, sign, x, y, z, len) => {
    const shaft = new THREE.CylinderGeometry(1.5, 1.5, len, 20), head = new THREE.CylinderGeometry(2.8, 2.8, 2.2, 28);
    shaft.translate(0, len / 2, 0); head.translate(0, len + 1.1, 0);
    [shaft, head].forEach(g => {
      if (axis === 'z') g.rotateX(Math.PI / 2);
      else g.rotateZ(-Math.PI / 2 * sign);
      g.translate(x, y, z);
    });
    return [shaft, head];
  };
  add('하우징', '본체', [
    bz(120, 80, 4, 0, 0, 2), bz(120, 3, 26, 0, -38.5, 17), bz(120, 3, 26, 0, 38.5, 17),
    ...[[-54, -32], [54, -32], [-54, 32], [54, 32]].map(([x, y]) => cz(4, 26, x, y, 4)),
    ...[[-56, -25], [-56, 25], [56, -25], [56, 25]].map(([x, y]) => bz(6, 10, 26, x, y, 17)),
  ]);
  [[-40, -22], [40, -22], [-40, 22], [40, 22]].forEach(([x, y]) => add('스페이서', '본체 / 기판 지지', cz(2.5, 8, x, y, 4)));
  add('제어 기판', '전장', [bz(96, 60, 1.6, 0, 0, 12.8), bz(14, 14, 2, -35, -15, 14.6), bz(8, 20, 3, 35, -15, 15.1), bz(18, 6, 4, -10, -24, 15.6)]);
  [[-40, -22], [40, -22], [-40, 22], [40, 22]].forEach(([x, y]) => add('기판 나사 M3', '체결', screw('z', 1, x, y, 7.6, 6)));
  add('배터리', '전장', [bz(50, 26, 14, 0, 10, 22), cz(3, 1.5, -18, 10, 29)]);
  add('좌측 커버', '외장', bz(3, 80, 30, -61.5, 0, 15));
  add('우측 커버', '외장', bz(3, 80, 30, 61.5, 0, 15));
  [[-25], [25]].forEach(([y]) => { add('좌측 커버 나사 M3', '체결', screw('x', -1, -51, y, 15, 12)); add('우측 커버 나사 M3', '체결', screw('x', 1, 51, y, 15, 12)); });
  add('상부 커버', '외장', bz(126, 80, 3, 0, 0, 31.5));
  add('전원 버튼', '외장', cz(5, 4, 40, -20, 33, 36));
  [[-54, -32], [54, -32], [-54, 32], [54, 32]].forEach(([x, y]) => add('상부 나사 M3', '체결', screw('z', 1, x, y, 23, 10)));

  const ids = re => parts.map((p, i) => [p.name, i]).filter(([n]) => re.test(n)).map(([, i]) => i);
  const L = (title, code, re, description) => ({ title, code, partIds: ids(re), description });
  const layers = [
    L('하우징', 'HOUSING', /^하우징$/, '바닥판, 앞뒤 벽, 나사 기둥이 한 덩어리로 된 몸체예요. 모든 부품이 여기에 고정되고, 분해하는 동안 제자리에 있어요.'),
    L('스페이서', 'STANDOFF', /^스페이서$/, '기판을 바닥에서 8mm 띄워 주는 기둥이에요. 바닥과 기판 사이에 공기가 흘러 열이 빠져요.'),
    L('제어 기판', 'PCB', /^(제어 기판|기판 나사)/, '전원과 신호를 처리하는 회로 기판이에요. 나사 네 개가 위에서 아래로 스페이서에 박혀 고정해요.'),
    L('배터리', 'BATTERY', /^배터리$/, '기판 위에 얹힌 충전식 배터리예요. 커버를 열면 바로 꺼낼 수 있는 위치에 있어요.'),
    L('좌측 커버', 'SIDE PANEL L', /^좌측 커버/, '왼쪽 옆면을 막는 판이에요. 나사 두 개를 빼면 바깥쪽으로 빠져요.'),
    L('우측 커버', 'SIDE PANEL R', /^우측 커버/, '오른쪽 옆면을 막는 판이에요. 나사 두 개를 빼면 바깥쪽으로 빠져요.'),
    L('상부 커버', 'LID', /^(상부 커버|상부 나사|전원 버튼)/, '위를 덮는 뚜껑이에요. 모서리 나사 네 개를 빼면 위로 들려요.'),
  ];
  $('modelFile').textContent = ''; $('specFile').textContent = ''; S.specText = ''; S.specName = '';
  setModel(parts, {
    name: '제어 박스 · 예시 모델', unit: 'mm', source: 'demo', layers, keepOrder: true, base: '하우징',
    meta: { title: '제어 박스', summary: '나사 열두 개를 풀면 커버가 열리고, 안에 기판과 배터리가 층층이 들어 있어요.', explode: '나사는 박힌 방향으로 먼저 빠지고, 옆 커버는 바깥으로, 뚜껑과 안쪽 부품은 위로 올라와요.', specs: ['120 × 80 × 37 MM', 'M3 × 12'] },
  });
  setAiStatus('예시 제어 박스예요. 나사는 박힌 방향으로, 옆 커버는 바깥쪽으로 빠지는 걸 볼 수 있어요.');
}
