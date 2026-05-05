import type {
	LyricLine as CoreLyricLine,
	LyricWord,
} from "@applemusic-like-lyrics/core";
import {
	type LyricBase,
	type Syllable,
	TTMLParser,
} from "@applemusic-like-lyrics/ttml";

const Values = {
	AgentDefault: "v1",
	Group: "group",
	Other: "other",
	MusicName: "musicName",
	Artists: "artists",
	Album: "album",
	ISRC: "isrc",
	TTMLAuthorGithub: "ttmlAuthorGithub",
	TTMLAuthorGithubLogin: "ttmlAuthorGithubLogin",
	Language: "language",
	TimingMode: "timingMode",
	NCMMusicId: "ncmMusicId",
	QQMusicId: "qqMusicId",
	SpotifyId: "spotifyId",
	AppleMusicId: "appleMusicId",
};

const Elements = {
	Songwriters: "songwriters",
};

function getBestTranslation(
	availableLangs: Set<string>,
	targetLang?: string,
): string | undefined {
	if (availableLangs.size === 0) return undefined;
	const langsArray = Array.from(availableLangs);
	if (!targetLang) return langsArray[0];

	try {
		const target = new Intl.Locale(targetLang).maximize();
		const targetBase = `${target.language}-${target.script}`;
		const targetLanguageOnly = target.language;

		for (const lang of langsArray) {
			try {
				const current = new Intl.Locale(lang).maximize();
				if (`${current.language}-${current.script}` === targetBase) {
					return lang;
				}
			} catch (e) {
				console.warn("解析翻译语言代码", lang, "错误", e);
			}
		}

		for (const lang of langsArray) {
			try {
				const current = new Intl.Locale(lang).maximize();
				if (current.language === targetLanguageOnly) {
					return lang;
				}
			} catch (e) {
				console.warn("解析翻译语言代码", lang, "错误", e);
			}
		}

		return langsArray[0];
	} catch (e) {
		console.warn("解析目标语言代码时出现错误", e);
		return langsArray[0];
	}
}

export interface TTMLParserResult {
	lines: CoreLyricLine[];
	metadata: [string, string[]][];
}

