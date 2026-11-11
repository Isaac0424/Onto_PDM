/* eslint-disable @typescript-eslint/no-explicit-any -- three 는 타입 없이 가져온다(three.d.ts) */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { layout3D, neighbors, type Graph, type GraphNode, type NodeKind } from './graphData';
import { KIND_COLOR, TONE_COLOR, graphKey, type Graph3DProps } from './graphStyle';
import './graph.css';

const RADIUS: Record<NodeKind, number> = { product: 5.8, assembly: 3.9, part: 2.8, rule: 4.6, operation: 3.8, class: 3.4, tool: 2.7, caution: 2.4 };
const BADGE_COLOR = '#7c3aed';
const EDGE_COLOR = 0x0891b2;

/** 구 색: 조립품 · 제품 · 규칙 같은 종류는 고유색, 부품은 상태색 */
const sphereColor = (n: GraphNode) => (n.kind === 'part' ? TONE_COLOR[n.tone] : KIND_COLOR[n.kind]);
/** 후광 색: 상태가 ok 가 아니면 상태색으로 물들여 조립품에서도 작업중 · 폐기가 보이게 한다 */
const haloColor = (n: GraphNode) => (n.kind !== 'part' && n.tone !== 'ok' ? TONE_COLOR[n.tone] : sphereColor(n));

