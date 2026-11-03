import fs from "fs";

export const parseBeatmapContent = (content) => {
  const lines = content.split(/\r?\n/);
  let currentSection = "";

  const metadata = {
    title: "Unknown Beatmap",
    artist: "Unknown Artist",
    version: "Normal",
    creator: "Unknown",
  };

  const difficulty = {
    hp: 5,
    cs: 4,
    od: 5,
    ar: 5,
  };

  const hitObjects = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1);
      continue;
    }

    if (currentSection === "Metadata") {
      const [key, ...vals] = line.split(":");
      const val = vals.join(":").trim();
      if (key === "Title") metadata.title = val;
      if (key === "Artist") metadata.artist = val;
      if (key === "Version") metadata.version = val;
      if (key === "Creator") metadata.creator = val;
    } else if (currentSection === "Difficulty") {
      const [key, ...vals] = line.split(":");
      const val = parseFloat(vals.join(":").trim());
      if (key === "HPDrainRate" && !isNaN(val)) difficulty.hp = val;
      if (key === "CircleSize" && !isNaN(val)) difficulty.cs = val;
      if (key === "OverallDifficulty" && !isNaN(val)) difficulty.od = val;
      if (key === "ApproachRate" && !isNaN(val)) difficulty.ar = val;
    } else if (currentSection === "HitObjects") {
      const parts = line.split(",");
      if (parts.length >= 4) {
        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);
        const time = parseInt(parts[2], 10);
        const typeBitmask = parseInt(parts[3], 10);

        let type = "circle";
        if (typeBitmask & 2) type = "slider";
        else if (typeBitmask & 8) type = "spinner";

        // Standard osu! radius based on Circle Size (CS)
        const radius = Math.round(54.4 - 4.48 * (difficulty.cs || 4));

        hitObjects.push({
          x,
          y,
          time,
          type,
          radius: Math.max(16, radius),
        });
      }
    }
  }

  // Hit windows based on Overall Difficulty (OD) in milliseconds
  const od = difficulty.od || 5;
  const hitWindows = {
    300: Math.round(80 - 6 * od),
    100: Math.round(140 - 8 * od),
    50: Math.round(200 - 10 * od),
  };

  return {
    metadata,
    difficulty,
    hitWindows,
    totalObjects: hitObjects.length,
    durationMs: hitObjects.length > 0 ? hitObjects[hitObjects.length - 1].time : 0,
    hitObjects,
  };
};

export const parseBeatmapFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Beatmap file not found at ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return parseBeatmapContent(content);
};
