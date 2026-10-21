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
  /** Select by part id or CAD name (repeat the name to step through copies). */
  selectPart(nameOrId: string | number, focus?: boolean): void;
  alignView(): void;
  runAi(): Promise<void>;
  getState(): StudioState;
  on(type: 'model', fn: (d: { name: string; parts: number }) => void): () => void;
  on(type: 'step', fn: (d: { step: number; layer: number }) => void): () => void;
  on(type: 'select', fn: (d: { id: number; name: string; layer: number }) => void): () => void;
  destroy(): void;
}

export function mountExplodeStudio(container: HTMLElement, options?: StudioOptions): StudioApi;
export function parseLooseJson(text: string): unknown;
export const core: Record<string, unknown>;
