// three 는 타입 패키지(@types/three)를 두지 않았다. Graph3D 가 쓰는 부분만 느슨하게 가져온다 (뷰어 src/studio.js 도 타입 없이 쓴다).
declare module 'three';
declare module 'three/examples/jsm/controls/OrbitControls.js';
