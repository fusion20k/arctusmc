const COLOR_ADJECTIVES: Record<string, string> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  brown: "brown",
  black: "black",
  white: "white",
  gray: "gray",
  dark: "dark",
  light: "light",
  colorful: "colorful",
  monochrome: "monochromatic",
};

const DERIVED_SLUGS = new Set(["dark", "light", "colorful", "monochrome"]);

const DISPLAY_NAME_LABELS: Record<string, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  brown: "Brown",
  black: "Black",
  white: "White",
  gray: "Gray",
  dark: "Dark",
  light: "Light",
  colorful: "Colorful",
  monochrome: "Monochrome",
};

export function generateDescription(
  username: string | null,
  model: "classic" | "slim",
  colorTags: { slug: string }[],
): string {
  const modelLabel = model === "slim" ? "slim-armed" : "classic";

  const primaryColors = colorTags
    .filter((t) => !DERIVED_SLUGS.has(t.slug))
    .map((t) => COLOR_ADJECTIVES[t.slug] ?? t.slug)
    .slice(0, 2);

  const derivedAdj = colorTags
    .filter((t) => DERIVED_SLUGS.has(t.slug))
    .map((t) => COLOR_ADJECTIVES[t.slug] ?? t.slug)[0];

  let desc = `A ${modelLabel} Minecraft skin`;

  if (username) {
    desc += ` for ${username}`;
  }

  if (primaryColors.length > 0) {
    const colorStr = primaryColors.join(" and ");
    desc += ` featuring a ${colorStr} design`;
  }

  if (derivedAdj) {
    desc += ` with a ${derivedAdj} aesthetic`;
  }

  desc += ".";
  return desc;
}

export function generateDisplayName(
  model: "classic" | "slim",
  colorTags: { slug: string }[],
  textureHash: string,
): string {
  const derivedTag = colorTags.find((t) => DERIVED_SLUGS.has(t.slug));
  const primaryTag = colorTags.find((t) => !DERIVED_SLUGS.has(t.slug));
  const label =
    DISPLAY_NAME_LABELS[derivedTag?.slug ?? primaryTag?.slug ?? ""] ??
    "Neutral";
  const modelLabel = model === "slim" ? "Slim" : "Classic";
  const suffix = textureHash.slice(0, 4);
  return `${label} ${modelLabel} #${suffix}`;
}
