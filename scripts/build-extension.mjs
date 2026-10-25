import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {extensionIdFromKey} from '../native/install-paths.mjs';
import {extractPageMedia} from '../src/page-extract.mjs';
import {pageExtractInjection} from './page-extract-inject.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist', 'extension');
await rm(output, {recursive: true, force: true});
await cp(join(root, 'extension'), output, {recursive: true});
await mkdir(join(output, 'shared'), {recursive: true});
await cp(join(root, 'src', 'urls.mjs'), join(output, 'shared', 'urls.mjs'));
for (const name of ['controller.mjs', 'background.mjs']) {
	const source = await readFile(join(output, name), 'utf8');
	await writeFile(join(output, name), source.replaceAll("'../src/", "'./shared/"));
}
await writeFile(
	join(output, 'shared', 'page-extract.inject.js'),
	pageExtractInjection(extractPageMedia),
);

const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
const id = extensionIdFromKey(manifest.key);
console.log(`扩展已构建：${output}\n扩展 ID：${id}`);
