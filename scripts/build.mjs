import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const web = join(root, 'web');

const common = {
  entryPoints: [join(root, 'src/ui/main.ts')],
  bundle: true,
  target: 'es2022',
  minify: true,
};

await mkdir(dist, { recursive: true });

// 1. The hosted build: an ES-module bundle beside the page files.
await build({ ...common, format: 'esm', sourcemap: true, outfile: join(dist, 'app.js') });

for (const name of await readdir(web)) {
  await cp(join(web, name), join(dist, name));
}

// 2. The offline build: one HTML file, styles and script inlined. The bundle has to
//    be an IIFE — a `type=module` script is blocked by CORS when the page is file://.
const iife = await build({ ...common, format: 'iife', write: false, outfile: join(dist, 'inline.js') });
const script = iife.outputFiles[0].text;
const css = await readFile(join(web, 'style.css'), 'utf8');

let html = await readFile(join(web, 'index.html'), 'utf8');
const before = html;
html = html.replace(
  /\s*<link rel="stylesheet"[^>]*>/,
  `\n  <style>\n${css}\n  </style>`,
);
// A module script is deferred; a plain inline one is not, so it has to move to the end of
// <body> or it runs before #app exists.
html = html.replace(/\s*<script type="module"[^>]*><\/script>/, '');
html = html.replace(
  '</body>',
  `<script>\n${script.replace(/<\/script>/gi, '<\\/script>')}\n</script>\n</body>`,
);
if (html === before) throw new Error('single-file build: neither the stylesheet link nor the module script matched');
if (/<link rel="stylesheet"|<script type="module"/.test(html)) {
  throw new Error('single-file build: an external asset reference survived inlining');
}
// There is no sibling LICENSE-map.txt to link to, so the offline copy carries the whole
// notice inline: the footer link points at an overlay revealed by `:target` (see
// `.licence-page` in style.css), which needs no script and works from file://.
const mapLicence = await readFile(join(web, 'LICENSE-map.txt'), 'utf8');
const escaped = mapLicence.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
html = html.replace(/<a href="LICENSE-map\.txt">GPL<\/a>/, '<a href="#map-licence">GPL</a>');
if (!html.includes('href="#map-licence"')) {
  throw new Error('single-file build: the map-licence footer link did not match');
}
html = html.replace(
  '</body>',
  `<section id="map-licence" class="licence-page"><a href="#">close</a><pre>${escaped}</pre></section>\n</body>`,
);
html = html.replace(/\s*<span class="offline-link">[\s\S]*?<\/span>/, '');

await writeFile(join(dist, 'conway-diplomacy.html'), html);

console.log('dist/app.js, dist/index.html, dist/style.css, dist/LICENSE-map.txt, dist/conway-diplomacy.html');