export function handleTTMLParsing(
	lyricStr: string,
	displayLang?: string,
): TTMLParserResult {
	const parser = new TTMLParser();
	const result = parser.parse(lyricStr);

	const availableTransLangs = new Set<string>();
	for (const line of result.lines) {
		if (line.translations) {
			for (const t of line.translations) {
				if (t.language) availableTransLangs.add(t.language);
			}
		}
		if (line.backgroundVocal?.translations) {
			for (const t of line.backgroundVocal.translations) {
				if (t.language) availableTransLangs.add(t.language);
			}
		}
	}
	const targetTransLang = getBestTranslation(availableTransLangs, displayLang);

	const amllLines: CoreLyricLine[] = [];

	// https://github.com/amll-dev/applemusic-like-lyrics/blob/ab07d7205dd43bf3a0523eaeed9bd8ce589b9199/packages/ttml/src/utils/amll-converter.ts#L24
	const convertToAmllLine = (
		source: LyricBase,
		isBG: boolean,
		isDuet: boolean,
	): CoreLyricLine => {
		let amllWords: LyricWord[] = [];

		if (source.words && source.words.length > 0) {
			amllWords = source.words.map((w) => {
				const amllWord: LyricWord = {
					startTime: w.startTime,
					endTime: w.endTime,
					word: w.text + (w.endsWithSpace ? " " : ""),
					romanWord: "",
					obscene: w.obscene,
				};

				if (w.ruby && w.ruby.length > 0) {
					amllWord.ruby = w.ruby.map((r) => ({
						startTime: r.startTime,
						endTime: r.endTime,
						word: r.text,
					}));
				}

				return amllWord;
			});
		} else {
			amllWords = [
				{
					startTime: source.startTime,
					endTime: source.endTime,
					word: source.text,
					romanWord: "",
				},
			];
		}

		let transText = "";
		if (
			source.translations &&
			source.translations.length > 0 &&
			targetTransLang
		) {
			const targetTrans = source.translations.find(
				(t) => t.language === targetTransLang,
			);
			if (targetTrans) {
				transText = targetTrans.text;
			}
		}

		let romanText = "";
		let romanWords: Syllable[] | undefined;
		if (source.romanizations && source.romanizations.length > 0) {
			const targetRoman = source.romanizations[0];

			romanWords = targetRoman.words;

			if (!romanWords || romanWords.length === 0) {
				romanText = targetRoman.text;
			}
		}

		if (romanWords && amllWords.length > 0) {
			alignRomanization(amllWords, romanWords);
		}

		return {
			words: amllWords,
			translatedLyric: transText,
			romanLyric: romanText,
			isBG: isBG,
			isDuet: isDuet,
			startTime: source.startTime,
			endTime: source.endTime,
		};
	};

	let lastPersonAgentId: string | null = null;
	let lastPersonIsDuet: boolean = false;

	for (const line of result.lines) {
		const agentId = line.agentId || Values.AgentDefault;
		const agent = result.metadata.agents?.[agentId];
		const isGroup = agent?.type === Values.Group;
		const isOther = agent?.type === Values.Other;

		let currentIsDuet = false;

		// Apple Music 风格的对唱识别逻辑
		if (isGroup) {
			// 合唱始终非对唱，且不影响其他 agent type 的交替计算
			currentIsDuet = false;
		} else {
			if (lastPersonAgentId === null) {
				// 如果第一次遇到的演唱者类型是 Other，强制为对唱，否则非对唱
				currentIsDuet = !!isOther;
				lastPersonAgentId = agentId;
				lastPersonIsDuet = currentIsDuet;
			} else if (lastPersonAgentId === agentId) {
				// 与上一个非 Group 演唱者相同，保持对唱状态
				currentIsDuet = lastPersonIsDuet;
			} else {
				// 与上一个非 Group 演唱者不同，翻转对唱侧
				currentIsDuet = !lastPersonIsDuet;
				lastPersonAgentId = agentId;
				lastPersonIsDuet = currentIsDuet;
			}
		}

		const amllMain = convertToAmllLine(line, false, currentIsDuet);
		amllLines.push(amllMain);

		if (line.backgroundVocal) {
			const simpleBg = convertToAmllLine(
				line.backgroundVocal,
				true,
				currentIsDuet,
			);
			amllLines.push(simpleBg);
		}
	}

	const amllMetadata: [string, string[]][] = [];
	const meta = result.metadata;

	if (meta.title) amllMetadata.push([Values.MusicName, meta.title]);
	if (meta.artist) amllMetadata.push([Values.Artists, meta.artist]);
	if (meta.album) amllMetadata.push([Values.Album, meta.album]);
	if (meta.isrc) amllMetadata.push([Values.ISRC, meta.isrc]);
	if (meta.authorIds)
		amllMetadata.push([Values.TTMLAuthorGithub, meta.authorIds]);
	if (meta.authorNames)
		amllMetadata.push([Values.TTMLAuthorGithubLogin, meta.authorNames]);

	if (meta.language) amllMetadata.push([Values.Language, [meta.language]]);
	if (meta.timingMode)
		amllMetadata.push([Values.TimingMode, [meta.timingMode]]);
	if (meta.songwriters)
		amllMetadata.push([Elements.Songwriters, meta.songwriters]);

	if (meta.platformIds) {
		if (meta.platformIds.ncmMusicId)
			amllMetadata.push([Values.NCMMusicId, meta.platformIds.ncmMusicId]);
		if (meta.platformIds.qqMusicId)
			amllMetadata.push([Values.QQMusicId, meta.platformIds.qqMusicId]);
		if (meta.platformIds.spotifyId)
			amllMetadata.push([Values.SpotifyId, meta.platformIds.spotifyId]);
		if (meta.platformIds.appleMusicId)
			amllMetadata.push([Values.AppleMusicId, meta.platformIds.appleMusicId]);
	}

	if (meta.rawProperties) {
		for (const [key, value] of Object.entries(meta.rawProperties)) {
			amllMetadata.push([key, value]);
		}
	}

	return {
		lines: amllLines,
		metadata: amllMetadata,
	};
}

function alignRomanization(amllWords: LyricWord[], romanWords: Syllable[]) {
	let i = 0;
	let j = 0;
	const TIME_TOLERANCE_MS = 30;

	while (i < amllWords.length && j < romanWords.length) {
		const main = amllWords[i];
		const sub = romanWords[j];

		if (Math.abs(main.startTime - sub.startTime) < TIME_TOLERANCE_MS) {
			main.romanWord = sub.text;
			i++;
			j++;
		} else if (sub.startTime < main.startTime) {
			j++;
		} else {
			i++;
		}
	}
}
