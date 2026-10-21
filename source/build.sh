set -e
cd /home/claude/explode
{
cat head.html
cat body.html
cat <<'X'
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/STLLoader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/OBJLoader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/GLTFLoader.js"></script>
<script>
X
cat core.js demo.js app.js
cat <<'X'
resize(); loadWatch(); requestAnimationFrame(frame);
</script>
X
} > site/index.html
P=/tmp/claude-0/-home-claude/52b2366f-6e38-51cd-9ba0-6e1a57b8480c/scratchpad/pkg/occt-import-js
cp $P/dist/occt-import-js.js $P/dist/occt-import-js.wasm $P/dist/occt-import-js-worker.js site/
cp $P/test/testfiles/cax-if/as1-oc-214.stp site/sample-as1.stp
