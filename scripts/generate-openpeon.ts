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

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

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
  const categories: Record<string, Sound[]> = {};

  let categoryDirs: string[];
  try {
    categoryDirs = await readdir(soundsDir);
  } catch {
    return {};
  }

  for (const cat of categoryDirs) {
    const catPath = join(soundsDir, cat);
    let files: string[];
    try {
      files = (await readdir(catPath)).filter((f) => f.endsWith(".mp3"));
    } catch {
      continue;
    }

    if (files.length === 0) continue;

    const sounds: Sound[] = await Promise.all(
      files.sort().map(async (file) => {
        const parsed = parseFilename(file);
        const label = parsed ? buildLabel(parsed) : file.replace(/_mp3\.mp3$/, "");
        const absolutePath = join(catPath, file);
        const relativePath = relative(baseDir, absolutePath);
        const sha256 = await hashFile(absolutePath);
        return { file: relativePath, label, sha256 };
      })
    );

    categories[cat] = sounds;
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

  const totalSounds = Object.values(categories).reduce(
    (sum, sounds) => sum + sounds.length,
    0
  );

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
  console.log(`Total sounds: ${totalSounds}`);

  for (const [cat, sounds] of Object.entries(categories).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    console.log(`  ${cat}: ${sounds.length} sounds`);
  }
}

main();