const isJsdom = () => typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
const prefersReducedMotion = () => {
  try { return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

interface SceneApi { select(id: string | null): void; dispose(): void }

interface SceneHooks { onSelect(id: string | null): void; setPointer(on: boolean): void }

/** 장면을 만든다. WebGL 을 못 만들면 던진다 (부르는 쪽이 목록 보기로 물러난다) */
function buildScene(host: HTMLElement, graph: Graph, hooks: SceneHooks, initial: string | null): SceneApi {
  if (isJsdom()) throw new Error('jsdom 에는 WebGL 이 없다');
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });     // 만들 수 없으면 여기서 던진다
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  host.prepend(canvas);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T): T => { disposables.push(d); return d; };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1.5, 0.1, 5000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(1, 2, 3);
  scene.add(key);

  // ---------- 배치와 카메라 ----------
  const placed = layout3D(graph);
  const nodes = graph.nodes;
  {                                                                         // 배치의 중심을 원점에 맞춘다 (한쪽으로 쏠린 트리도 프레임 가운데에 온다)
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    placed.forEach(p => { lo.min(p as any); hi.max(p as any); });
    if (placed.size > 0) {
      const cx = (lo.x + hi.x) / 2, cy = (lo.y + hi.y) / 2, cz = (lo.z + hi.z) / 2;
      placed.forEach(p => { p.x -= cx; p.y -= cy; p.z -= cz; });
    }
  }
  let reach = 0;
  placed.forEach(p => { reach = Math.max(reach, Math.hypot(p.x, p.y, p.z)); });
  const R = Math.max(24, reach + 8);
  // 카메라 거리: 지금 화면 비율에서 모든 노드가 프레임 안에 들어오는 가장 가까운 거리. 비율이 바뀌면(모바일 · 창 크기) 다시 구한다.
  const pts = [...placed.values()].map(p => new THREE.Vector3(p.x, p.y, p.z));
  const viewDir = new THREE.Vector3(0, 0.32, 1).normalize();
  const fitDistance = (aspect: number) => {
    const probe = new THREE.PerspectiveCamera(camera.fov, aspect, 0.1, 5000);
    const tmp = new THREE.Vector3();
    const fits = (t: number) => {
      probe.position.copy(viewDir).multiplyScalar(t);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld(true);
      return pts.every(p => { tmp.copy(p).project(probe); return Math.abs(tmp.x) <= (aspect < 1 ? 0.66 : 0.8) && Math.abs(tmp.y) <= 0.8; });   // 가장자리 여백 20%: 구와 라벨이 잘리지 않게
    };
    let lo = R * 0.2, hi = R * 12;
    for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  };
  let dist = fitDistance(camera.aspect);
  camera.position.copy(viewDir).multiplyScalar(dist);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;                                              // 오른쪽 버튼 · 두 손가락 이동은 없다
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: -1 };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.minDistance = R * 0.35;
  controls.maxDistance = dist * 2.4;
  controls.autoRotate = !prefersReducedMotion();
  controls.autoRotateSpeed = 0.5;
  let moved = false;                                                       // 사용자가 돌렸으면 창 크기가 바뀌어도 시점을 건드리지 않는다
  const stopAuto = () => { controls.autoRotate = false; moved = true; };
  controls.addEventListener('start', stopAuto);
  const noMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener('contextmenu', noMenu);                         // 브라우저 메뉴도 열지 않는다

  // ---------- 텍스처와 재질 (공유) ----------
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,.95)'); grad.addColorStop(0.45, 'rgba(255,255,255,.4)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    return keep(new THREE.CanvasTexture(c));
  })();
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.strokeStyle = '#fff'; g.lineWidth = 7; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
    return keep(new THREE.CanvasTexture(c));
  })();
  const heavy = nodes.length > 400;                                          // 노드가 많으면 구를 거칠게, 후광은 줄여 프레임을 지킨다
  const sphereGeo = keep(heavy ? new THREE.SphereGeometry(1, 10, 7) : new THREE.SphereGeometry(1, 24, 16));
  const solidMats = new Map<string, any>();
  const dimMats = new Map<string, any>();
  const solid = (hex: string, dim: boolean) => {
    const cache = dim ? dimMats : solidMats;
    let m = cache.get(hex);
    if (!m) { m = keep(new THREE.MeshLambertMaterial({ color: hex, transparent: true, opacity: dim ? 0.28 : 0.93 })); cache.set(hex, m); }
    return m;
  };
  const haloMats = new Map<string, any>();
  const halo = (hex: string) => {
    let m = haloMats.get(hex);
    if (!m) { m = keep(new THREE.SpriteMaterial({ map: glowTex, color: hex, transparent: true, depthWrite: false, opacity: 0.5 })); haloMats.set(hex, m); }
    return m;
  };
  const haloMatFor = new Map<string, any>();                              // 노드마다 불투명도가 달라서 복제본을 쓴다

  // ---------- 노드 ----------
  interface Item { node: GraphNode; group: any; sphere: any; halo: any; badge: any | null; r: number; label: any | null; labelKey: string; pos: any }
  const items = new Map<string, Item>();
  const pickables: any[] = [];
  const root = new THREE.Group();
  scene.add(root);
  nodes.forEach(n => {
    const p = placed.get(n.id) ?? { x: 0, y: 0, z: 0 };
    const r = RADIUS[n.kind];
    const group = new THREE.Group();
    group.position.set(p.x, p.y, p.z);
    const sphere = new THREE.Mesh(sphereGeo, solid(sphereColor(n), false));
    sphere.scale.setScalar(r);
    sphere.userData.id = n.id;
    const hm = keep(halo(haloColor(n)).clone());
    haloMatFor.set(n.id, hm);
    const haloSprite = new THREE.Sprite(hm);
    haloSprite.scale.setScalar(r * 5);
    if (!heavy) group.add(haloSprite);
    group.add(sphere);
    let badge: any = null;
    if ((n.rules ?? 0) > 0) {                                              // 조립 규칙이 연결된 부품의 표식
      badge = new THREE.Mesh(sphereGeo, solid(BADGE_COLOR, false));
      badge.scale.setScalar(Math.max(0.9, r * 0.34));
      badge.position.set(r * 0.85, r * 0.85, 0);
      group.add(badge);
    }
    root.add(group);
    pickables.push(sphere);
    items.set(n.id, { node: n, group, sphere, halo: haloSprite, badge, r, label: null, labelKey: '', pos: group.position });
  });

  // ---------- 간선 ----------
  const edgePairs = graph.edges.filter(e => items.has(e.from) && items.has(e.to));
  const linePositions = new Float32Array(edgePairs.length * 6);
  edgePairs.forEach((e, i) => {
    const a = items.get(e.from)!.pos, b = items.get(e.to)!.pos;
    linePositions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
  });
  const lineGeo = keep(new THREE.BufferGeometry());
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const lineMat = keep(new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.32, depthWrite: false }));
  root.add(new THREE.LineSegments(lineGeo, lineMat));
  const hotMat = keep(new THREE.LineBasicMaterial({ color: 0x0369a1, transparent: true, opacity: 0.95, depthWrite: false }));
  let hotLines: any = null;

  // ---------- 선택 고리 ----------
  const ringMat = keep(new THREE.SpriteMaterial({ map: ringTex, color: '#0891b2', transparent: true, depthWrite: false, opacity: 0.9 }));
  const ring = new THREE.Sprite(ringMat);
  ring.visible = false;
  root.add(ring);

  // ---------- 라벨 (필요할 때 만든다) ----------
  const labelTex = new Map<string, any>();
  const labelMats = new Map<string, any>();
  const makeLabel = (text: string, sub: string | undefined, big: boolean) => {
    const k = `${text}\u0001${sub ?? ''}\u0001${big ? 1 : 0}`;
    let entry = labelTex.get(k);
    if (!entry) {
      const c = document.createElement('canvas');
      const g = c.getContext('2d')!;
      const main = '600 26px Inter, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
      const small = '500 21px "JetBrains Mono", Consolas, monospace';
      g.font = main; const w1 = g.measureText(text).width;
      g.font = small; const w2 = sub ? g.measureText(sub).width : 0;
      c.width = Math.ceil(Math.max(w1, w2) + 28); c.height = sub ? 68 : 40;
      g.font = main; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 7; g.strokeStyle = 'rgba(255,255,255,.95)'; g.fillStyle = '#0b1c30';
      g.strokeText(text, c.width / 2, sub ? 19 : 20); g.fillText(text, c.width / 2, sub ? 19 : 20);
      if (sub) { g.font = small; g.lineWidth = 5; g.fillStyle = '#475569'; g.strokeText(sub, c.width / 2, 50); g.fillText(sub, c.width / 2, 50); }
      const tex = keep(new THREE.CanvasTexture(c));
      entry = { tex, aspect: c.width / c.height, h: sub ? 6.2 : 4.2 };
      labelTex.set(k, entry);
    }
    let mat = labelMats.get(k);
    if (!mat) { mat = keep(new THREE.SpriteMaterial({ map: entry.tex, transparent: true, depthTest: false, depthWrite: false })); labelMats.set(k, mat); }
    return { mat, aspect: entry.aspect, h: entry.h * (big ? 1.12 : 1) };
  };
  const short = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

  const manyNodes = nodes.length > 40;
  let selected: string | null = null;
  let hover: string | null = null;
  let nearIds = new Set<string>();

  const refreshLabels = () => {
    items.forEach((it, id) => {
      const isSel = id === selected, isHover = id === hover, isNear = nearIds.has(id);
      const show = !manyNodes || it.node.level <= 1 || isSel || isHover || isNear;
      if (!show) { if (it.label) it.label.visible = false; return; }
      const withSub = isSel && !!it.node.sub;
      const key = `${id}|${withSub ? 's' : 'n'}`;
      if (!it.label || it.labelKey !== key) {
        if (it.label) it.group.remove(it.label);
        const { mat, aspect, h } = makeLabel(short(it.node.label), withSub ? it.node.sub : undefined, isSel);
        const sp = new THREE.Sprite(mat);
        sp.userData.base = [h * aspect, h];
        sp.scale.set(h * aspect, h, 1);
        sp.position.set(0, it.r * 1.15 + h * 0.62, 0);
        sp.renderOrder = 20;
        it.group.add(sp);
        it.label = sp; it.labelKey = key;
      }
      it.label.visible = true;
    });
  };

  // ---------- 선택 ----------
  let edgeLabelSprites: any[] = [];
  const clearEdgeLabels = () => { edgeLabelSprites.forEach(s => root.remove(s)); edgeLabelSprites = []; };
  let focus: { t0: number; from: any; delta: any; camFrom: any } | null = null;

  const applyStates = () => {
    items.forEach((it, id) => {
      const state = selected === null ? 'normal' : id === selected ? 'selected' : nearIds.has(id) ? 'near' : 'dim';
      const dim = state === 'dim';
      it.sphere.material = solid(sphereColor(it.node), dim);
      it.sphere.scale.setScalar(it.r * (state === 'selected' ? 1.22 : 1));
      if (it.badge) it.badge.material = solid(BADGE_COLOR, dim);
      const hm = haloMatFor.get(id);
      hm.opacity = state === 'selected' ? 0.85 : state === 'near' ? 0.62 : dim ? 0.1 : 0.5;
    });
    lineMat.opacity = selected ? 0.12 : 0.32;
  };

  const select = (id: string | null) => {
    const next = id && items.has(id) ? id : null;
    selected = next;
    nearIds = next ? neighbors(graph, next) : new Set();
    applyStates();
    refreshLabels();

    if (hotLines) { root.remove(hotLines); hotLines.geometry.dispose(); hotLines = null; }
    clearEdgeLabels();
    if (next) {
      const mine = edgePairs.filter(e => e.from === next || e.to === next);
      const arr = new Float32Array(mine.length * 6);
      mine.forEach((e, i) => {
        const a = items.get(e.from)!.pos, b = items.get(e.to)!.pos;
        arr.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      hotLines = new THREE.LineSegments(g, hotMat);
      root.add(hotLines);
      mine.filter(e => e.label).slice(0, 30).forEach(e => {                // 수량 같은 간선 이름은 선택했을 때만
        const a = items.get(e.from)!.pos, b = items.get(e.to)!.pos;
        const { mat, aspect, h } = makeLabel(e.label!, undefined, false);
        const sp = new THREE.Sprite(mat);
        sp.scale.set(h * 0.8 * aspect, h * 0.8, 1);
        sp.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        sp.renderOrder = 19;
        root.add(sp);
        edgeLabelSprites.push(sp);
      });
      const it = items.get(next)!;
      ring.visible = true;
      ring.position.copy(it.pos);
      ring.scale.setScalar(it.r * 4.4);
    } else ring.visible = false;

    // 카메라는 보는 방향을 그대로 두고 초점만 그 노드로 옮긴다
    const to = next ? items.get(next)!.pos : new THREE.Vector3(0, 0, 0);
    focus = { t0: performance.now(), from: controls.target.clone(), delta: to.clone().sub(controls.target), camFrom: camera.position.clone() };
    stopAuto();
  };

  // ---------- 입력 ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickAt = (clientX: number, clientY: number): string | null => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? (hit.object.userData.id as string) : null;
  };
  let down: { x: number; y: number; t: number } | null = null;
  let hoverAt: { x: number; y: number } | null = null;
  let dragging = false;
  const onDown = (e: PointerEvent) => { if (e.button === 0) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; dragging = true; } };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    if (e.button !== 0 || !down) return;                                    // 오른쪽 버튼은 아무 일도 하지 않는다
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 6 || dt > 600) return;                                      // 끌었으면 선택이 아니다
    const id = pickAt(e.clientX, e.clientY);
    select(id);
    hooks.onSelect(id);
  };
  const onMove = (e: PointerEvent) => { hoverAt = { x: e.clientX, y: e.clientY }; };
  const onLeave = () => { hoverAt = null; if (hover) { hover = null; hooks.setPointer(false); refreshLabels(); } };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  // ---------- 크기 ----------
  const resize = () => {
    const w = host.clientWidth || 640, h = host.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dist = fitDistance(camera.aspect);
    controls.maxDistance = dist * 2.4;
    if (!moved) camera.position.setLength(dist);
  };
  resize();
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(resize); ro.observe(host); } else window.addEventListener('resize', resize);

  // ---------- 그리기 ----------
  let raf = 0, destroyed = false;
  const tick = (now: number) => {
    if (destroyed) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    if (focus) {
      const t = Math.min(1, (now - focus.t0) / 650), e = 1 - Math.pow(1 - t, 3);
      controls.target.copy(focus.from).addScaledVector(focus.delta, e);
      camera.position.copy(focus.camFrom).addScaledVector(focus.delta, e);
      if (t >= 1) focus = null;
    }
    controls.update();
    // 라벨은 거리에 따라 크기를 보정해 가까운 것이 화면을 덮지 않고 먼 것도 읽히게 한다
    items.forEach(it => {
      const sp = it.label;
      if (!sp || !sp.visible) return;
      // 글자 크기는 화면 픽셀로 고정한다: 월드 크기로 두면 화면이 좁거나 멀리 볼 때 읽을 수 없게 작아진다
      const wpp = (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(it.pos)) / Math.max(1, canvas.clientHeight);
      const k = (canvas.clientWidth < 480 ? 3.7 : 4.6) * wpp;
      const [bw, bh] = sp.userData.base;
      sp.scale.set(bw * k, bh * k, 1);
      sp.position.y = it.r * 1.15 + bh * k * 0.62;
    });
    if (hoverAt && !dragging) {
      const id = pickAt(hoverAt.x, hoverAt.y);
      if (id !== hover) { hover = id; hooks.setPointer(!!id); refreshLabels(); }
      hoverAt = null;
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);
  controls.addEventListener('start', () => { focus = null; });

  select(initial);
  focus = null;                                                              // 처음 선택은 애니메이션 없이

  return {
    select,
    dispose() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('contextmenu', noMenu);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      controls.removeEventListener('start', stopAuto);
      controls.dispose();
      if (hotLines) hotLines.geometry.dispose();
      disposables.forEach(d => d.dispose());
      renderer.dispose();
      canvas.remove();
    },
  };
}

