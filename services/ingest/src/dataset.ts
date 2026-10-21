/**
 * Writes generator output as one CSV per table plus manifest.json, and reads
 * the manifest back for the loader. Postgres CSV conventions: an unquoted empty
 * field is NULL, a quoted empty field ("") is the empty string.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GenerateOptions } from "./generator.ts";
import { GENERATOR_VERSION } from "./generator.ts";
import { TABLE_SPECS, type Tables } from "./tables.ts";

export interface Manifest {
  generator_version: number;
  seed: number;
  people: number;
  dob_rate: number;
  /** SHA-256 over the sorted "<sha256>  <file>" lines of every CSV. */
  sha256: string;
  files: Record<string, { rows: number; sha256: string }>;
}

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text === "" || /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: readonly object[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    lines.push(columns.map((c) => csvField(r[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

export const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Serializes every table; returns file path → content, in TABLE_SPECS order. */
export function serialize(tables: Tables): Map<string, string> {
  const files = new Map<string, string>();
  for (const spec of TABLE_SPECS) {
    files.set(spec.file, toCsv(spec.columns, tables[spec.key] as readonly object[]));
  }
  return files;
}

export function buildManifest(
  opts: GenerateOptions,
  tables: Tables,
  files: Map<string, string>,
): Manifest {
  const entries: Manifest["files"] = {};
  for (const spec of TABLE_SPECS) {
    entries[spec.file] = { rows: tables[spec.key].length, sha256: sha256(files.get(spec.file)!) };
  }
  return {
    generator_version: GENERATOR_VERSION,
    seed: opts.seed,
    people: opts.people,
    dob_rate: opts.dobRate,
    sha256: combinedHash(entries),
    files: entries,
  };
}

export function combinedHash(files: Manifest["files"]): string {
  const lines = Object.keys(files)
    .sort()
    .map((f) => `${files[f]!.sha256}  ${f}\n`);
  return sha256(lines.join(""));
}

/** Replaces `dir` with the dataset. */
export function writeDataset(dir: string, files: Map<string, string>, manifest: Manifest): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [file, content] of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** Reads manifest.json and checks every file against its recorded hash. */
export function readManifest(dir: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  for (const [file, entry] of Object.entries(manifest.files)) {
    const actual = sha256(readFileSync(join(dir, file)));
    if (actual !== entry.sha256) {
      throw new Error(`${file}: sha256 ${actual} does not match manifest ${entry.sha256}`);
    }
  }
  if (combinedHash(manifest.files) !== manifest.sha256) {
    throw new Error("manifest sha256 does not match its files");
  }
  return manifest;
}
