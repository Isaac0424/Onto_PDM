export interface AiRequest {
  /** Full prompt the studio built (parts, sub-assemblies, manual excerpts, required JSON shape). */
  prompt: string;
  /** 'default' for the one-time naming pass, 'quick' for a single part. */
  tier: 'default' | 'quick' | 'complex';
  signal?: AbortSignal;
}

export interface StudioOptions {
  /** URL folder serving occt-import-js.js, occt-import-js.wasm and occt-import-js-worker.js. Default '/occt/'. */
  assetsBase?: string;
  /** URL folder serving pdf.min.js and pdf.worker.min.js (pdf.js 3.x). Default: cdnjs pdf.js 3.11.174. */
  pdfjsBase?: string;
  /** Your own AI call. Return the parsed JSON object, or the raw model text (it is parsed leniently). */
  ai?: (req: AiRequest) => Promise<unknown>;
  /** Or an HTTP endpoint: POST {prompt, tier} → {text} or {json}. See server/claude-endpoint.mjs. */
  aiEndpoint?: string;
  /** Example to show at start: 'watch' (default), 'box', or null for an empty stage. */
  initial?: 'watch' | 'box' | null;
  /** 'holo' (navy + cyan, default), 'glass' (light frosted glass + cyan lines) or 'classic' (dark, brass). */
  skin?: 'holo' | 'glass' | 'classic';
  /** false: hide the red/green/blue base-frame axes. Default true. */
  axes?: boolean;
  /** false: the right mouse button and two-finger drag do nothing and the browser menu stays closed over the stage. Default true. */
  pan?: boolean;
  /** false: draw only the 3D stage, story and controls. The host page supplies title bar, file pickers and part list. Default true. */
  chrome?: boolean;
  /** Load the IBM Plex fonts from Google Fonts. Default true. */
  fonts?: boolean;
  /** Heading shown at the top. Default '분해도 스튜디오'. */
  title?: string;
  /** URL of a STEP file offered as an example button (hidden when not set). */
  sampleStepUrl?: string | null;
}

export interface StudioState {
  model: string; parts: number; layers: number; maxLayers: number; step: number;
  /** 0 = assembled … 1 = fully exploded */
  exploded: number;
  base: string | null; picked: string | null; layerTitles: string[];
}

export interface PartInfo {
  id: number;
  /** name in the CAD file */
  name: string;
  /** CAD assembly path, e.g. '무브먼트 / 동력' */
  path: string;
  /** index into getLayers(), -1 if none */
  layer: number;
  /** Korean name from the AI pass, '' if none */
  ko: string;
  /** bounding box size (x, y, z) in `unit`, null if unknown */
  size: [number, number, number] | null;
  unit: string;
}

/** Read-only copy of one part's triangle mesh (see StudioApi.getPartGeometry). */
export interface PartGeometry {
  name: string;
  /** unit of the coordinates: 'mm', 'cm', 'm', 'in' … or '단위' when the file has no unit (STL, OBJ) */
  unit: string;
  /** x y z per vertex */
  positions: Float32Array;
  /** triangle vertex numbers; absent when `positions` is already a plain triangle list (every 9 numbers = one triangle) */
  indices?: Uint32Array;
}

export interface LayerInfo {
  index: number;
  /** pass to go() to show this layer (step 0 = assembled, 1 = exploded) */
  step: number;
  title: string;
  partIds: number[];
}

export type FileSource = File | Blob | { name: string; data: ArrayBuffer };

export interface StudioApi {
  root: HTMLElement;
  loadFile(src: FileSource): Promise<StudioState>;
  loadUrl(url: string, name?: string): Promise<StudioState>;
  loadSpec(src: FileSource): Promise<void>;
  loadExample(which: 'watch' | 'box'): void;
  setLayerCount(n: number): number;
  go(step: number): void;
  next(): void;
  prev(): void;
  explode(): void;
  assemble(): void;
  play(): void;
  /** Start the guided tour from step 1 (play() toggles; this always restarts). */
  replay(): void;
  /** Turn the slow auto-rotation on or off. */
  setSpin(on: boolean): void;
  /** Select by part id or CAD name (repeat the name to step through copies). */
  selectPart(nameOrId: string | number, focus?: boolean): void;
  alignView(): void;
  runAi(): Promise<void>;
  getState(): StudioState;
  getParts(): PartInfo[];
  /** Triangle mesh of one part (by id or CAD name) for shape analysis; null if the part has no geometry. A copy: changing it does not touch the scene. */
  getPartGeometry(nameOrId: string | number): PartGeometry | null;
  getLayers(): LayerInfo[];
  on(type: 'model', fn: (d: { name: string; parts: number }) => void): () => void;
  on(type: 'step', fn: (d: { step: number; layer: number }) => void): () => void;
  /** id -1 (name '') when the selection is cleared */
  on(type: 'select', fn: (d: { id: number; name: string; layer: number }) => void): () => void;
  /** the number of steps changed (setLayerCount) */
  on(type: 'layers', fn: (d: { layers: number }) => void): () => void;
  destroy(): void;
}

export function mountExplodeStudio(container: HTMLElement, options?: StudioOptions): StudioApi;
export function parseLooseJson(text: string): unknown;
export const core: Record<string, unknown>;
