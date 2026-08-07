import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const playlistPage = readProjectFile("../src/pages/playlist/index.tsx");
const playlistPageStyle = readProjectFile(
	"../src/pages/playlist/index.module.css",
);

test("歌单数据返回前由主题加载面承接首帧", () => {
	assert.match(
		playlistPage,
		/const \{ data: playlist, loading: playlistLoading \} = useDbQuery/,
	);
	assert.match(
		playlistPage,
		/if \(playlistLoading && playlist === undefined\) \{[\s\S]*className=\{styles\.loadingSurface\}[\s\S]*<Spinner size="3" \/>/,
	);
	assert.match(playlistPage, /i18nKey="page\.main\.loadingPlaylist"/);
	assert.match(
		playlistPageStyle,
		/\.loadingSurface\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*background-color:\s*var\(--color-background\)/,
	);
});