/**
 * 연결 그래프의 3D 보기. 노드는 구 + 후광, 간선은 시안 선. 왼쪽 드래그로 돌리고 휠로 확대한다.
 * 오른쪽 버튼 이동 · 브라우저 메뉴는 없다. WebGL 을 못 쓰면 onUnsupported 를 한 번 부르고 안내만 보인다
 * (부모가 같은 그래프를 GraphList 로 보여 준다).
 */
export default function Graph3DScene({ graph, selectedId = null, onSelect, label, onUnsupported }: Graph3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneApi | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [pointer, setPointer] = useState(false);
  const failed = useRef(false);
  const reported = useRef(false);
  const latest = useRef({ graph, selectedId, onSelect, onUnsupported });
  latest.current = { graph, selectedId, onSelect, onUnsupported };
  const key = useMemo(() => graphKey(graph), [graph]);

  useEffect(() => {
    const el = host.current;
    if (!el || failed.current) return;
    let built: SceneApi;
    try {
      built = buildScene(el, latest.current.graph, { onSelect: id => latest.current.onSelect(id), setPointer }, latest.current.selectedId ?? null);
    } catch {
      failed.current = true;
      setUnsupported(true);
      if (!reported.current) { reported.current = true; latest.current.onUnsupported?.(); }
      return;
    }
    scene.current = built;
    return () => { built.dispose(); scene.current = null; };
  }, [key]);

  useEffect(() => { scene.current?.select(selectedId ?? null); }, [selectedId]);

  if (unsupported) {
    return (
      <div className="graph3d graph3d-fallback" role="img" aria-label={label}>
        <p>3D를 사용할 수 없어 목록으로 보여 드립니다.</p>
      </div>
    );
  }
  return (
    <div ref={host} className={`graph3d ${pointer ? 'is-pointer' : ''}`} role="img" aria-label={label}>
      <i className="graph3d-corner graph3d-tl" aria-hidden /><i className="graph3d-corner graph3d-tr" aria-hidden />
      <i className="graph3d-corner graph3d-bl" aria-hidden /><i className="graph3d-corner graph3d-br" aria-hidden />
    </div>
  );
}
