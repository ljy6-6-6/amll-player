import { atom } from "jotai";
import {
	DEFAULT_HOME_BACKGROUND_CONFIG,
	type HomeBackgroundConfig,
} from "../utils/home-background-state.ts";

export const homeBackgroundConfigAtom = atom<HomeBackgroundConfig>(
	DEFAULT_HOME_BACKGROUND_CONFIG,
);

export const homeBackgroundLoadedAtom = atom(false);
