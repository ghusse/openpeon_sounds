#!/usr/bin/env bun
/**
 * Downloads all French villager dialogue audio files from the Age of Empires IV wiki.
 *
 * Usage:
 *   bun download-aoe4-french-voices.ts
 *
 * Features:
 *   - Parallel downloads (10 concurrent by default)
 *   - Retry on failure (up to 3 attempts)
 *   - Resume support: skips files already downloaded
 *   - Progress bar in terminal
 *
 * Output: Creates an "aoe4-french-voices/" folder with all MP3 files.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PAGE_URL = "https://ageofempires.fandom.com/wiki/Villager_(Age_of_Empires_IV)/French_dialogue_lines";
//const PAGE_URL = "https://ageofempires.fandom.com/wiki/Villager_(Age_of_Empires_IV)/French_dialogue_lines_2";

const AGE_SUFFIX = '_chigh'

const OUTPUT_DIR = join(import.meta.dir, "aoe4-french-voices");
const CONCURRENCY = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function extractAudioUrls(html: string): Promise<string[]> {
  const dataSrcRegex = /data-src="([^"]+\.mp3[^"]*)"/g;
  const audioSrcRegex = /<audio[^>]+src="([^"]+\.mp3[^"]*)"/g;

  const urls = new Set<string>();
  for (const match of html.matchAll(dataSrcRegex)) urls.add(match[1]);
  for (const match of html.matchAll(audioSrcRegex)) urls.add(match[1]);

  return [...urls].filter((url) => url.includes(AGE_SUFFIX));
}

function extractFilename(url: string): string {
  const match = url.match(/\/([^/]+_mp3\.mp3)\//i);
  if (match) return decodeURIComponent(match[1]);

  const pathParts = new URL(url).pathname.split("/");
  const mp3Part = pathParts.find((p) => p.endsWith(".mp3"));
  return mp3Part ? decodeURIComponent(mp3Part) : `audio_${Date.now()}.mp3`;
}

async function fileExists(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath);
  return await file.exists() && file.size > 0;
}

async function downloadFile(
  url: string,
  filepath: string,
  retries = MAX_RETRIES
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  // Skip if already downloaded (resume support)
  if (await fileExists(filepath)) {
    return { ok: true, skipped: true };
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: PAGE_URL,
        },
      });

      if (!res.ok) {
        if (attempt === retries)
          return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      await Bun.write(filepath, await res.arrayBuffer());
      return { ok: true };
    } catch (e) {
      if (attempt === retries) return { ok: false, error: String(e) };
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return { ok: false, error: "max retries exceeded" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with limited concurrency */
async function pooled<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`🏰 AoE4 French Villager Voice Downloader`);
  console.log(`Fetching page: ${PAGE_URL}\n`);

  const pageRes = await fetch(PAGE_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!pageRes.ok) {
    console.error(
      `Failed to fetch page: ${pageRes.status} ${pageRes.statusText}`
    );
    process.exit(1);
  }

  const html = await pageRes.text();
  console.log(`Page fetched (${(html.length / 1024).toFixed(0)} KB)`);

  const urls = await extractAudioUrls(html);
  console.log(`Found ${urls.length} unique audio URLs\n`);

  if (urls.length === 0) {
    console.error("No audio URLs found. The page structure may have changed.");
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failures: { filename: string; error: string }[] = [];
  const startTime = Date.now();

  await pooled(urls, CONCURRENCY, async (encodedURL, i) => {
    const url = encodedURL.replace('&#58;', ":");
    const filename = extractFilename(url);
    const filepath = join(OUTPUT_DIR, filename);

    const result = await downloadFile(url, filepath);

    if (result.ok) {
      if (result.skipped) {
        skipped++;
      } else {
        success++;
      }
    } else {
      console.error(url, result.error)
      failed++;
      failures.push({ filename, error: result.error ?? "unknown" });
    }

    const done = success + skipped + failed;
    const pct = ((done / urls.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(
      `\r[${pct}%] ${done}/${urls.length} (${success} new, ${skipped} skipped, ${failed} failed) — ${elapsed}s`
    );
  });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Done in ${totalTime}s!`);
  console.log(
    `   ${success} downloaded, ${skipped} skipped (already existed), ${failed} failed`
  );
  console.log(`   Files saved to: ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    console.log(`\n❌ Failed files:`);
    for (const f of failures) {
      console.log(`   ${f.filename}: ${f.error}`);
    }
  }
}

main();
