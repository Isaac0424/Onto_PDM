// explode-studio — CAD exploded-view studio as an embeddable ES module.
export { mountExplodeStudio, parseLooseJson } from './studio.js';
// the geometry / grouping / motion / manual-search logic, usable on its own (no DOM, no three.js)
export * as core from './core.js';
