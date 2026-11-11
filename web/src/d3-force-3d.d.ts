// d3-force-3d 는 타입을 주지 않는다. 우리가 쓰는 부분만 선언한다 (순수 계산 라이브러리라 네트워크 호출이 없다).
declare module 'd3-force-3d' {
  export interface SimNode { index?: number; x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number; [key: string]: unknown }
  export interface Force<N extends SimNode> { (alpha: number): void; initialize?(nodes: N[], ...rest: unknown[]): void }
  export interface Simulation<N extends SimNode> {
    force(name: string, force: Force<N> | null): this;
    stop(): this;
    tick(iterations?: number): this;
    alpha(value: number): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends SimNode>(nodes: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;
  export interface LinkForce<N extends SimNode> extends Force<N> {
    id(fn: (node: N) => string): this;
    distance(d: number | ((link: unknown) => number)): this;
    strength(s: number | ((link: unknown) => number)): this;
  }
  export function forceLink<N extends SimNode>(links: { source: string | N; target: string | N }[]): LinkForce<N>;
  export interface ManyBodyForce<N extends SimNode> extends Force<N> {
    strength(s: number | ((node: N) => number)): this;
    distanceMax(d: number): this;
  }
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>;
  export function forceRadial<N extends SimNode>(radius: number | ((node: N) => number), x?: number, y?: number, z?: number): Force<N> & { strength(s: number): Force<N> };
  export function forceCenter<N extends SimNode>(x?: number, y?: number, z?: number): Force<N>;
  export function forceCollide<N extends SimNode>(radius?: number | ((node: N) => number)): Force<N>;
}
