#!/usr/bin/env bun
/**
 * Generates openpeon.json from the audio files in a directory structure.
 *
 * Usage:
 *   bun generate-openpeon.ts <directory>
 *
 * The directory should contain either:
 *   - A "sounds/{category}/" structure (e.g., aoe4-french-imperial)
 *   - Flat .mp3 files (e.g., aoe4-french-voices)
 *
 * Label format example:
 *   French_villagerfemale_reacthelp_ihigh_chigh_01_alt01_mp3.mp3
 *   -> "Reacthelp 1.1 ♀️"
 */

import {
  readdir,
  readFile,
  writeFile,
  rename,
  rmdir,
  unlink,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const GENDER_EMOJI: Record<string, string> = {
  female: "♀️",
  male: "♂️",
};

interface Sound {
  file: string;
  label: string;
  sha256: string;
}

async function hashFile(filepath: string): Promise<string> {
  const content = await readFile(filepath);
  return createHash("sha256").update(content).digest("hex");
}

interface ParsedFilename {
  gender: string;
  action: string;
  intensity: string;
  number: string;
  alt: string | null;
}

function parseFilename(filename: string): ParsedFilename | null {
  // French_villagerfemale_reacthelp_ihigh_chigh_01_alt01_mp3.mp3
  // French_villagermale_selectgc_inorm_chigh_03_mp3.mp3
  const match = filename.match(
    /^French_villager(female|male)_([a-z]+)_(ihigh|inorm)_c(?:high|med|low)_(\d+)(?:_(alt\d+))?_mp3\.mp3$/i
  );

  if (!match) return null;

  return {
    gender: match[1],
    action: match[2],
    intensity: match[3],
    number: match[4],
    alt: match[5] ?? null,
  };
}

function buildLabel(parsed: ParsedFilename): string {
  const action =
    parsed.action.charAt(0).toUpperCase() + parsed.action.slice(1);
  const num = parseInt(parsed.number, 10);
  const genderEmoji = GENDER_EMOJI[parsed.gender] ?? "";

  let altSuffix = "";
  if (parsed.alt) {
    const altNum = parseInt(parsed.alt.replace("alt", ""), 10);
    altSuffix = `.${altNum}`;
  }

  return `${action} ${num}${altSuffix} ${genderEmoji}`.trim();
}

async function scanCategorized(
  baseDir: string
): Promise<Record<string, Sound[]>> {
  const soundsDir = join(baseDir, "sounds");
  const manifestPath = join(baseDir, "openpeon.json");

  // Step 1: Load existing category mappings from manifest (for previously flattened files)
  const categoryMapping = new Map<string, Set<string>>();
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    for (const [cat, catData] of Object.entries(manifest.categories ?? {})) {
      for (const sound of (catData as any).sounds ?? []) {
        const filename = (sound as Sound).file.split("/").pop()!;
        if (!categoryMapping.has(filename))
          categoryMapping.set(filename, new Set());
        categoryMapping.get(filename)!.add(cat);
      }
    }
  } catch {
    // No existing manifest
  }

  // Step 2: Flatten subdirectories into sounds/
  const entries = await readdir(soundsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const category = entry.name;
    const catPath = join(soundsDir, category);
    const files = (await readdir(catPath)).filter((f) => f.endsWith(".mp3"));

    for (const file of files) {
      const src = join(catPath, file);
      const dest = join(soundsDir, file);

      // Record category mapping
      if (!categoryMapping.has(file)) categoryMapping.set(file, new Set());
      categoryMapping.get(file)!.add(category);

      // Move to flat structure, or remove duplicate if already flat
      let destExists = false;
      try {
        await stat(dest);
        destExists = true;
      } catch {}

      if (destExists) {
        await unlink(src);
      } else {
        await rename(src, dest);
      }
    }

    // Remove empty directory
    try {
      await rmdir(catPath);
    } catch {}
  }

  // Step 3: Scan flat files and group by category
  const flatFiles = (await readdir(soundsDir))
    .filter((f) => f.endsWith(".mp3"))
    .sort();

  const categories: Record<string, Sound[]> = {};

  await Promise.all(
    flatFiles.map(async (file) => {
      const cats = categoryMapping.get(file);
      if (!cats || cats.size === 0) {
        console.warn(`  Warning: ${file} has no category mapping, skipping`);
        return;
      }

      const parsed = parseFilename(file);
      const label = parsed
        ? buildLabel(parsed)
        : file.replace(/_mp3\.mp3$/, "");
      const sha256 = await hashFile(join(soundsDir, file));

      for (const cat of cats) {
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push({ file: `sounds/${file}`, label, sha256 });
      }
    })
  );

  // Sort sounds within each category
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => a.file.localeCompare(b.file));
  }

  return categories;
}

async function scanFlat(baseDir: string): Promise<Record<string, Sound[]>> {
  const files = (await readdir(baseDir))
    .filter((f) => f.endsWith(".mp3"))
    .sort();

  const grouped: Record<string, Sound[]> = {};

  await Promise.all(
    files.map(async (file) => {
      const parsed = parseFilename(file);
      if (!parsed) return;

      const action = parsed.action;
      if (!grouped[action]) grouped[action] = [];

      const sha256 = await hashFile(join(baseDir, file));
      grouped[action].push({
        file: file,
        label: buildLabel(parsed),
        sha256,
      });
    })
  );

  return grouped;
}

async function main() {
  const targetDir = process.argv[2];
  if (!targetDir) {
    console.error("Usage: bun generate-openpeon.ts <directory>");
    process.exit(1);
  }

  const baseDir = join(process.cwd(), targetDir);
  const dirName = targetDir.replace(/\/$/, "");

  // Check if categorized (has sounds/ subdirectory) or flat
  let categories: Record<string, Sound[]>;
  try {
    await readdir(join(baseDir, "sounds"));
    console.log(`Scanning categorized structure: ${baseDir}/sounds/`);
    categories = await scanCategorized(baseDir);
  } catch {
    console.log(`Scanning flat directory: ${baseDir}/`);
    categories = await scanFlat(baseDir);
  }

  const totalRefs = Object.values(categories).reduce(
    (sum, sounds) => sum + sounds.length,
    0
  );
  const uniqueFiles = new Set(
    Object.values(categories).flatMap((sounds) => sounds.map((s) => s.file))
  ).size;

  const openpeon = {
    cesp_version: "1.0",
    name: dirName,
    display_name: `Age of Empires IV - French Villager Voices (${dirName})`,
    version: "1.0.0",
    description:
      "French villager voice lines from Age of Empires IV, extracted from the game files.",
    author: {
      name: "Guillaume et Louison",
      github: "ghusse",
    },
    language: "fr",
    categories: Object.fromEntries(
      Object.entries(categories)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, sounds]) => [cat, { sounds }])
    ),
  };

  const outputPath = join(baseDir, "openpeon.json");
  await writeFile(outputPath, JSON.stringify(openpeon, null, 2) + "\n");

  console.log(`\nGenerated: ${outputPath}`);
  console.log(`Categories: ${Object.keys(categories).length}`);
  console.log(`Unique files: ${uniqueFiles}`);
  console.log(`Total references: ${totalRefs} (across all categories)`);

  for (const [cat, sounds] of Object.entries(categories).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    console.log(`  ${cat}: ${sounds.length} sounds`);
  }
}

main();
