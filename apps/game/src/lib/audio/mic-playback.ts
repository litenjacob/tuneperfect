import * as v from "valibot";

export const MAX_MIC_PLAYBACK_GAIN = 4;
export const micPlaybackVolumeSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_MIC_PLAYBACK_GAIN));

export const mixLevelSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
